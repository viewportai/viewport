import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import { PtyAdapter } from '../../src/adapters/pty.js';
import { addContextEntry, initContextResource } from '../../src/context/local-edge-store.js';
import { buildSessionPromptWithContext } from '../../src/core/session-context-prompt.js';
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
let originalViewportHome: string | undefined;

async function setup(): Promise<Daemon> {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-home-'));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-project-'));
  originalHome = process.env['HOME'];
  originalCodexHome = process.env['CODEX_HOME'];
  originalViewportHome = process.env['VIEWPORT_HOME'];
  process.env['HOME'] = tempHome;
  process.env['CODEX_HOME'] = path.join(tempHome, '.codex');
  process.env['VIEWPORT_HOME'] = path.join(tempHome, '.viewport');

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
  if (originalViewportHome === undefined) delete process.env['VIEWPORT_HOME'];
  else process.env['VIEWPORT_HOME'] = originalViewportHome;
  await fs.rm(tempHome, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
}

async function waitForAdapterSessions(adapter: MockAdapter, count: number): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (adapter.sessions.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} adapter session(s)`);
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
    expect(adapter.lastOptions?.config?.executionMode).toBe('implement');
    expect(adapter.lastOptions?.config?.allowedTools).toBeUndefined();
    adapter.lastSession?.emitToolCall('tool-1', 'Read');
    adapter.lastSession?.emitToolCallUpdate('tool-1', 'Read', 'completed');
    adapter.lastSession?.emitTokenUsage(42, 12, 0.0042);
    adapter.lastSession?.emitAgentMessage('done');
    adapter.lastSession?.simulateIdle();
    await waitForTerminalRun(daemon, run.id);

    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.review?.status).toBe('completed');
    expect(completed?.nodes.review?.output).toBe('done');
    expect(completed?.nodes.review?.metadata?.['usage']).toMatchObject({
      available: true,
      inputTokens: 42,
      outputTokens: 12,
      totalTokens: 54,
      totalCostUsd: 0.0042,
    });
    expect(completed?.nodes.review?.metadata?.['agentRun']).toMatchObject({
      schema: 'viewport.agent_run_result/v1',
      agentId: 'claude',
      adapterVersion: 'test',
      executionMode: 'implement',
      stopReason: 'idle',
      output: 'done',
    });
    expect(completed?.nodes.review?.metadata?.['executionPolicy']).toMatchObject({
      executionMode: 'implement',
      timeoutSeconds: 1800,
      executionModeDefaulted: true,
      timeoutDefaulted: true,
    });
    expect(completed?.nodes.review?.metadata?.['toolCalls']).toEqual([
      expect.objectContaining({
        id: 'tool-1',
        name: 'Read',
        status: 'completed',
      }),
    ]);
    expect(completed?.events.map((event) => event.type)).toContain('session-idle');
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'node-output',
        nodeId: 'review',
        data: { output: 'done' },
      }),
    );
  });

  it('persists the detailed adapter error reason when a prompt session fails', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-error-detail-proof
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
    if (!adapter.lastSession) throw new Error('Expected prompt session to launch');
    adapter.lastSession.state = 'errored';
    adapter.lastSession.emit('state-change', 'errored');
    adapter.lastSession.emit('ended', 'error: codex quota exhausted');
    await waitForTerminalRun(daemon, run.id);

    const failed = await daemon.workflowRunner.getRun(run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.review?.status).toBe('failed');
    expect(failed?.nodes.review?.error).toContain('codex quota exhausted');
    expect(failed?.events).toContainEqual(
      expect.objectContaining({
        type: 'session-ended',
        data: expect.objectContaining({ reason: 'error: codex quota exhausted' }),
      }),
    );
  });

  it('passes prompt execution mode and allowed tools into the launched agent session', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-execution-mode-session-proof
requires:
  agents:
    - claude
nodes:
  inspect:
    type: prompt
    agent: claude
    executionMode: read_only
    allowedTools:
      - Read
      - Grep
    prompt: Inspect without changing files.
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForNodeSession(daemon, run.id, 'inspect');
    expect(adapter.lastOptions?.config?.executionMode).toBe('read_only');
    expect(adapter.lastOptions?.config?.allowedTools).toEqual(['Read', 'Grep']);
    expect(adapter.lastOptions?.allowedTools).toEqual(['Read', 'Grep']);

    adapter.lastSession?.emitAgentMessage('done');
    adapter.lastSession?.simulateIdle();
    await waitForTerminalRun(daemon, run.id);
  });

  it('conservatively bounds inline agents that do not declare execution mode', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: inline-agent-mode-proof
requires:
  agents:
    - claude
nodes:
  implement:
    type: prompt
    agent: claude
    executionMode: implement
    prompt: Use the inline reviewer before implementation.
    agents:
      reviewer:
        title: Reviewer
        prompt: Review the implementation approach.
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForAdapterSessions(adapter, 1);
    expect(adapter.sessions).toHaveLength(1);
    expect(adapter.lastOptions?.config?.executionMode).toBe('review');

    adapter.lastSession?.emitAgentMessage('Looks safe.');
    adapter.lastSession?.simulateIdle();

    await waitForNodeSession(daemon, run.id, 'implement');
    expect(adapter.sessions).toHaveLength(2);
    expect(adapter.lastOptions?.config?.executionMode).toBe('implement');

    adapter.lastSession?.emitAgentMessage('done');
    adapter.lastSession?.simulateIdle();
    await waitForTerminalRun(daemon, run.id);

    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.implement?.inlineAgents?.reviewer).toMatchObject({
      status: 'completed',
      executionMode: 'review',
    });
    expect(
      completed?.nodes.implement?.inlineAgents?.reviewer?.metadata?.['executionPolicy'],
    ).toMatchObject({
      executionMode: 'review',
      timeoutSeconds: 900,
      timeoutDefaulted: true,
    });
  });

  it('fails prompt nodes that emit malformed required structured outputs', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: required-output-denial-proof
requires:
  agents:
    - claude
nodes:
  plan:
    type: prompt
    agent: claude
    executionMode: plan
    outputSchema:
      plan:
        type: json
        requirement: required
    prompt: Return the plan as JSON.
  after:
    type: shell
    needs: [plan]
    command: printf should-not-run
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForNodeSession(daemon, run.id, 'plan');
    adapter.lastSession?.emitAgentMessage('not json {lol}');
    adapter.lastSession?.simulateIdle();
    await waitForTerminalRun(daemon, run.id);

    const failed = await daemon.workflowRunner.getRun(run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.plan?.status).toBe('failed');
    expect(failed?.nodes.plan?.error).toContain('Required structured output plan is invalid');
    expect(failed?.nodes.after?.status).toBe('queued');
    expect(failed?.nodes.plan?.metadata?.['structuredOutputs']).toMatchObject({
      outputs: {
        plan: {
          requirement: 'required',
          status: 'invalid',
          reason: 'malformed_json',
        },
      },
    });
  });

  it('fails prompt nodes that exceed workflow budget before downstream side effects run', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-budget-denial-proof
requires:
  agents:
    - claude
policies:
  budget:
    maxTokens: 50
    maxCostUsd: 0.01
nodes:
  plan:
    type: prompt
    agent: claude
    executionMode: plan
    prompt: Stay inside the budget.
  after:
    type: shell
    needs: [plan]
    command: printf should-not-run
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForNodeSession(daemon, run.id, 'plan');
    expect(adapter.lastOptions?.config?.maxBudgetUsd).toBe(0.01);
    adapter.lastSession?.emitTokenUsage(45, 10, 0.012);
    adapter.lastSession?.emitAgentMessage('expensive plan');
    adapter.lastSession?.simulateIdle();
    await waitForTerminalRun(daemon, run.id);

    const failed = await daemon.workflowRunner.getRun(run.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.plan?.status).toBe('failed');
    expect(failed?.nodes.plan?.error).toContain('budget_exceeded');
    expect(failed?.nodes.plan?.metadata?.['agentRun']).toMatchObject({
      stopReason: 'budget_exceeded',
    });
    expect(failed?.nodes.plan?.metadata?.['executionPolicy']).toMatchObject({
      budget: {
        maxTokens: 50,
        maxCostUsd: 0.01,
      },
      budgetEvaluation: {
        exceeded: true,
      },
    });
    expect(failed?.nodes.after?.status).toBe('queued');
    expect(failed?.events).toContainEqual(
      expect.objectContaining({
        type: 'budget-exceeded',
        nodeId: 'plan',
      }),
    );
  });

  it('does not count cache-read input tokens against workflow token budget', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-cache-budget-proof
requires:
  agents:
    - claude
policies:
  budget:
    maxTokens: 10000
nodes:
  plan:
    type: prompt
    agent: claude
    executionMode: plan
    prompt: Reuse cached context without exhausting budget.
  after:
    type: shell
    needs: [plan]
    command: printf ok
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForNodeSession(daemon, run.id, 'plan');
    adapter.lastSession?.emitTokenUsage(560_000, 4_000, undefined, {
      cacheReadInputTokens: 556_000,
      billableInputTokens: 4_000,
      budgetedTotalTokens: 8_000,
    });
    adapter.lastSession?.emitAgentMessage('cached plan');
    adapter.lastSession?.simulateIdle();
    await waitForTerminalRun(daemon, run.id);

    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.plan?.status).toBe('completed');
    expect(completed?.nodes.plan?.metadata?.['usage']).toMatchObject({
      inputTokens: 560_000,
      outputTokens: 4_000,
      totalTokens: 564_000,
      cacheReadInputTokens: 556_000,
      billableInputTokens: 4_000,
      budgetedTotalTokens: 8_000,
    });
    expect(completed?.nodes.plan?.metadata?.['executionPolicy']).toMatchObject({
      budgetEvaluation: {
        exceeded: false,
        usage: {
          totalTokens: 564_000,
          budgetedTotalTokens: 8_000,
        },
      },
    });
    expect(completed?.events).not.toContainEqual(
      expect.objectContaining({
        type: 'budget-exceeded',
      }),
    );
  });

  it('captures valid plan output schema before downstream nodes run', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: plan-output-schema-proof
requires:
  agents:
    - claude
nodes:
  plan:
    type: prompt
    agent: claude
    executionMode: plan
    outputSchema:
      plan:
        type: json
        requirement: required
        extract: json.plan
    prompt: Return the plan as JSON.
  summarize:
    type: shell
    needs: [plan]
    command: printf "{{ nodes.plan.outputs.plan.title }}"
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForNodeSession(daemon, run.id, 'plan');
    adapter.lastSession?.emitAgentMessage('{"plan":{"title":"Ship bounded planning"}}');
    adapter.lastSession?.simulateIdle();
    await waitForTerminalRun(daemon, run.id);

    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.plan?.outputs?.plan).toEqual({ title: 'Ship bounded planning' });
    expect(completed?.nodes.plan?.metadata?.['structuredOutputs']).toMatchObject({
      outputs: {
        plan: {
          requirement: 'required',
          status: 'captured',
        },
      },
    });
    expect(completed?.nodes.summarize?.output).toBe('Ship bounded planning');
  });

  it('fails before launching when an adapter cannot enforce read-only mode', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter({
      capabilities: {
        executionModes: {
          plan: 'unsupported',
          read_only: 'unsupported',
          review: 'prompt_only',
          implement: 'prompt_only',
        },
      },
    });
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-capability-denial-proof
requires:
  agents:
    - claude
nodes:
  inspect:
    type: prompt
    agent: claude
    executionMode: read_only
    prompt: Inspect without changing files.
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
    expect(adapter.sessions).toHaveLength(0);
    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.inspect?.status).toBe('failed');
    expect(failed?.nodes.inspect?.error).toContain('cannot enforce read_only execution mode');
  });

  it('fails before launching when an adapter cannot enforce an explicit tool allowlist', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter({
      capabilities: {
        toolAllowlist: 'unsupported',
      },
    });
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-tool-allowlist-denial-proof
requires:
  agents:
    - claude
nodes:
  inspect:
    type: prompt
    agent: claude
    executionMode: implement
    allowedTools:
      - Read
    prompt: Use only the configured tool.
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
    expect(adapter.sessions).toHaveLength(0);
    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.inspect?.status).toBe('failed');
    expect(failed?.nodes.inspect?.error).toContain('cannot enforce workflow tool allowlists');
  });

  it('runs prompt nodes without explicit cwd in an isolated read-only node directory', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    await fs.mkdir(path.join(projectDir, '.viewport', 'checkouts', 'old-run'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectDir, '.viewport', 'checkouts', 'old-run', 'leak.txt'),
      'old checkout should not be visible to planning nodes',
      'utf-8',
    );
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-isolation-proof
requires:
  agents:
    - claude
nodes:
  draft_plan:
    type: prompt
    agent: claude
    prompt: Draft a plan from injected context only.
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForNodeSession(daemon, run.id, 'draft_plan');
    const cwd = adapter.lastSession ? adapter.cwdBySession.get(adapter.lastSession) : undefined;

    expect(cwd).toBeTruthy();
    expect(cwd).not.toBe(projectDir);
    expect(cwd).toContain(path.join('.viewport', 'node-sessions', run.id, 'draft_plan'));
    await expect(fs.access(path.join(cwd!, 'leak.txt'))).rejects.toThrow();

    adapter.lastSession?.emitAgentMessage('done');
    adapter.lastSession?.simulateIdle();
    await waitForTerminalRun(daemon, run.id);
  });

  it('runs a deterministic custom command agent through the daemon workflow runner', async () => {
    const daemon = await setup();
    const script = [
      "process.stdin.once('data', (chunk) => {",
      "  const prompt = chunk.toString('utf8').trim();",
      "  console.log(`CUSTOM_AGENT_EVIDENCE:${prompt.includes('PAY-1842') ? 'PAY-1842' : 'missing'}`);",
      '  process.exit(0);',
      '});',
    ].join('\n');
    daemon.registerAdapter(
      new PtyAdapter('custom-command', process.execPath, {
        defaultArgs: ['-e', script],
        promptMode: 'stdin',
      }),
    );

    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: custom-command-agent-proof
requires:
  agents:
    - custom-command
nodes:
  investigate:
    type: agent
    agent: custom-command
    prompt: Investigate PAY-1842 and emit evidence.
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
    expect(completed?.nodes.investigate?.status).toBe('completed');
    expect(completed?.nodes.investigate?.output).toContain('CUSTOM_AGENT_EVIDENCE:PAY-1842');
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'session-started',
        nodeId: 'investigate',
      }),
    );
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'node-output',
        nodeId: 'investigate',
        data: expect.objectContaining({
          output: expect.stringContaining('CUSTOM_AGENT_EVIDENCE:PAY-1842'),
        }),
      }),
    );
  });

  it('keeps repo-configured Context Vault entries out of workflow prompt sessions unless selected by node context', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);

    await fs.mkdir(path.join(projectDir, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, '.viewport', 'config.json'),
      JSON.stringify(
        {
          version: 1,
          resources: {
            contexts: ['ctx-workflow-launch'],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const credentials = { passphrase: 'alice-passphrase', recoveryCode: 'alice-recovery' };
    await initContextResource({
      contextResourceId: 'ctx-workflow-launch',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
    });
    await addContextEntry({
      contextResourceId: 'ctx-workflow-launch',
      actorName: 'alice-laptop',
      title: 'Workflow launch context',
      body: 'Workflow prompt nodes must receive resource manifest context.',
      credentials,
    });
    await expect(
      buildSessionPromptWithContext({
        workingDirectory: projectDir,
        prompt: 'Review workflow context for the current directory.',
      }),
    ).resolves.toContain('<viewport_context>');

    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-context-proof
requires:
  agents:
    - claude
nodes:
  review:
    type: prompt
    agent: claude
    prompt: Review workflow context for the current directory.
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForNodeSession(daemon, run.id, 'review');
    const session = await waitForSessionWithPrompt(
      adapter,
      'Review workflow context for the current directory.',
    );
    const sentPrompt = String(session.sendPrompt.mock.calls.at(-1)?.[0] ?? '');
    expect(sentPrompt).not.toContain('<viewport_context>');
    expect(sentPrompt).not.toContain(
      'Workflow prompt nodes must receive resource manifest context.',
    );
    expect(sentPrompt).toContain('Review workflow context for the current directory.');

    session.emitAgentMessage('context used');
    session.simulateIdle();
    await waitForTerminalRun(daemon, run.id);

    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.review?.output).toBe('context used');
    expect(completed?.resourceManifest?.resources.contexts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'ctx-workflow-launch' })]),
    );
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'context-manifest-resolved',
        data: expect.objectContaining({
          manifestDigest: completed?.resourceManifest?.manifestDigest,
          configSourceCount: 1,
        }),
      }),
    );
  });

  it('injects repo-docs provider context into workflow prompt sessions and records provenance', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);

    await fs.mkdir(path.join(projectDir, '.viewport'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'docs'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'docs', 'review.md'),
      'Run the local reviewer before touching billing code.',
      'utf8',
    );
    await fs.writeFile(
      path.join(projectDir, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: repo_docs',
        '      provider: repo-docs',
        '      paths:',
        '        - docs/**/*.md',
        '',
      ].join('\n'),
      'utf8',
    );

    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: prompt-repo-docs-proof
context:
  - source: repo_docs
    as: billing-runbook
    max_items: 1
requires:
  agents:
    - claude
nodes:
  review:
    type: prompt
    agent: claude
    prompt: Review billing changes.
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForNodeSession(daemon, run.id, 'review');
    const session = await waitForSessionWithPrompt(adapter, 'Review billing changes.');
    const sentPrompt = String(session.sendPrompt.mock.calls.at(-1)?.[0] ?? '');
    expect(sentPrompt).toContain('<viewport_context>');
    expect(sentPrompt).toContain('## [context-1] billing-runbook (repo-docs)');
    expect(sentPrompt).toContain('Title: docs/review.md');
    expect(sentPrompt).toContain('Run the local reviewer before touching billing code.');

    session.emitAgentMessage('repo docs used');
    session.simulateIdle();
    await waitForTerminalRun(daemon, run.id);

    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.resourceManifest?.contract.contextProviders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'repo_docs',
          provider: 'repo-docs',
          privacy: 'local_only',
        }),
      ]),
    );
    expect(completed?.contextReceipts).toEqual([
      expect.objectContaining({
        provider: 'repo-docs',
        requested: 'repo_docs',
        usedBy: expect.objectContaining({
          nodeId: 'review',
          providerId: 'repo_docs',
          alias: 'billing-runbook',
        }),
      }),
    ]);
    expect(completed?.nodes.review?.outputs?.context_basis).toMatchObject({
      schema: 'viewport.node_context_basis/v1',
      nodeId: 'review',
      mode: 'workflow_default',
      selectedItems: [
        expect.objectContaining({
          provider_id: 'repo_docs',
          alias: 'billing-runbook',
          title: 'docs/review.md',
        }),
      ],
    });
    expect(completed?.nodes.review?.outputs?.context_briefing).toMatchObject({
      schema: 'viewport.context_briefing/v1',
      nodeId: 'review',
      selectedSources: [
        expect.objectContaining({
          ref: 'repo_docs',
        }),
      ],
      topEntries: [
        expect.objectContaining({
          provider_id: 'repo_docs',
          title: 'docs/review.md',
        }),
      ],
      retrievalCaps: expect.objectContaining({
        maxItems: null,
      }),
    });
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'node-context-selected',
        nodeId: 'review',
      }),
    );
  });

  it('injects selected viewport-vault context when local edge credentials are configured', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);

    await fs.mkdir(path.join(projectDir, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: support-team-memory',
        '      provider: viewport-vault',
        '      vault: support-team-memory',
        '',
      ].join('\n'),
      'utf8',
    );

    const credentials = {
      passphrase: 'local-proof-passphrase',
      recoveryCode: 'local-proof-recovery',
    };
    await initContextResource({
      contextResourceId: 'support-team-memory',
      userName: 'payments-team',
      deviceName: 'Mac.lan',
      credentials,
    });
    await addContextEntry({
      contextResourceId: 'support-team-memory',
      actorName: 'Mac.lan',
      title: 'Support team memory',
      body: 'Support workflow memory should be injected only when the node asks for it.',
      credentials,
    });

    const previousPassphrase = process.env.VIEWPORT_CONTEXT_SUPPORT_TEAM_MEMORY_PASSPHRASE;
    const previousRecovery = process.env.VIEWPORT_CONTEXT_SUPPORT_TEAM_MEMORY_RECOVERY_CODE;
    process.env.VIEWPORT_CONTEXT_SUPPORT_TEAM_MEMORY_PASSPHRASE = credentials.passphrase;
    process.env.VIEWPORT_CONTEXT_SUPPORT_TEAM_MEMORY_RECOVERY_CODE = credentials.recoveryCode;

    try {
      const workflowPath = path.join(projectDir, 'workflow.yaml');
      await fs.writeFile(
        workflowPath,
        `
schema: viewport.workflow/v1
name: prompt-vault-context-proof
requires:
  agents:
    - claude
nodes:
  review:
    type: prompt
    agent: claude
    context:
      include:
        - source: provider://support-team-memory
          as: planning-memory
          required: true
    prompt: Review support memory.
`,
        'utf-8',
      );

      const run = await daemon.workflowRunner.startRun({
        workflowPath,
        directoryId: DirectoryManager.idFromPath(projectDir),
        initiation: 'cli',
      });

      const session = await waitForSessionWithPrompt(adapter, 'Review support memory.');
      const sentPrompt = String(session.sendPrompt.mock.calls.at(-1)?.[0] ?? '');
      expect(sentPrompt).toContain('<viewport_context>');
      expect(sentPrompt).toContain('planning-memory (viewport-vault)');
      expect(sentPrompt).toContain(
        'Support workflow memory should be injected only when the node asks for it.',
      );

      session.emitAgentMessage('vault context used');
      session.simulateIdle();
      await waitForTerminalRun(daemon, run.id);

      const completed = await daemon.workflowRunner.getRun(run.id);
      expect(completed?.status).toBe('completed');
      expect(completed?.contextReceipts).toEqual([
        expect.objectContaining({
          provider: 'viewport-vault',
          usedBy: expect.objectContaining({
            nodeId: 'review',
            providerId: 'support-team-memory',
            alias: 'planning-memory',
          }),
        }),
      ]);
    } finally {
      if (previousPassphrase === undefined) {
        delete process.env.VIEWPORT_CONTEXT_SUPPORT_TEAM_MEMORY_PASSPHRASE;
      } else {
        process.env.VIEWPORT_CONTEXT_SUPPORT_TEAM_MEMORY_PASSPHRASE = previousPassphrase;
      }
      if (previousRecovery === undefined) {
        delete process.env.VIEWPORT_CONTEXT_SUPPORT_TEAM_MEMORY_RECOVERY_CODE;
      } else {
        process.env.VIEWPORT_CONTEXT_SUPPORT_TEAM_MEMORY_RECOVERY_CODE = previousRecovery;
      }
    }
  });

  it('isolates selected context per prompt node and records node-scoped basis evidence', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);

    await fs.mkdir(path.join(projectDir, '.viewport'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'docs', 'plan'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'docs', 'implement'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'artifacts'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'docs', 'plan', 'planning.md'),
      'PLAN_ONLY_CONTEXT: prioritize risk review before implementation.',
      'utf8',
    );
    await fs.writeFile(
      path.join(projectDir, 'docs', 'implement', 'implementation.md'),
      'IMPLEMENT_ONLY_CONTEXT: update src/proof.ts and run focused tests.',
      'utf8',
    );
    await fs.writeFile(
      path.join(projectDir, 'artifacts', 'plan-basis.md'),
      'Plan artifact placeholder for context basis proof.',
      'utf8',
    );
    await fs.writeFile(
      path.join(projectDir, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: plan_docs',
        '      provider: repo-docs',
        '      paths:',
        '        - docs/plan/**/*.md',
        '    - id: implement_docs',
        '      provider: repo-docs',
        '      paths:',
        '        - docs/implement/**/*.md',
        '',
      ].join('\n'),
      'utf8',
    );

    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: per-node-context-proof
context:
  - source: plan_docs
  - source: implement_docs
requires:
  agents:
    - claude
nodes:
  plan:
    type: prompt
    agent: claude
    cwd: .
    artifacts:
      plan_basis:
        path: artifacts/plan-basis.md
        type: report
    context:
      include:
        - source: plan_docs
          as: planning-basis
          max_items: 1
      max_items: 1
      write_targets:
        - kind: team_memory
          ref: context-candidates/payments-default
    prompt: Draft a plan for the support ticket.
  implement:
    type: prompt
    agent: claude
    needs:
      - plan
    context:
      include:
        - source: implement_docs
          as: implementation-basis
          max_items: 1
      max_items: 1
    prompt: Implement the approved plan using {{ nodes.plan.output }}.
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    const planSession = await waitForSessionWithPrompt(
      adapter,
      'Draft a plan for the support ticket.',
    );
    const planPrompt = String(planSession.sendPrompt.mock.calls.at(-1)?.[0] ?? '');
    expect(planPrompt).toContain('PLAN_ONLY_CONTEXT');
    expect(planPrompt).not.toContain('IMPLEMENT_ONLY_CONTEXT');
    expect(planPrompt).toContain('planning-basis');
    planSession.emitAgentMessage('approved plan output');
    planSession.simulateIdle();

    const implementSession = await waitForSessionWithPrompt(adapter, 'Implement the approved plan');
    const implementPrompt = String(implementSession.sendPrompt.mock.calls.at(-1)?.[0] ?? '');
    expect(implementPrompt).toContain('IMPLEMENT_ONLY_CONTEXT');
    expect(implementPrompt).not.toContain('PLAN_ONLY_CONTEXT');
    expect(implementPrompt).toContain('implementation-basis');
    expect(implementPrompt).toContain('approved plan output');
    implementSession.emitAgentMessage('implementation complete');
    implementSession.simulateIdle();

    await waitForTerminalRun(daemon, run.id);

    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.contextReceipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requested: 'plan_docs',
          usedBy: expect.objectContaining({
            nodeId: 'plan',
            providerId: 'plan_docs',
            alias: 'planning-basis',
          }),
        }),
        expect.objectContaining({
          requested: 'implement_docs',
          usedBy: expect.objectContaining({
            nodeId: 'implement',
            providerId: 'implement_docs',
            alias: 'implementation-basis',
          }),
        }),
      ]),
    );
    expect(completed?.nodes.plan?.outputs?.context_basis).toMatchObject({
      mode: 'node_envelope',
      writeTargets: [
        expect.objectContaining({
          kind: 'team_memory',
          ref: 'context-candidates/payments-default',
        }),
      ],
      selectedItems: [
        expect.objectContaining({
          provider_id: 'plan_docs',
          alias: 'planning-basis',
        }),
      ],
    });
    expect(completed?.nodes.plan?.outputs?.context_briefing).toMatchObject({
      schema: 'viewport.context_briefing/v1',
      nodeId: 'plan',
      topEntries: [
        expect.objectContaining({
          provider_id: 'plan_docs',
          label: 'planning-basis',
        }),
      ],
      writeTargets: [
        expect.objectContaining({
          kind: 'team_memory',
          ref: 'context-candidates/payments-default',
        }),
      ],
    });
    expect(completed?.nodes.implement?.outputs?.context_basis).toMatchObject({
      mode: 'node_envelope',
      selectedItems: [
        expect.objectContaining({
          provider_id: 'implement_docs',
          alias: 'implementation-basis',
        }),
      ],
    });
    expect(completed?.artifacts).toContainEqual(
      expect.objectContaining({
        nodeId: 'plan',
        name: 'plan_basis',
        metadata: expect.objectContaining({
          context_briefing: expect.objectContaining({
            schema: 'viewport.context_briefing/v1',
            nodeId: 'plan',
          }),
          context_basis: expect.objectContaining({
            nodeId: 'plan',
            selectedItems: [
              expect.objectContaining({
                provider_id: 'plan_docs',
                alias: 'planning-basis',
              }),
            ],
          }),
        }),
      }),
    );
    expect(
      completed?.events.filter((event) => event.type === 'node-context-selected'),
    ).toHaveLength(2);
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
