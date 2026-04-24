import { EventEmitter } from 'node:events';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import type { AgentAdapter, Session, SessionOptions } from '../../src/core/interfaces.js';
import type { SessionState } from '../../src/core/types.js';

let tempHome: string;
let projectDir: string;
let originalHome: string | undefined;

async function setup(): Promise<Daemon> {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-home-'));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-project-'));
  originalHome = process.env['HOME'];
  process.env['HOME'] = tempHome;

  const daemon = new Daemon();
  await daemon.initialize();
  await daemon.directoryManager.register(projectDir);
  return daemon;
}

async function cleanup(): Promise<void> {
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  await fs.rm(tempHome, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
}

describe('workflow runner', () => {
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
    expect(runs.map((item) => item.id)).toContain(run.id);
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
      initiation: 'browser',
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.sourceType).toBe('viewport_snapshot');
    expect(completed?.sourcePath).toBe('viewport://templates/snapshot-proof');
    expect(completed?.nodes.proof?.output).toBe('snapshot');
  });

  it('keeps a prompt node running until the launched agent session ends', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-proof
requires:
  agents:
    - claude
nodes:
  review:
    type: prompt
    agent: claude
    prompt: Review the current directory.
`,
      'utf-8',
    );

    const directoryId = DirectoryManager.idFromPath(projectDir);
    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId,
      initiation: 'cli',
    });

    await waitForNodeSession(daemon, run.id, 'review');
    const running = await daemon.workflowRunner.getRun(run.id);
    expect(running?.status).toBe('running');
    expect(running?.nodes.review?.sessionId).toBeTruthy();

    adapter.lastSession?.simulateEnd('completed');
    await waitForTerminalRun(daemon, run.id);

    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.review?.status).toBe('completed');
    expect(completed?.events.map((event) => event.type)).toContain('session-ended');
  });

  it('blocks runs when preflight finds unsupported executable nodes', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: blocked-proof
nodes:
  gate:
    type: approval
    prompt: Approve
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
    expect(blocked?.preflight.issues[0]?.kind).toBe('node');
  });

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
});

class MockSession extends EventEmitter implements Session {
  readonly id = crypto.randomUUID();
  state: SessionState = 'running';

  sendPrompt = vi.fn().mockResolvedValue(undefined);
  kill = vi.fn().mockImplementation(async () => {
    this.simulateEnd('killed');
  });

  simulateEnd(reason: string): void {
    this.state = 'completed';
    this.emit('ended', reason);
  }
}

class MockAdapter implements AgentAdapter {
  readonly agentId = 'claude';
  lastSession: MockSession | null = null;

  async startSession(_cwd: string, _options?: SessionOptions): Promise<Session> {
    this.lastSession = new MockSession();
    return this.lastSession;
  }

  async resumeSession(
    _sessionId: string,
    _cwd: string,
    _options?: SessionOptions,
  ): Promise<Session> {
    this.lastSession = new MockSession();
    return this.lastSession;
  }
}

async function waitForTerminalRun(daemon: Daemon, runId: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    const run = await daemon.workflowRunner.getRun(runId);
    if (run && ['completed', 'failed', 'blocked', 'canceled'].includes(run.status)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for workflow run ${runId}`);
}

async function waitForNodeSession(daemon: Daemon, runId: string, nodeId: string): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    const run = await daemon.workflowRunner.getRun(runId);
    if (run?.nodes[nodeId]?.sessionId) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for workflow node session ${nodeId}`);
}
