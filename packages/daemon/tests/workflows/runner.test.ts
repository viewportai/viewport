import { EventEmitter } from 'node:events';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import { HookRouter } from '../../src/hooks/router.js';
import { SupervisionManager } from '../../src/hooks/supervision.js';
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

  it('fans out inline agents and feeds their outputs to the supervisor prompt', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: inline-agent-proof
requires:
  agents:
    - claude
nodes:
  supervisor:
    type: prompt
    agent: claude
    prompt: Synthesize the child agent findings.
    agents:
      reviewer:
        title: Reviewer
        prompt: Review the current diff.
      tester:
        title: Tester
        prompt: Suggest tests.
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForRunState(daemon, run.id, (state) => {
      const agents = state.nodes.supervisor?.inlineAgents;
      return Boolean(agents?.reviewer?.sessionId && agents.tester?.sessionId);
    });
    const reviewer = await waitForSessionWithPrompt(adapter, 'Review the current diff.');
    const tester = await waitForSessionWithPrompt(adapter, 'Suggest tests.');
    reviewer.emitAgentMessage('reviewer output');
    tester.emitAgentMessage('tester output');
    reviewer.simulateIdle();
    tester.simulateIdle();

    const supervisor = await waitForSupervisorSession(daemon, run.id, adapter);
    expect(supervisor.sendPrompt).toHaveBeenCalledWith(
      expect.stringContaining('Viewport inline agent results:'),
    );
    expect(supervisor.sendPrompt).toHaveBeenCalledWith(expect.stringContaining('reviewer output'));
    expect(supervisor.sendPrompt).toHaveBeenCalledWith(expect.stringContaining('tester output'));
    supervisor.emitAgentMessage('supervisor summary');
    supervisor.simulateIdle();

    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.nodes.supervisor?.output).toBe('supervisor summary');
    expect(completed?.nodes.supervisor?.inlineAgents?.reviewer).toMatchObject({
      status: 'completed',
      output: 'reviewer output',
    });
    expect(completed?.nodes.supervisor?.inlineAgents?.tester).toMatchObject({
      status: 'completed',
      output: 'tester output',
    });
    expect(completed?.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'inline-agent-started',
        'inline-agent-completed',
        'session-started',
        'node-output',
      ]),
    );
  }, 10_000);

  it('can continue a supervisor prompt with partial inline agent failures', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: inline-agent-partial-proof
requires:
  agents:
    - claude
nodes:
  supervisor:
    type: prompt
    agent: claude
    inlineAgentFailurePolicy: continue
    prompt: Synthesize the child agent findings.
    agents:
      reviewer:
        title: Reviewer
        prompt: Review the current diff.
      tester:
        title: Tester
        prompt: Suggest tests.
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    const reviewer = await waitForSessionWithPrompt(adapter, 'Review the current diff.');
    const tester = await waitForSessionWithPrompt(adapter, 'Suggest tests.');
    reviewer.emitAgentMessage('reviewer output');
    reviewer.simulateIdle();
    tester.simulateEnd('failed');

    const supervisor = await waitForSupervisorSession(daemon, run.id, adapter);
    expect(supervisor.sendPrompt).toHaveBeenCalledWith(expect.stringContaining('reviewer output'));
    expect(supervisor.sendPrompt).toHaveBeenCalledWith(expect.stringContaining('Status: failed'));
    supervisor.emitAgentMessage('partial supervisor summary');
    supervisor.simulateIdle();

    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.supervisor?.inlineAgents?.tester).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('failed'),
    });
    expect(completed?.nodes.supervisor?.output).toBe('partial supervisor summary');
  }, 10_000);

  it('records workflow-scoped tool hooks from a running prompt session', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const hookRouter = new HookRouter(daemon, new SupervisionManager());
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: hook-runtime-proof
nodes:
  review:
    type: prompt
    agent: claude
    prompt: Review the diff.
    hooks:
      PreToolUse:
        record: true
      PostToolUse:
        record: true
      PostToolUseFailure:
        record: true
      PermissionRequest:
        tools:
          Bash:
            behavior: deny
            message: Bash commands are disabled for this workflow.
        default:
          behavior: allow
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });
    const session = await waitForSessionWithPrompt(adapter, 'Review the diff.');

    await hookRouter.handleEvent({
      hook_event_name: 'PreToolUse',
      session_id: session.id,
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
    });
    await hookRouter.handleEvent({
      hook_event_name: 'PostToolUse',
      session_id: session.id,
      tool_name: 'Read',
      tool_response: 'ok',
    });
    await hookRouter.handleEvent({
      hook_event_name: 'PostToolUseFailure',
      session_id: session.id,
      tool_name: 'Bash',
      error: 'command failed',
    });
    const denied = await hookRouter.handleEvent({
      hook_event_name: 'PermissionRequest',
      session_id: session.id,
      tool_name: 'Bash',
      tool_input: { command: 'git reset --hard' },
    });

    expect(denied).toEqual({
      passthrough: false,
      decision: {
        behavior: 'deny',
        message: 'Bash commands are disabled for this workflow.',
      },
    });

    session.emitAgentMessage('hook proof output');
    session.simulateIdle();

    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'hook-fired', nodeId: 'review' }),
        expect.objectContaining({
          type: 'hook-fired',
          nodeId: 'review',
          data: expect.objectContaining({ kind: 'PostToolUse' }),
        }),
        expect.objectContaining({
          type: 'hook-fired',
          nodeId: 'review',
          data: expect.objectContaining({
            kind: 'PermissionRequest',
            response: expect.objectContaining({
              decision: expect.objectContaining({ behavior: 'deny' }),
            }),
          }),
        }),
      ]),
    );
    expect(completed?.nodes.review?.output).toBe('hook proof output');
  }, 10_000);

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
    captureResponse: true
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

    const blocked = await waitForRunState(
      daemon,
      run.id,
      (candidate) =>
        candidate.status === 'blocked' &&
        candidate.nodes.inspect?.status === 'completed' &&
        candidate.nodes.gate?.status === 'blocked',
    );

    expect(blocked?.status).toBe('blocked');
    expect(blocked?.nodes.inspect?.status).toBe('completed');
    expect(blocked?.nodes.gate?.status).toBe('blocked');
    expect(blocked?.nodes.gate?.approval?.prompt).toBe('Approve ready');
    expect(blocked?.nodes.after?.status).toBe('queued');

    await daemon.workflowRunner.decideApproval(run.id, 'gate', {
      approved: true,
      message: 'Approved by test',
      actor: {
        id: '42',
        name: 'Test User',
        email: 'test@example.test',
        source: 'unit-test',
      },
    });
    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.gate?.output).toBe('Approved by test');
    expect(completed?.nodes.gate?.approval?.actor).toEqual({
      id: '42',
      name: 'Test User',
      email: 'test@example.test',
      source: 'unit-test',
    });
    expect(completed?.nodes.after?.output).toBe('Approved by test after');
    expect(completed?.events.map((event) => event.type)).toContain('approval-requested');
    expect(completed?.events.map((event) => event.type)).toContain('approval-resolved');
  });

  it('keeps the approver message off the node output unless captureResponse is set', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: approval-default-output
nodes:
  gate:
    type: approval
    prompt: Approve this run.
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
      (candidate) => candidate.nodes.gate?.status === 'blocked',
    );

    await daemon.workflowRunner.decideApproval(run.id, 'gate', {
      approved: true,
      message: 'Confidential reviewer note — should not leak into output',
    });
    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    // Default behavior: output is the constant 'Approved' string. The message
    // is preserved on the audit record so reviewers can still inspect it.
    expect(completed?.nodes.gate?.output).toBe('Approved');
    expect(completed?.nodes.gate?.approval?.message).toContain('Confidential');
  });

  it('runs the approval onReject command on denial and exposes the rejection message', async () => {
    const daemon = await setup();
    const markerFile = path.join(projectDir, 'rejection-marker.txt');
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: approval-on-reject-proof
nodes:
  gate:
    type: approval
    prompt: Approve the deploy.
    onReject:
      command: 'printf %s "$VIEWPORT_REJECT_MESSAGE" > ${markerFile}'
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
      (candidate) => candidate.nodes.gate?.status === 'blocked',
    );

    await daemon.workflowRunner.decideApproval(run.id, 'gate', {
      approved: false,
      message: 'Reverted: shipped without integration test',
    });

    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('canceled');
    // The follow-up shell wrote the rejection message into the marker file.
    expect(await fs.readFile(markerFile, 'utf-8')).toBe(
      'Reverted: shipped without integration test',
    );
    const rejectLogs = (completed?.events ?? []).filter(
      (event) => event.type === 'node-log' && event.message.toLowerCase().includes('onreject'),
    );
    expect(rejectLogs.length).toBeGreaterThan(0);
  });

  it('runs the approval onReject prompt on denial and records the follow-up session', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: approval-on-reject-prompt-proof
nodes:
  gate:
    type: approval
    prompt: Ship?
    onReject:
      prompt: 'Write a rejection summary for: {{ nodes.gate.approval.message }}'
      agent: claude
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
      (candidate) => candidate.nodes.gate?.status === 'blocked',
    );

    const decision = daemon.workflowRunner.decideApproval(run.id, 'gate', {
      approved: false,
      message: 'missing tests',
    });
    const followUp = await waitForAdapterSessionCount(adapter, 1);
    expect(followUp.sendPrompt).toHaveBeenCalledWith(
      'Write a rejection summary for: missing tests',
    );
    followUp.emitAgentMessage('Rejected because tests are missing.');
    followUp.simulateIdle();
    await decision;

    const canceled = await daemon.workflowRunner.getRun(run.id);
    expect(canceled?.status).toBe('canceled');
    expect(canceled?.nodes.gate?.status).toBe('failed');
    expect(canceled?.nodes.gate?.sessionId).toBeTruthy();
    expect(canceled?.nodes.gate?.output).toBe('Rejected because tests are missing.');
    expect(canceled?.events).toContainEqual(
      expect.objectContaining({
        type: 'node-output',
        nodeId: 'gate',
        data: { output: 'Rejected because tests are missing.' },
      }),
    );
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

  it('runs deterministic check, policy, and elapsed schedule gates', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: deterministic-gates-proof
nodes:
  check_context:
    type: gate
    gate:
      type: check
      expression: "true"
  policy_gate:
    type: gate
    needs: [check_context]
    gate:
      type: policy
      expression: "pass"
  timed_gate:
    type: gate
    needs: [policy_gate]
    gate:
      type: schedule
      waitUntil: "2000-01-01T00:00:00.000Z"
  after:
    type: shell
    needs: [timed_gate]
    command: printf "{{ nodes.check_context.output }} / {{ nodes.policy_gate.output }}"
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.check_context?.output).toBe('true');
    expect(completed?.nodes.policy_gate?.output).toBe('pass');
    expect(completed?.nodes.timed_gate?.output).toContain('Schedule reached');
    expect(completed?.nodes.after?.output).toBe('true / pass');
    expect(completed?.events.map((event) => event.type)).toContain('gate-passed');
  });

  it('fails deterministic gates when the expression is false', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: failed-gate-proof
nodes:
  check_context:
    type: gate
    gate:
      type: check
      expression: "false"
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
    expect(failed?.nodes.check_context?.status).toBe('failed');
    expect(failed?.error).toMatch(/check gate check_context failed/);
  });

  it('pauses at human review gates and resumes after approval', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: human-review-gate-proof
nodes:
  gate:
    type: gate
    gate:
      type: human_review
      prompt: Approve the rollout.
  after:
    type: shell
    needs: [gate]
    command: printf "{{ nodes.gate.output }}"
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    const blocked = await waitForRunState(
      daemon,
      run.id,
      (candidate) => candidate.status === 'blocked' && candidate.nodes.gate?.status === 'blocked',
    );

    expect(blocked.nodes.gate?.approval?.prompt).toBe('Approve the rollout.');
    expect(blocked.events.map((event) => event.type)).toContain('gate-blocked');

    await daemon.workflowRunner.decideApproval(run.id, 'gate', {
      approved: true,
      message: 'Human reviewed',
    });
    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.gate?.output).toBe('Human reviewed');
    expect(completed?.nodes.after?.output).toBe('Human reviewed');
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

  it('iterates a foreach loop over an upstream JSON array and aggregates per-iteration output', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: loop-foreach-proof
nodes:
  list:
    type: shell
    command: echo '["alpha","beta","gamma"]'
    outputs:
      items:
        type: json
  process:
    type: loop
    needs: [list]
    foreach: nodes.list.outputs.items
    maxIterations: 5
    body:
      type: shell
      command: 'printf %s {{ loop.item }}'
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
    const node = completed?.nodes.process;
    expect(node?.status).toBe('completed');
    expect(node?.iterations).toHaveLength(3);
    expect(node?.iterations?.map((iter) => iter.output)).toEqual(['alpha', 'beta', 'gamma']);
    expect(node?.iterations?.map((iter) => iter.item)).toEqual(['alpha', 'beta', 'gamma']);
    const events = completed?.events ?? [];
    expect(events.filter((event) => event.type === 'loop-iteration-started')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'loop-iteration-completed')).toHaveLength(3);
  });

  it('iterates a foreach loop with prompt bodies and records per-iteration sessions', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: loop-prompt-proof
nodes:
  list:
    type: shell
    command: echo '["alpha","beta"]'
    outputs:
      items:
        type: json
  process:
    type: loop
    needs: [list]
    foreach: nodes.list.outputs.items
    maxIterations: 5
    body:
      type: prompt
      agent: claude
      prompt: 'Review {{ loop.item }} at index {{ loop.index }}'
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    const first = await waitForAdapterSessionCount(adapter, 1);
    expect(first.sendPrompt).toHaveBeenCalledWith('Review alpha at index 0');
    first.emitAgentMessage('alpha done');
    first.simulateIdle();

    const second = await waitForAdapterSessionCount(adapter, 2);
    expect(second.sendPrompt).toHaveBeenCalledWith('Review beta at index 1');
    second.emitAgentMessage('beta done');
    second.simulateIdle();

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);
    const node = completed?.nodes.process;

    expect(completed?.status).toBe('completed');
    expect(node?.iterations?.map((iter) => iter.output)).toEqual(['alpha done', 'beta done']);
    expect(node?.iterations?.every((iter) => Boolean(iter.sessionId))).toBe(true);
    expect(node?.output).toBe(JSON.stringify(['alpha done', 'beta done']));
  });

  it('runs a while loop until its condition turns falsy and respects maxIterations', async () => {
    const daemon = await setup();
    const counterFile = path.join(projectDir, 'counter.txt');
    await fs.writeFile(counterFile, '0', 'utf-8');
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: loop-while-proof
nodes:
  bump:
    type: loop
    while: 'loop.index < 4'
    maxIterations: 10
    body:
      type: shell
      command: 'printf %s {{ loop.index }}'
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
    expect(completed?.nodes.bump?.iterations?.map((iter) => iter.output)).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
  });

  it('retries a transient shell failure and succeeds on a later attempt', async () => {
    const daemon = await setup();
    const counterFile = path.join(projectDir, 'attempts.txt');
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    // Body: increment counter, fail with "rate limit" while the counter is
    // below 3, then printf "ok". Combined with retry.transient=['rate limit']
    // and maxAttempts=5 the runner should hit success on the third try.
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: retry-transient-proof
nodes:
  flaky:
    type: shell
    command: |
      attempts=$(cat ${counterFile} 2>/dev/null || echo 0)
      attempts=$((attempts+1))
      printf %s "$attempts" > ${counterFile}
      if [ "$attempts" -lt 3 ]; then
        echo "rate limit reached" >&2
        exit 1
      fi
      printf ok
    retry:
      maxAttempts: 5
      transient:
        - rate limit
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
    expect(completed?.nodes.flaky?.status).toBe('completed');
    expect(completed?.nodes.flaky?.output).toBe('ok');
    const retries = (completed?.events ?? []).filter((event) => event.type === 'node-retry');
    expect(retries).toHaveLength(2);
    expect(await fs.readFile(counterFile, 'utf-8')).toBe('3');
  });

  it('fails fast on a fatal classifier match without burning the retry budget', async () => {
    const daemon = await setup();
    const counterFile = path.join(projectDir, 'fatal-attempts.txt');
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: retry-fatal-proof
nodes:
  busted:
    type: shell
    command: |
      attempts=$(cat ${counterFile} 2>/dev/null || echo 0)
      attempts=$((attempts+1))
      printf %s "$attempts" > ${counterFile}
      echo "permission denied" >&2
      exit 1
    retry:
      maxAttempts: 5
      fatal:
        - permission denied
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

    expect(completed?.status).toBe('failed');
    expect(completed?.nodes.busted?.status).toBe('failed');
    expect(completed?.nodes.busted?.attempts).toBe(1);
    const retries = (completed?.events ?? []).filter((event) => event.type === 'node-retry');
    expect(retries).toHaveLength(0);
    expect(await fs.readFile(counterFile, 'utf-8')).toBe('1');
  });

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

  it('resumes a workflow run that was mid-flight when the daemon restarted', async () => {
    // Simulates a crash by hand-writing a run record that looks mid-flight
    // (status running, node 'one' status running) then calling
    // resumePendingRuns. We bypass startRun() so there's no in-flight
    // executor racing with the resume — that mirrors the real boot path
    // where the daemon process just started and nothing else is running.
    const daemon = await setup();
    const yaml = `
schema: viewport.workflow/v1
name: resume-proof
nodes:
  one:
    type: shell
    command: 'printf one'
  two:
    type: shell
    needs: [one]
    command: 'printf two'
`;
    const runId = crypto.randomUUID();
    const directoryId = DirectoryManager.idFromPath(projectDir);
    const runsDir = path.join(tempHome, '.viewport', 'runs', 'workflows');
    await fs.mkdir(runsDir, { recursive: true });
    const now = Date.now();
    const record = {
      id: runId,
      workflowName: 'resume-proof',
      sourceType: 'viewport_snapshot',
      sourcePath: 'viewport://test-resume',
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
        one: { id: 'one', type: 'shell', status: 'running' },
        two: { id: 'two', type: 'shell', status: 'queued' },
      },
      artifacts: [],
      events: [],
      createdAt: now - 10_000,
      updatedAt: now - 5_000,
    };
    await fs.writeFile(path.join(runsDir, `${runId}.json`), JSON.stringify(record), 'utf-8');

    const result = await daemon.workflowRunner.resumePendingRuns();
    expect(result.resumed).toBeGreaterThan(0);

    await waitForTerminalRun(daemon, runId);
    const completed = await daemon.workflowRunner.getRun(runId);
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.one?.output).toBe('one');
    expect(completed?.nodes.two?.output).toBe('two');
    const events = completed?.events.map((event) => event.message) ?? [];
    expect(events.some((message) => message.includes('resumed'))).toBe(true);
  });

  it('falls through a failed sibling when a downstream node uses triggerRule one_success', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: trigger-rule-proof
nodes:
  unstable:
    type: shell
    command: 'exit 7'
    policy:
      onFailure: continue
  reliable:
    type: shell
    command: 'printf reliable'
    outputs:
      mark:
        type: string
  notify:
    type: shell
    needs: [unstable, reliable]
    triggerRule: one_success
    command: 'printf notify-{{ nodes.reliable.outputs.mark }}'
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
    expect(completed?.nodes.unstable?.status).toBe('failed');
    expect(completed?.nodes.reliable?.status).toBe('completed');
    expect(completed?.nodes.notify?.status).toBe('completed');
    expect(completed?.nodes.notify?.output).toBe('notify-reliable');
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
  readonly sessions: MockSession[] = [];

  async startSession(_cwd: string, _options?: SessionOptions): Promise<Session> {
    this.lastSession = new MockSession();
    this.sessions.push(this.lastSession);
    return this.lastSession;
  }

  async resumeSession(
    _sessionId: string,
    _cwd: string,
    _options?: SessionOptions,
  ): Promise<Session> {
    this.lastSession = new MockSession();
    this.sessions.push(this.lastSession);
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

async function waitForRunState(
  daemon: Daemon,
  runId: string,
  predicate: (run: NonNullable<Awaited<ReturnType<Daemon['workflowRunner']['getRun']>>>) => boolean,
): Promise<NonNullable<Awaited<ReturnType<Daemon['workflowRunner']['getRun']>>>> {
  for (let index = 0; index < 200; index += 1) {
    const run = await daemon.workflowRunner.getRun(runId);
    if (run && predicate(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for workflow run ${runId} to match expected state`);
}

async function waitForNodeSession(daemon: Daemon, runId: string, nodeId: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    const run = await daemon.workflowRunner.getRun(runId);
    if (run?.nodes[nodeId]?.sessionId) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for workflow node session ${nodeId}`);
}

async function waitForAdapterSessionCount(
  adapter: MockAdapter,
  count: number,
): Promise<MockSession> {
  for (let index = 0; index < 100; index += 1) {
    const session = adapter.sessions[count - 1];
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for adapter session ${count}`);
}

async function waitForSupervisorSession(
  daemon: Daemon,
  runId: string,
  adapter: MockAdapter,
): Promise<MockSession> {
  for (let index = 0; index < 100; index += 1) {
    const session = findSessionWithPrompt(adapter, 'Synthesize the child agent findings.');
    if (session) return session;
    const run = await daemon.workflowRunner.getRun(runId);
    if (run && ['failed', 'canceled', 'completed', 'blocked'].includes(run.status)) {
      throw new Error(
        `Workflow ended before supervisor session: ${run.status} ${run.error ?? ''} ${JSON.stringify(run.nodes.supervisor)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for supervisor session`);
}

async function waitForSessionWithPrompt(
  adapter: MockAdapter,
  promptFragment: string,
): Promise<MockSession> {
  for (let index = 0; index < 40; index += 1) {
    const session = findSessionWithPrompt(adapter, promptFragment);
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for session prompt containing ${promptFragment}`);
}

function findSessionWithPrompt(adapter: MockAdapter, promptFragment: string): MockSession | null {
  return (
    adapter.sessions.find((session) =>
      session.sendPrompt.mock.calls.some(([prompt]) => String(prompt).includes(promptFragment)),
    ) ?? null
  );
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
