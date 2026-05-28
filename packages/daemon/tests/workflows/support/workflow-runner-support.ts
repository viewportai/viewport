import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { vi } from 'vitest';
import type { Daemon } from '../../../src/core/daemon.js';
import type {
  AgentAdapter,
  AgentAdapterDescriptor,
  DiscoveredSession,
  RunTracker,
  Session,
  SessionOptions,
} from '../../../src/core/interfaces.js';
import type { SessionState, Step } from '../../../src/core/types.js';

type MockAdapterDescriptorOverrides = Omit<Partial<AgentAdapterDescriptor>, 'capabilities'> & {
  capabilities?: Omit<Partial<AgentAdapterDescriptor['capabilities']>, 'executionModes'> & {
    executionModes?: Partial<AgentAdapterDescriptor['capabilities']['executionModes']>;
  };
};

export class MockSession extends EventEmitter implements Session {
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

  emitTokenUsage(
    inputTokens: number,
    outputTokens: number,
    totalCostUsd?: number,
    options: {
      inputTokenScope?: 'billable' | 'raw_provider';
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      billableInputTokens?: number;
      budgetedTotalTokens?: number;
    } = {},
  ): void {
    this.emit('message', {
      type: 'token_usage',
      inputTokens,
      outputTokens,
      ...options,
      ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
      timestamp: Date.now(),
    });
  }

  emitToolCall(toolCallId: string, toolName: string, status: 'in_progress' | 'completed' = 'in_progress'): void {
    this.emit('message', {
      type: 'tool_call',
      toolCallId,
      toolName,
      title: `${toolName} call`,
      status,
      input: { path: 'README.md' },
      timestamp: Date.now(),
    });
  }

  emitToolCallUpdate(toolCallId: string, toolName: string, status: 'completed' | 'error'): void {
    this.emit('message', {
      type: 'tool_call_update',
      toolCallId,
      toolName,
      status,
      output: status === 'error' ? 'denied' : 'ok',
      timestamp: Date.now(),
    });
  }
}

export class MockAdapter implements AgentAdapter {
  readonly agentId = 'claude';
  lastSession: MockSession | null = null;
  lastOptions: SessionOptions | undefined;
  readonly sessions: MockSession[] = [];
  readonly cwdBySession = new Map<MockSession, string>();

  constructor(private readonly descriptorOverrides: MockAdapterDescriptorOverrides = {}) {}

  describe(): AgentAdapterDescriptor {
    const base: AgentAdapterDescriptor = {
      schema: 'viewport.agent_adapter/v2',
      agentId: this.agentId,
      displayName: 'Mock adapter',
      adapterVersion: 'test',
      capabilities: {
        executionModes: {
          plan: 'hard',
          read_only: 'hard',
          review: 'hard',
          implement: 'hard',
        },
        toolAllowlist: 'hard',
        structuredOutput: 'hard',
        permissionHooks: 'hard',
        usageReporting: 'reported',
        costReporting: 'reported',
        maxTurns: 'hard',
        maxBudget: 'hard',
        hardTimeout: 'hard',
      },
    };
    return {
      ...base,
      ...this.descriptorOverrides,
      capabilities: {
        ...base.capabilities,
        ...(this.descriptorOverrides.capabilities ?? {}),
        executionModes: {
          ...base.capabilities.executionModes,
          ...(this.descriptorOverrides.capabilities?.executionModes ?? {}),
        },
      },
    };
  }

  async startSession(cwd: string, options?: SessionOptions): Promise<Session> {
    this.lastSession = new MockSession();
    this.lastOptions = options;
    this.sessions.push(this.lastSession);
    this.cwdBySession.set(this.lastSession, cwd);
    return this.lastSession;
  }

  async resumeSession(_sessionId: string, cwd: string, options?: SessionOptions): Promise<Session> {
    this.lastSession = new MockSession();
    this.lastOptions = options;
    this.sessions.push(this.lastSession);
    this.cwdBySession.set(this.lastSession, cwd);
    return this.lastSession;
  }
}

export class PathDiscovery {
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

export class WorktreeTracker implements RunTracker {
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

export async function waitForTerminalRun(daemon: Daemon, runId: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    const run = await daemon.workflowRunner.getRun(runId);
    if (run && ['completed', 'failed', 'blocked', 'canceled'].includes(run.status)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for workflow run ${runId}`);
}

export async function waitForCompletedRun(daemon: Daemon, runId: string): Promise<void> {
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

export async function waitForRunState(
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

export async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

export async function waitForNodeSession(
  daemon: Daemon,
  runId: string,
  nodeId: string,
): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    const run = await daemon.workflowRunner.getRun(runId);
    if (run?.nodes[nodeId]?.sessionId) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for workflow node session ${nodeId}`);
}

export async function waitForAdapterSessionCount(
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

export async function waitForSupervisorSession(
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

export async function waitForSessionWithPrompt(
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

export function findSessionWithPrompt(
  adapter: MockAdapter,
  promptFragment: string,
): MockSession | null {
  return (
    adapter.sessions.find((session) =>
      session.sendPrompt.mock.calls.some(([prompt]) => String(prompt).includes(promptFragment)),
    ) ?? null
  );
}

export async function writeCodexTranscript(cwd: string, output: string): Promise<void> {
  const root = path.join(process.env['CODEX_HOME'] ?? cwd, 'sessions', '2026', '04', '24');
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
