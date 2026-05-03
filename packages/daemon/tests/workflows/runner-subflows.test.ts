import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import { waitForRunState, waitForTerminalRun } from './support/workflow-runner-support.js';

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

describe('workflow runner subflows', () => {
  beforeEach(async () => {});
  afterEach(cleanup);

  it('runs an inline subflow with two child shells in topological order and aggregates outputs', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: subflow-proof
inputs:
  greeting:
    type: string
    default: hello
nodes:
  validate:
    type: subflow
    inputs:
      label: inputs.greeting
    inline:
      nodes:
        first:
          type: shell
          command: 'printf %s {{ inputs.label }}'
        second:
          type: shell
          needs: [first]
          command: 'printf %s "{{ nodes.first.output }}-then"'
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      inputs: { greeting: 'subbie' },
    });
    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.validate?.status).toBe('completed');
    const aggregated = JSON.parse(completed?.nodes.validate?.output ?? '{}');
    expect(aggregated.first).toBe('subbie');
    expect(aggregated.second).toBe('subbie-then');
    const events = completed?.events ?? [];
    expect(events.filter((event) => event.type === 'subflow-child-started')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'subflow-child-completed')).toHaveLength(2);
  });

  it('cancels a running subflow shell child and preserves canceled parent state', async () => {
    const daemon = await setup();
    const markerFile = path.join(projectDir, 'subflow-marker.txt');
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: subflow-cancel-proof
nodes:
  validate:
    type: subflow
    inline:
      nodes:
        slow:
          type: shell
          command: 'sleep 10 && printf done > ${markerFile}'
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForRunState(daemon, run.id, (state) =>
      state.events.some((event) => event.type === 'subflow-child-started'),
    );
    const canceled = await daemon.workflowRunner.cancelRun(run.id, {
      message: 'User stopped subflow',
    });

    expect(canceled.status).toBe('canceled');
    expect(canceled.nodes.validate?.status).toBe('canceled');

    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(fs.readFile(markerFile, 'utf-8')).rejects.toThrow();
    const saved = await daemon.workflowRunner.getRun(run.id);
    expect(saved?.status).toBe('canceled');
    expect(saved?.nodes.validate?.status).toBe('canceled');
  });
});
