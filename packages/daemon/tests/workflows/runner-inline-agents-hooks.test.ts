import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import { HookRouter } from '../../src/hooks/router.js';
import { SupervisionManager } from '../../src/hooks/supervision.js';
import {
  MockAdapter,
  waitForCompletedRun,
  waitForRunState,
  waitForSessionWithPrompt,
  waitForSupervisorSession,
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

describe('workflow runner inline agents and hooks', () => {
  beforeEach(async () => {});
  afterEach(cleanup);
  it('cancels running inline agent sessions before the supervisor prompt starts', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: inline-agent-cancel-proof
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

    const canceled = await daemon.workflowRunner.cancelRun(run.id, {
      message: 'User stopped inline agents',
    });

    expect(reviewer.kill).toHaveBeenCalled();
    expect(tester.kill).toHaveBeenCalled();
    expect(canceled.status).toBe('canceled');
    expect(canceled.nodes.supervisor?.status).toBe('canceled');
    expect(canceled.nodes.supervisor?.inlineAgents?.reviewer?.status).toBe('canceled');
    expect(canceled.nodes.supervisor?.inlineAgents?.tester?.status).toBe('canceled');

    await new Promise((resolve) => setTimeout(resolve, 50));
    const saved = await daemon.workflowRunner.getRun(run.id);
    expect(saved?.status).toBe('canceled');
    expect(saved?.nodes.supervisor?.inlineAgents?.reviewer?.status).toBe('canceled');
    expect(saved?.nodes.supervisor?.inlineAgents?.tester?.status).toBe('canceled');
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
});
