import { EventEmitter } from 'node:events';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import type {
  AgentAdapter,
  DiscoveredSession,
  RunTracker,
  Session,
  SessionOptions,
} from '../../src/core/interfaces.js';
import type { SessionState, Step } from '../../src/core/types.js';

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
    expect(completed?.nodes.proof?.exitCode).toBe(0);
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'node-output',
        nodeId: 'proof',
        data: { output: 'ok', exitCode: 0 },
      }),
    );
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
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-transcript-proof
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
    await writeCodexTranscript(projectDir, 'Recovered transcript output');
    adapter.lastSession?.simulateIdle();
    await waitForTerminalRun(daemon, run.id);

    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.review?.output).toBe('Recovered transcript output');
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
    expect(worktreePath).toContain(path.join('.viewport', 'worktrees'));
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

  it('pauses at approval gates and resumes after approval', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: approval-proof
nodes:
  inspect:
    type: shell
    command: printf "ready"
  gate:
    type: approval
    needs: [inspect]
    prompt: Approve {{ nodes.inspect.output }}
  after:
    type: shell
    needs: [gate]
    command: printf "{{ nodes.gate.output }} after"
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
    expect(blocked?.nodes.inspect?.status).toBe('completed');
    expect(blocked?.nodes.gate?.status).toBe('blocked');
    expect(blocked?.nodes.gate?.approval?.prompt).toBe('Approve ready');
    expect(blocked?.nodes.after?.status).toBe('queued');

    await daemon.workflowRunner.decideApproval(run.id, 'gate', {
      approved: true,
      message: 'Approved by test',
    });
    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.gate?.output).toBe('Approved by test');
    expect(completed?.nodes.after?.output).toBe('Approved by test after');
    expect(completed?.events.map((event) => event.type)).toContain('approval-requested');
    expect(completed?.events.map((event) => event.type)).toContain('approval-resolved');
  });

  it('cancels approval-gated workflows when approval is denied', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: approval-deny-proof
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
    await daemon.workflowRunner.decideApproval(run.id, 'gate', {
      approved: false,
      message: 'No',
    });
    const canceled = await daemon.workflowRunner.getRun(run.id);

    expect(canceled?.status).toBe('canceled');
    expect(canceled?.nodes.gate?.status).toBe('failed');
    expect(canceled?.error).toBe('No');
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

  simulateIdle(): void {
    this.state = 'idle';
    this.emit('state-change', 'idle');
  }

  emitAgentMessage(text: string, messageId = crypto.randomUUID()): void {
    this.emit('message', {
      type: 'agent_message',
      messageId,
      text,
      timestamp: Date.now(),
    });
  }

  emitAgentMessageChunk(messageId: string, text: string): void {
    this.emit('message', {
      type: 'agent_message_chunk',
      messageId,
      text,
      timestamp: Date.now(),
    });
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

class PathDiscovery {
  readonly agentId: string;
  private readonly sessionsByPath = new Map<string, DiscoveredSession[]>();

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  setProjectSessions(projectPath: string, sessions: DiscoveredSession[]): void {
    this.sessionsByPath.set(path.resolve(projectPath), sessions);
  }

  async discoverSessions(projectPath: string): Promise<DiscoveredSession[]> {
    return this.sessionsByPath.get(path.resolve(projectPath)) ?? [];
  }
}

class WorktreeTracker implements RunTracker {
  readonly steps: ReadonlyArray<Step> = [];
  onStepCommitted?: (step: Step) => void;

  constructor(private readonly worktreePath: string) {}

  async setup(_sessionId: string, _projectPath: string): Promise<string> {
    await fs.mkdir(this.worktreePath, { recursive: true });
    return this.worktreePath;
  }

  onMessage(): void {}
  async flushPendingCommits(): Promise<void> {}
  async teardown(): Promise<void> {}
  async rollback(_toSha: string): Promise<void> {}
  async branchRetry(_fromSha: string): Promise<string> {
    return this.worktreePath;
  }
  async squashMerge(_targetBranch: string, _commitMessage: string): Promise<void> {}
  async getDiff(_sha: string): Promise<string> {
    return '';
  }
  async getStepDiffs(): Promise<Array<{ step: number; sha: string; diff: string }>> {
    return [];
  }
  async getSummaryDiff(): Promise<string> {
    return '';
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

async function waitForCompletedRun(daemon: Daemon, runId: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    const run = await daemon.workflowRunner.getRun(runId);
    if (run?.status === 'completed') return;
    if (run && ['failed', 'canceled'].includes(run.status)) {
      throw new Error(`Workflow run ${runId} ended as ${run.status}: ${run.error ?? ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for completed workflow run ${runId}`);
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

async function writeCodexTranscript(cwd: string, output: string): Promise<void> {
  const root = path.join(process.env['CODEX_HOME'] ?? tempHome, 'sessions', '2026', '04', '24');
  await fs.mkdir(root, { recursive: true });
  const filePath = path.join(root, `${crypto.randomUUID()}.jsonl`);
  const timestamp = new Date().toISOString();
  const lines = [
    {
      timestamp,
      type: 'session_meta',
      payload: {
        id: crypto.randomUUID(),
        cwd,
      },
    },
    {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: output }],
      },
    },
  ];
  await fs.writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}
