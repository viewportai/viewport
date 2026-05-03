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

describe('workflow runner shell execution', () => {
  beforeEach(async () => {});
  afterEach(cleanup);
  it('runs a shell workflow and persists run history', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-proof
nodes:
  proof:
    type: shell
    command: printf "ok"
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
    const runs = await daemon.workflowRunner.listRuns();

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.proof?.output).toBe('ok');
    expect(completed?.nodes.proof?.exitCode).toBe(0);
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'node-log',
        nodeId: 'proof',
        data: expect.objectContaining({ source: 'stdout', chunk: 'ok' }),
      }),
    );
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'node-output',
        nodeId: 'proof',
        data: { output: 'ok', exitCode: 0 },
      }),
    );
    expect(runs.map((item) => item.id)).toContain(run.id);
  });

  it('cancels a running shell workflow and preserves canceled state', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-cancel-proof
nodes:
  slow:
    type: shell
    command: sleep 10 && printf done
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForRunState(
      daemon,
      run.id,
      (candidate) => candidate.nodes.slow?.status === 'running',
    );
    const canceled = await daemon.workflowRunner.cancelRun(run.id, {
      message: 'User stopped shell run',
    });
    expect(canceled.status).toBe('canceled');
    expect(canceled.nodes.slow?.status).toBe('canceled');

    await new Promise((resolve) => setTimeout(resolve, 100));
    const saved = await daemon.workflowRunner.getRun(run.id);
    expect(saved?.status).toBe('canceled');
    expect(saved?.nodes.slow?.status).toBe('canceled');
    expect(saved?.nodes.slow?.output).not.toBe('done');
  });

  it('collects declared shell artifacts inside the workflow directory', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: artifact-proof
nodes:
  report:
    type: shell
    command: mkdir -p artifacts && printf "ready" > artifacts/report.txt
    artifacts:
      report:
        path: artifacts/report.txt
        type: report
        description: Review report
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
    expect(completed?.artifacts).toContainEqual(
      expect.objectContaining({
        nodeId: 'report',
        name: 'report',
        kind: 'report',
        path: path.join(projectDir, 'artifacts/report.txt'),
        description: 'Review report',
        metadata: expect.objectContaining({
          declaredPath: 'artifacts/report.txt',
          digest: expect.stringMatching(/^sha256:/),
        }),
      }),
    );
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'artifact-collected',
        nodeId: 'report',
      }),
    );
  });

  it('runs a browser-provided workflow snapshot without requiring a local workflow file', async () => {
    const daemon = await setup();
    const directoryId = DirectoryManager.idFromPath(projectDir);

    const run = await daemon.workflowRunner.startRun({
      workflowYaml: `
schema: viewport.workflow/v1
name: viewport/snapshot-proof
title: Snapshot Proof
nodes:
  proof:
    type: shell
    command: printf "snapshot"
`,
      workflowSourceRef: 'viewport://templates/snapshot-proof',
      directoryId,
      executionPolicy: { mode: 'isolated_worktree' },
      initiation: 'browser',
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.sourceType).toBe('viewport_snapshot');
    expect(completed?.sourcePath).toBe('viewport://templates/snapshot-proof');
    expect(completed?.executionPolicy).toEqual({ mode: 'isolated_worktree' });
    expect(completed?.events.some((event) => event.type === 'execution-policy-selected')).toBe(
      true,
    );
    expect(completed?.nodes.proof?.output).toBe('snapshot');
  });

  it('passes shell output into downstream templates', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: dataflow-proof
nodes:
  first:
    type: shell
    command: printf "upstream"
  second:
    type: shell
    needs: [first]
    command: printf "{{ nodes.first.output }}-downstream"
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
    expect(completed?.nodes.second?.output).toBe('upstream-downstream');
  });
});
