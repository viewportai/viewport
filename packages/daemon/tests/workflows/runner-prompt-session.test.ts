import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import {
  MockAdapter,
  waitForNodeSession,
  waitForSessionWithPrompt,
  waitForTerminalRun,
} from './support/workflow-runner-support.js';

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

describe('workflow runner prompt sessions', () => {
  beforeEach(async () => {});
  afterEach(cleanup);

  it('cancels a running workflow prompt and preserves canceled state after the session ends', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: cancel-running-prompt-proof
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

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForNodeSession(daemon, run.id, 'review');
    const running = await daemon.workflowRunner.getRun(run.id);
    const session = adapter.lastSession;

    expect(session).toBeTruthy();
    expect(running?.status).toBe('running');
    expect(running?.nodes.review?.status).toBe('running');

    const canceled = await daemon.workflowRunner.cancelRun(run.id, {
      message: 'User stopped the workflow',
    });

    expect(session?.kill).toHaveBeenCalled();
    expect(canceled.status).toBe('canceled');
    expect(canceled.nodes.review?.status).toBe('canceled');
    expect(canceled.events).toContainEqual(
      expect.objectContaining({
        type: 'run-canceled',
        message: 'User stopped the workflow',
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    const saved = await daemon.workflowRunner.getRun(run.id);
    expect(saved?.status).toBe('canceled');
    expect(saved?.nodes.review?.status).toBe('canceled');
  });

  it('completes a prompt node when the launched agent session becomes idle', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-idle-proof
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

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForNodeSession(daemon, run.id, 'review');
    adapter.lastSession?.emitAgentMessage('done');
    adapter.lastSession?.simulateIdle();
    await waitForTerminalRun(daemon, run.id);

    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.review?.status).toBe('completed');
    expect(completed?.nodes.review?.output).toBe('done');
    expect(completed?.events.map((event) => event.type)).toContain('session-idle');
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'node-output',
        nodeId: 'review',
        data: { output: 'done' },
      }),
    );
  });

  it('fails and kills a prompt node when its timeout expires', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-timeout-proof
nodes:
  review:
    type: prompt
    agent: claude
    timeoutSeconds: 1
    prompt: Wait forever.
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });
    const session = await waitForSessionWithPrompt(adapter, 'Wait forever.');

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(session.kill).toHaveBeenCalled();
    expect(completed?.status).toBe('failed');
    expect(completed?.nodes.review?.status).toBe('failed');
    expect(completed?.nodes.review?.error).toContain('timed out after 1s');
  }, 10_000);

  it('does not relaunch a running prompt node that already has a session id on boot resume', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const yaml = `
schema: viewport.workflow/v1
name: prompt-resume-proof
requires:
  agents:
    - claude
nodes:
  review:
    type: prompt
    agent: claude
    prompt: Review the current diff.
`;
    const runId = crypto.randomUUID();
    const directoryId = DirectoryManager.idFromPath(projectDir);
    const runsDir = path.join(tempHome, '.viewport', 'runs', 'workflows');
    await fs.mkdir(runsDir, { recursive: true });
    const now = Date.now();
    const record = {
      id: runId,
      workflowName: 'prompt-resume-proof',
      sourceType: 'viewport_snapshot',
      sourcePath: 'viewport://test-prompt-resume',
      digest: 'test-digest',
      schema: 'viewport.workflow/v1',
      yamlSnapshot: yaml,
      directoryId,
      directoryPath: projectDir,
      machineId: daemon.configManager.getMachineId(),
      initiation: 'cli',
      status: 'running',
      inputs: {},
      preflight: { ok: true, issues: [] },
      nodes: {
        review: {
          id: 'review',
          type: 'prompt',
          status: 'running',
          sessionId: 'existing-prompt-session',
        },
      },
      artifacts: [],
      events: [],
      createdAt: now - 10_000,
      updatedAt: now - 5_000,
    };
    await fs.writeFile(path.join(runsDir, `${runId}.json`), JSON.stringify(record), 'utf-8');

    const result = await daemon.workflowRunner.resumePendingRuns();

    expect(result.resumed).toBeGreaterThan(0);
    expect(adapter.sessions).toHaveLength(0);
    const paused = await daemon.workflowRunner.getRun(runId);
    expect(paused?.status).toBe('running');
    expect(paused?.nodes.review?.status).toBe('running');
    expect(paused?.nodes.review?.sessionId).toBe('existing-prompt-session');
    expect(paused?.events.some((event) => event.type === 'run-resume-paused')).toBe(true);
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
});
