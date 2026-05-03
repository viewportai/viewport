import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import { waitForTerminalRun } from './support/workflow-runner-support.js';

let tempHome: string;
let projectDir: string;
let originalHome: string | undefined;
let originalCodexHome: string | undefined;

async function setup(): Promise<Daemon> {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-home-'));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-project-'));
  originalHome = process.env['HOME'];
  originalCodexHome = process.env['CODEX_HOME'];
  process.env['HOME'] = tempHome;
  process.env['CODEX_HOME'] = path.join(tempHome, '.codex');

  const daemon = new Daemon();
  await daemon.initialize();
  await daemon.directoryManager.register(projectDir);
  return daemon;
}

async function cleanup(): Promise<void> {
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
  else process.env['CODEX_HOME'] = originalCodexHome;
  await fs.rm(tempHome, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
}

describe('workflow runner shell execution', () => {
  beforeEach(async () => {});
  afterEach(cleanup);
  it('marks shell node failures on the run record', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: failure-proof
nodes:
  fail:
    type: shell
    command: exit 7
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.fail?.status).toBe('failed');
    expect(failed?.nodes.fail?.exitCode).toBe(7);
    expect(failed?.error).toMatch(/code 7/);
  });

  it('blocks git workflows before shell execution when the target directory is not a git worktree', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: git-proof
requires:
  tools:
    - git
nodes:
  inspect:
    type: shell
    command: git status --short
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForTerminalRun(daemon, run.id);
    const blocked = await daemon.workflowRunner.getRun(run.id);

    expect(blocked?.status).toBe('blocked');
    expect(blocked?.nodes.inspect?.status).toBe('queued');
    expect(blocked?.preflight.issues[0]?.message).toMatch(/not a git repository/);
  });

  it('rejects required inputs before queuing a run', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: input-proof
inputs:
  ticket:
    type: string
    required: true
nodes:
  proof:
    type: shell
    command: echo ok
`,
      'utf-8',
    );

    await expect(
      daemon.workflowRunner.startRun({
        workflowPath,
        directoryId: DirectoryManager.idFromPath(projectDir),
        initiation: 'cli',
      }),
    ).rejects.toThrow(/Missing required workflow input/);
  });

  it('resolves declared json input defaults into templates', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: json-input-proof
inputs:
  integration_event:
    type: json
    default:
      provider: github
      payload:
        number: 42
nodes:
  proof:
    type: shell
    command: printf '%s:%s' '{{ inputs.integration_event.provider }}' '{{ inputs.integration_event.payload.number }}'
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.inputs.integration_event).toMatchObject({
      provider: 'github',
      payload: { number: 42 },
    });
    expect(completed?.nodes.proof?.output).toBe('github:42');
  });

  it('runs sibling shell nodes concurrently in the same DAG layer', async () => {
    // Two siblings each sleep before writing a marker. The assertion below
    // proves their execution windows overlap, which is stronger and less
    // load-sensitive than a wall-clock threshold.
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: parallel-proof
nodes:
  left:
    type: shell
    command: 'sleep 0.25 && printf left'
    outputs:
      mark:
        type: string
  right:
    type: shell
    command: 'sleep 0.25 && printf right'
    outputs:
      mark:
        type: string
  join:
    type: shell
    needs: [left, right]
    command: 'printf {{ nodes.left.outputs.mark }}-{{ nodes.right.outputs.mark }}'
`,
      'utf-8',
    );

    const directoryId = DirectoryManager.idFromPath(projectDir);
    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId,
      initiation: 'cli',
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.left?.status).toBe('completed');
    expect(completed?.nodes.right?.status).toBe('completed');
    expect(completed?.nodes.join?.output).toBe('left-right');
    const left = completed?.nodes.left;
    const right = completed?.nodes.right;
    expect(left?.startedAt).toBeTypeOf('number');
    expect(left?.completedAt).toBeTypeOf('number');
    expect(right?.startedAt).toBeTypeOf('number');
    expect(right?.completedAt).toBeTypeOf('number');
    expect(left!.startedAt!).toBeLessThan(right!.completedAt!);
    expect(right!.startedAt!).toBeLessThan(left!.completedAt!);
  });
});
