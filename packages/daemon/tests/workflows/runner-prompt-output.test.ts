import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import { WorkflowRunReconciler } from '../../src/workflows/runner-reconciler.js';
import type { WorkflowRunRecord } from '../../src/workflows/types.js';
import {
  MockAdapter,
  PathDiscovery,
  WorktreeTracker,
  waitForNodeSession,
  waitForTerminalRun,
  writeCodexTranscript,
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

describe('workflow runner prompt output capture', () => {
  beforeEach(async () => {});
  afterEach(cleanup);
  it('stores streamed prompt output once when the adapter emits chunks and a final message', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-stream-proof
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
    const messageId = crypto.randomUUID();
    adapter.lastSession?.emitAgentMessageChunk(messageId, 'Hello ');
    adapter.lastSession?.emitAgentMessageChunk(messageId, 'world');
    adapter.lastSession?.emitAgentMessage('Hello world', messageId);
    adapter.lastSession?.simulateIdle();
    await waitForTerminalRun(daemon, run.id);

    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.review?.output).toBe('Hello world');
  });

  it('recovers missing prompt output from the agent transcript', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter({ agentId: 'codex' });
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-transcript-proof
requires:
  agents:
    - codex
nodes:
  review:
    type: prompt
    agent: codex
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
    await writeCodexTranscript(projectDir, 'Recovered transcript output');
    adapter.lastSession?.simulateIdle();
    await waitForTerminalRun(daemon, run.id);

    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.review?.output).toBe('Recovered transcript output');
  });

  it('recovers prompt transcript excerpts when a session finishes while the runner is offline', async () => {
    await setup();
    const sessionId = crypto.randomUUID();
    await writeCodexTranscript(projectDir, 'Recovered offline transcript output');

    const now = Date.now();
    const run: WorkflowRunRecord = {
      id: crypto.randomUUID(),
      workflowName: 'offline-transcript-proof',
      sourceType: 'local_file',
      sourcePath: path.join(projectDir, 'workflow.yaml'),
      digest: 'digest',
      schema: 'viewport.workflow/v1',
      yamlSnapshot: 'schema: viewport.workflow/v1\nname: offline-transcript-proof\nnodes: {}\n',
      directoryId: DirectoryManager.idFromPath(projectDir),
      directoryPath: projectDir,
      machineId: 'local',
      initiation: 'cli',
      status: 'running',
      inputs: {},
      preflight: { ok: true, issues: [] },
      nodes: {
        review: {
          id: 'review',
          type: 'prompt',
          status: 'running',
          sessionId,
          metadata: { agent: 'codex' },
          startedAt: now - 1000,
        },
      },
      artifacts: [],
      events: [],
      createdAt: now - 1000,
      updatedAt: now - 1000,
    };
    const saveAndEmit = vi.fn().mockResolvedValue(undefined);
    const daemonWithIdleSession = {
      getSessionInfo: () => ({ state: 'idle' }),
    } as unknown as Daemon;
    const reconciler = new WorkflowRunReconciler(daemonWithIdleSession, new Set(), saveAndEmit);

    const reconciled = await reconciler.reconcile(run);

    expect(reconciled.status).toBe('completed');
    expect(reconciled.nodes.review?.status).toBe('completed');
    expect(reconciled.nodes.review?.output).toBe('Recovered offline transcript output');
    expect(reconciled.nodes.review?.transcriptExcerpt).toEqual([
      { role: 'assistant', text: 'Recovered offline transcript output' },
    ]);
    expect(reconciled.events).toContainEqual(
      expect.objectContaining({
        type: 'node-output',
        nodeId: 'review',
        data: expect.objectContaining({
          output: 'Recovered offline transcript output',
          transcriptExcerpt: [{ role: 'assistant', text: 'Recovered offline transcript output' }],
        }),
      }),
    );
    expect(saveAndEmit).toHaveBeenCalledOnce();
  });

  it('reconciles workflow worktree sessions back to the parent directory during discovery', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    const discovery = new PathDiscovery('claude');
    daemon.registerAdapter(adapter);
    daemon.registerDiscovery(discovery);
    daemon.setTrackerFactory(
      (_config, sessionId) =>
        new WorktreeTracker(path.join(projectDir, '.viewport', 'worktrees', sessionId)),
    );
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-worktree-discovery-proof
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
    const sessionId = running?.nodes.review?.sessionId;
    const worktreePath = running?.nodes.review?.worktreePath;
    expect(sessionId).toBeTruthy();
    expect(worktreePath).toContain(path.join('.viewport', 'node-sessions', run.id, 'review'));
    expect(adapter.lastSession?.id).not.toBe(sessionId);

    discovery.setProjectSessions(worktreePath!, [
      {
        agentId: 'claude',
        sessionId: adapter.lastSession!.id,
        summary: 'Workflow child session',
        lastModified: Date.now(),
        cwd: worktreePath,
        resumable: true,
        messageCount: 3,
      },
    ]);
    adapter.lastSession?.simulateEnd('completed');
    await waitForTerminalRun(daemon, run.id);

    await daemon.runDiscovery();
    const discovered = daemon.getDiscoveredSessions(directoryId).get(directoryId) ?? [];
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      sessionId: adapter.lastSession!.id,
      summary: 'Workflow child session',
      workflowRunId: run.id,
      workflowNodeId: 'review',
      parentDirectoryId: directoryId,
      parentDirectoryPath: projectDir,
      worktreePath,
    });
  });
});
