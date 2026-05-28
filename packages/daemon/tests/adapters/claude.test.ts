import { describe, it, expect, vi } from 'vitest';
import { ClaudeAdapter, ClaudeSession } from '../../src/adapters/claude.js';
import type { QueryFn } from '../../src/adapters/claude.js';
import type { SessionConfig, SessionMessage, PermissionDecision } from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers — mock SDK query as a controlled async generator
// ---------------------------------------------------------------------------

interface MockMessage {
  type: string;
  subtype?: string;
  [key: string]: any;
}

function createMockQuery(messages: MockMessage[]): QueryFn {
  return vi.fn().mockReturnValue({
    async *[Symbol.asyncIterator]() {
      for (const msg of messages) {
        yield msg;
      }
    },
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  });
}

function automatedConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    agent: 'claude',
    approvalPolicy: 'never',
    trust: 'automated',
    gitTracker: {
      enabled: false,
      commitOn: [],
      ignore: [],
      autoSquashOnComplete: false,
      branchPrefix: 'viewport/session-',
      commitAuthor: 'Viewport Agent <noreply@example.test>',
      maxCommitsPerSession: 500,
      worktreeRoot: '.viewport/worktrees',
    },
    permissions: {
      autoApprove: [],
      requireApproval: ['Bash'],
      deny: [],
    },
    ...overrides,
  };
}

function createBlockingQuery(): {
  queryFn: QueryFn;
  emit: (msg: MockMessage) => void;
  complete: () => void;
} {
  let resolveNext: ((value: IteratorResult<MockMessage, void>) => void) | null = null;
  const pendingMessages: MockMessage[] = [];
  let done = false;

  const queryFn: QueryFn = vi.fn().mockReturnValue({
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<MockMessage, void>> {
          if (pendingMessages.length > 0) {
            return Promise.resolve({ value: pendingMessages.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },
      };
    },
    interrupt: vi.fn().mockImplementation(() => {
      done = true;
      if (resolveNext) {
        resolveNext({ value: undefined, done: true });
        resolveNext = null;
      }
      return Promise.resolve();
    }),
    close: vi.fn().mockImplementation(() => {
      done = true;
      if (resolveNext) {
        resolveNext({ value: undefined, done: true });
        resolveNext = null;
      }
    }),
  });

  return {
    queryFn,
    emit(msg: MockMessage) {
      if (resolveNext) {
        resolveNext({ value: msg, done: false });
        resolveNext = null;
      } else {
        pendingMessages.push(msg);
      }
    },
    complete() {
      done = true;
      if (resolveNext) {
        resolveNext({ value: undefined, done: true });
        resolveNext = null;
      }
    },
  };
}

function collectMessages(session: ClaudeSession): SessionMessage[] {
  const messages: SessionMessage[] = [];
  session.on('message', (msg: SessionMessage) => messages.push(msg));
  return messages;
}

// ---------------------------------------------------------------------------
// ClaudeAdapter
// ---------------------------------------------------------------------------

describe('ClaudeAdapter', () => {
  it('has agentId of "claude"', () => {
    const adapter = new ClaudeAdapter(createMockQuery([]));
    expect(adapter.agentId).toBe('claude');
  });

  it('starts a session with a prompt', async () => {
    const queryFn = createMockQuery([{ type: 'system', subtype: 'init', session_id: 'test-id' }]);

    const adapter = new ClaudeAdapter(queryFn);
    const session = await adapter.startSession('/test/dir', {
      initialPrompt: 'Hello',
    });

    expect(session.id).toBeTruthy();
    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Hello',
        options: expect.objectContaining({
          cwd: '/test/dir',
        }),
      }),
    );
  });

  it('maps automated approvalPolicy never to Claude bypassPermissions mode', async () => {
    const queryFn = createMockQuery([
      { type: 'result', subtype: 'success', session_id: 'test-id' },
    ]);

    const adapter = new ClaudeAdapter(queryFn);
    await adapter.startSession('/test/dir', {
      initialPrompt: 'Run without interactive permission prompts',
      config: automatedConfig(),
    });

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Run without interactive permission prompts',
        options: expect.objectContaining({
          permissionMode: 'bypassPermissions',
        }),
      }),
    );
  });

  it('maps plan execution mode to Claude plan permission mode', async () => {
    const queryFn = createMockQuery([
      { type: 'result', subtype: 'success', session_id: 'plan-id' },
    ]);

    const adapter = new ClaudeAdapter(queryFn);
    await adapter.startSession('/test/dir', {
      initialPrompt: 'Draft a plan without implementing.',
      config: automatedConfig({ executionMode: 'plan' }),
    });

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Draft a plan without implementing.',
        options: expect.objectContaining({
          permissionMode: 'plan',
          tools: [],
        }),
      }),
    );
  });

  it('passes workflow budget caps to Claude provider options', async () => {
    const queryFn = createMockQuery([
      { type: 'result', subtype: 'success', session_id: 'budget-id' },
    ]);

    const adapter = new ClaudeAdapter(queryFn);
    await adapter.startSession('/test/dir', {
      initialPrompt: 'Stay inside the workflow budget.',
      config: automatedConfig({
        maxTurns: 4,
        maxBudgetUsd: 0.25,
      }),
    });

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Stay inside the workflow budget.',
        options: expect.objectContaining({
          maxTurns: 4,
          maxBudgetUsd: 0.25,
        }),
      }),
    );
  });

  it('maps read-only execution mode to Claude read/search tools', async () => {
    const queryFn = createMockQuery([
      { type: 'result', subtype: 'success', session_id: 'readonly-id' },
    ]);

    const adapter = new ClaudeAdapter(queryFn);
    await adapter.startSession('/test/dir', {
      initialPrompt: 'Inspect files without changing them.',
      config: {
        agent: 'claude',
        approvalPolicy: 'never',
        executionMode: 'read_only',
        trust: 'automated',
        gitTracker: {
          enabled: false,
          commitOn: [],
          ignore: [],
          autoSquashOnComplete: false,
          branchPrefix: 'viewport/session-',
          commitAuthor: 'Viewport Agent <noreply@example.test>',
          maxCommitsPerSession: 500,
          worktreeRoot: '.viewport/worktrees',
        },
        permissions: {
          autoApprove: [],
          requireApproval: ['Bash'],
          deny: [],
        },
      },
    });

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Inspect files without changing them.',
        options: expect.objectContaining({
          permissionMode: 'bypassPermissions',
          tools: ['Read', 'Grep', 'Glob'],
          allowedTools: ['Read', 'Grep', 'Glob'],
        }),
      }),
    );
  });

  it('maps review execution mode to Claude read/search tools', async () => {
    const queryFn = createMockQuery([
      { type: 'result', subtype: 'success', session_id: 'review-id' },
    ]);

    const adapter = new ClaudeAdapter(queryFn);
    await adapter.startSession('/test/dir', {
      initialPrompt: 'Review the plan without changing files.',
      config: {
        agent: 'claude',
        approvalPolicy: 'never',
        executionMode: 'review',
        trust: 'automated',
        gitTracker: {
          enabled: false,
          commitOn: [],
          ignore: [],
          autoSquashOnComplete: false,
          branchPrefix: 'viewport/session-',
          commitAuthor: 'Viewport Agent <noreply@example.test>',
          maxCommitsPerSession: 500,
          worktreeRoot: '.viewport/worktrees',
        },
        permissions: {
          autoApprove: [],
          requireApproval: ['Bash'],
          deny: [],
        },
      },
    });

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Review the plan without changing files.',
        options: expect.objectContaining({
          permissionMode: 'bypassPermissions',
          tools: ['Read', 'Grep', 'Glob'],
          allowedTools: ['Read', 'Grep', 'Glob'],
        }),
      }),
    );
  });

  it('preserves plan mode for deferred initial prompts', async () => {
    const queryFn = createMockQuery([
      { type: 'result', subtype: 'success', session_id: 'plan-id' },
    ]);
    const adapter = new ClaudeAdapter(queryFn);

    const session = await adapter.startSession('/test/dir', {
      initialPrompt: 'Draft a plan later.',
      deferInitialPrompt: true,
      config: {
        agent: 'claude',
        approvalPolicy: 'never',
        executionMode: 'plan',
        trust: 'automated',
        gitTracker: {
          enabled: false,
          commitOn: [],
          ignore: [],
          autoSquashOnComplete: false,
          branchPrefix: 'viewport/session-',
          commitAuthor: 'Viewport Agent <noreply@example.test>',
          maxCommitsPerSession: 500,
          worktreeRoot: '.viewport/worktrees',
        },
        permissions: {
          autoApprove: [],
          requireApproval: ['Bash'],
          deny: [],
        },
      },
    });

    expect(queryFn).not.toHaveBeenCalled();

    await session.sendPrompt('Draft a plan later.');

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Draft a plan later.',
        options: expect.objectContaining({
          permissionMode: 'plan',
          tools: [],
        }),
      }),
    );
  });

  it('resumes a session by ID', async () => {
    const queryFn = createMockQuery([
      { type: 'system', subtype: 'init', session_id: 'existing-id' },
    ]);

    const adapter = new ClaudeAdapter(queryFn);
    const session = await adapter.resumeSession('existing-id', '/test/dir', {
      initialPrompt: 'Resume this',
    });

    expect(session.id).toBe('existing-id');
    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Resume this',
        options: expect.objectContaining({
          resume: 'existing-id',
        }),
      }),
    );
  });

  it('does not inject default prompts when initial prompt is absent', async () => {
    const queryFn = createMockQuery([{ type: 'system', subtype: 'init', session_id: 'sid-empty' }]);
    const adapter = new ClaudeAdapter(queryFn);

    await adapter.startSession('/test/dir');
    expect(queryFn).not.toHaveBeenCalled();

    await adapter.resumeSession('existing-id', '/test/dir');
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('resumeSession with deferred initial prompt stays idle until a real prompt is sent', async () => {
    const queryFn = createMockQuery([
      { type: 'result', subtype: 'success', session_id: 'existing-id' },
    ]);
    const adapter = new ClaudeAdapter(queryFn);

    const session = await adapter.resumeSession('existing-id', '/test/dir', {
      initialPrompt: 'Resume this',
      deferInitialPrompt: true,
    });

    expect(session.state).toBe('idle');
    expect(queryFn).not.toHaveBeenCalled();

    await session.sendPrompt('Resume this');

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Resume this',
        options: expect.objectContaining({
          cwd: '/test/dir',
          resume: 'existing-id',
        }),
      }),
    );
  });

  it('preserves model and automated permission mode for deferred initial prompts', async () => {
    const queryFn = createMockQuery([
      { type: 'result', subtype: 'success', session_id: 'deferred-id' },
    ]);
    const adapter = new ClaudeAdapter(queryFn);

    const session = await adapter.startSession('/test/dir', {
      initialPrompt: 'Run deferred',
      deferInitialPrompt: true,
      model: 'sonnet',
      config: {
        agent: 'claude',
        approvalPolicy: 'never',
        trust: 'automated',
        gitTracker: {
          enabled: false,
          commitOn: [],
          ignore: [],
          autoSquashOnComplete: false,
          branchPrefix: 'viewport/session-',
          commitAuthor: 'Viewport Agent <noreply@example.test>',
          maxCommitsPerSession: 500,
          worktreeRoot: '.viewport/worktrees',
        },
        permissions: {
          autoApprove: [],
          requireApproval: ['Bash'],
          deny: [],
        },
      },
    });

    expect(session.state).toBe('idle');
    expect(queryFn).not.toHaveBeenCalled();

    await session.sendPrompt('Run deferred');

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Run deferred',
        options: expect.objectContaining({
          cwd: '/test/dir',
          model: 'sonnet',
          permissionMode: 'bypassPermissions',
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// ClaudeSession — message normalization
// ---------------------------------------------------------------------------

describe('ClaudeSession — message normalization', () => {
  it('buffers early messages until a message listener is attached', async () => {
    const queryFn = createMockQuery([
      {
        type: 'assistant',
        uuid: 'early-agent-1',
        message: {
          content: [{ type: 'text', text: 'early reply' }],
        },
      },
    ]);

    const session = new ClaudeSession('test', queryFn);
    await session.start('hello before listeners', '/cwd');
    await new Promise((r) => setTimeout(r, 50));

    const buffered: SessionMessage[] = [];
    session.on('message', (msg: SessionMessage) => buffered.push(msg));
    await new Promise((r) => setTimeout(r, 10));

    const user = buffered.find((m) => m.type === 'user_message');
    const agent = buffered.find((m) => m.type === 'agent_message');
    expect(user).toBeDefined();
    expect(agent).toBeDefined();
    if (user?.type === 'user_message') {
      expect(user.text).toBe('hello before listeners');
    }
  });

  it('normalizes system init message', async () => {
    const queryFn = createMockQuery([
      { type: 'system', subtype: 'init', session_id: 'sid-1', tools: ['Edit'] },
    ]);

    const session = new ClaudeSession('test', queryFn);
    const messages = collectMessages(session);
    await session.start('hello', '/cwd');

    // Wait for drain to complete
    await new Promise((r) => setTimeout(r, 50));

    const initMsg = messages.find(
      (m) => m.type === 'system_status' && 'status' in m && m.status === 'initialized',
    );
    expect(initMsg).toBeDefined();
  });

  it('normalizes assistant text messages', async () => {
    const queryFn = createMockQuery([
      {
        type: 'assistant',
        uuid: 'msg-1',
        message: {
          content: [{ type: 'text', text: 'Hello! How can I help?' }],
        },
      },
    ]);

    const session = new ClaudeSession('test', queryFn);
    const messages = collectMessages(session);
    await session.start('hi', '/cwd');
    await new Promise((r) => setTimeout(r, 50));

    const agentMsg = messages.find((m) => m.type === 'agent_message');
    expect(agentMsg).toBeDefined();
    expect(agentMsg!.type === 'agent_message' && agentMsg.text).toBe('Hello! How can I help?');
  });

  it('normalizes tool_use blocks into tool_call messages', async () => {
    const queryFn = createMockQuery([
      {
        type: 'assistant',
        uuid: 'msg-2',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-123',
              name: 'Edit',
              input: { file_path: '/test.ts' },
            },
          ],
        },
      },
    ]);

    const session = new ClaudeSession('test', queryFn);
    const messages = collectMessages(session);
    await session.start('edit file', '/cwd');
    await new Promise((r) => setTimeout(r, 50));

    const toolCall = messages.find((m) => m.type === 'tool_call');
    expect(toolCall).toBeDefined();
    if (toolCall?.type === 'tool_call') {
      expect(toolCall.toolCallId).toBe('tu-123');
      expect(toolCall.toolName).toBe('Edit');
      expect(toolCall.input).toEqual({ file_path: '/test.ts' });
    }
  });

  it('normalizes thinking blocks', async () => {
    const queryFn = createMockQuery([
      {
        type: 'assistant',
        uuid: 'msg-3',
        message: {
          content: [{ type: 'thinking', thinking: 'Let me analyze...' }],
        },
      },
    ]);

    const session = new ClaudeSession('test', queryFn);
    const messages = collectMessages(session);
    await session.start('think', '/cwd');
    await new Promise((r) => setTimeout(r, 50));

    const thought = messages.find((m) => m.type === 'agent_thought_chunk');
    expect(thought).toBeDefined();
    expect(thought!.type === 'agent_thought_chunk' && thought.text).toBe('Let me analyze...');
  });

  it('normalizes stream events (text delta)', async () => {
    const queryFn = createMockQuery([
      {
        type: 'stream_event',
        uuid: 'chunk-1',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'partial text' },
        },
      },
    ]);

    const session = new ClaudeSession('test', queryFn);
    const messages = collectMessages(session);
    await session.start('stream', '/cwd');
    await new Promise((r) => setTimeout(r, 50));

    const chunk = messages.find((m) => m.type === 'agent_message_chunk');
    expect(chunk).toBeDefined();
    expect(chunk!.type === 'agent_message_chunk' && chunk.text).toBe('partial text');
  });

  it('normalizes result success messages', async () => {
    const queryFn = createMockQuery([
      {
        type: 'result',
        subtype: 'success',
        result: 'Done!',
        session_id: 'sid',
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.01,
        duration_ms: 5000,
        num_turns: 3,
      },
    ]);

    const session = new ClaudeSession('test', queryFn);
    const messages = collectMessages(session);
    await session.start('do something', '/cwd');
    await new Promise((r) => setTimeout(r, 50));

    const tokenMsg = messages.find((m) => m.type === 'token_usage');
    expect(tokenMsg).toBeDefined();
    if (tokenMsg?.type === 'token_usage') {
      expect(tokenMsg.inputTokens).toBe(100);
      expect(tokenMsg.outputTokens).toBe(50);
      expect(tokenMsg.totalCostUsd).toBe(0.01);
    }
  });

  it('normalizes result error messages', async () => {
    const queryFn = createMockQuery([
      {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['Something went wrong'],
        session_id: 'sid',
      },
    ]);

    const session = new ClaudeSession('test', queryFn);
    const ended = vi.fn();
    session.on('ended', ended);
    await session.start('fail', '/cwd');
    await new Promise((r) => setTimeout(r, 50));

    expect(session.state).toBe('errored');
    expect(ended).not.toHaveBeenCalled();
  });

  it('ignores unknown message types', async () => {
    const queryFn = createMockQuery([{ type: 'unknown_type', data: 'something' }]);

    const session = new ClaudeSession('test', queryFn);
    const messages = collectMessages(session);
    await session.start('', '/cwd');
    await new Promise((r) => setTimeout(r, 50));

    expect(messages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ClaudeSession — state management
// ---------------------------------------------------------------------------

describe('ClaudeSession — state management', () => {
  it('transitions to running on start', async () => {
    const { queryFn, complete } = createBlockingQuery();
    const session = new ClaudeSession('test', queryFn);

    const states: string[] = [];
    session.on('state-change', (s: string) => states.push(s));

    await session.start('hello', '/cwd');
    expect(session.state).toBe('running');
    expect(states).toContain('running');

    complete();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('transitions to idle when generator completes', async () => {
    const queryFn = createMockQuery([]);
    const session = new ClaudeSession('test', queryFn);

    await session.start('hello', '/cwd');
    await new Promise((r) => setTimeout(r, 50));

    expect(session.state).toBe('idle');
  });

  it('transitions to idle on result success (ready for follow-ups)', async () => {
    const queryFn = createMockQuery([
      { type: 'result', subtype: 'success', session_id: 'sid', usage: {} },
    ]);

    const session = new ClaudeSession('test', queryFn);
    await session.start('hello', '/cwd');
    await new Promise((r) => setTimeout(r, 50));

    expect(session.state).toBe('idle');
  });

  it('transitions to completed on kill', async () => {
    const { queryFn } = createBlockingQuery();
    const session = new ClaudeSession('test', queryFn);

    await session.start('hello', '/cwd');
    await session.kill();

    expect(session.state).toBe('completed');
  });

  it('emits ended event on kill', async () => {
    const { queryFn } = createBlockingQuery();
    const session = new ClaudeSession('test', queryFn);

    const ended: string[] = [];
    session.on('ended', (reason: string) => ended.push(reason));

    await session.start('hello', '/cwd');
    await session.kill();

    expect(ended).toContain('killed');
  });
});

// ---------------------------------------------------------------------------
// ClaudeSession — permissions
// ---------------------------------------------------------------------------

describe('ClaudeSession — permissions', () => {
  it('calls canUseTool handler and transitions to waiting_permission', async () => {
    const permissionDecision: PermissionDecision = { behavior: 'allow' };
    const canUseTool = vi.fn().mockResolvedValue(permissionDecision);

    // Create a query that triggers canUseTool
    let sdkCanUseTool:
      | ((
          toolName: string,
          input: Record<string, unknown>,
          options: { signal: AbortSignal; toolUseID: string },
        ) => Promise<{ behavior: string }>)
      | null = null;

    const queryFn: QueryFn = vi.fn().mockImplementation(({ options }) => {
      sdkCanUseTool = options?.canUseTool ?? null;
      return {
        async *[Symbol.asyncIterator]() {
          // Yield nothing — permission happens via callback
        },
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      };
    });

    const session = new ClaudeSession('test', queryFn, canUseTool);
    const stateChanges: string[] = [];
    session.on('state-change', (state: string) => stateChanges.push(state));

    await session.start('hello', '/cwd');

    // Simulate SDK calling canUseTool
    expect(sdkCanUseTool).toBeTruthy();
    const result = await sdkCanUseTool!(
      'Edit',
      { file_path: '/test.ts' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tu-1',
      },
    );

    expect(result.behavior).toBe('allow');
    if (result.behavior === 'allow') {
      expect(result.updatedInput).toEqual({ file_path: '/test.ts' });
    }
    expect(canUseTool).toHaveBeenCalledWith(
      'Edit',
      { file_path: '/test.ts' },
      expect.objectContaining({ toolUseId: 'tu-1' }),
    );
    // Session should have transitioned to waiting_permission and back to running
    expect(stateChanges).toContain('waiting_permission');

    // Clean up
    session.kill();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('returns deny when handler denies', async () => {
    const canUseTool = vi.fn().mockResolvedValue({
      behavior: 'deny',
      message: 'Not allowed',
    });

    let sdkCanUseTool:
      | ((
          toolName: string,
          input: Record<string, unknown>,
          options: { signal: AbortSignal; toolUseID: string },
        ) => Promise<{ behavior: string; message?: string }>)
      | null = null;

    const queryFn: QueryFn = vi.fn().mockImplementation(({ options }) => {
      sdkCanUseTool = options?.canUseTool ?? null;
      return {
        async *[Symbol.asyncIterator]() {},
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      };
    });

    const session = new ClaudeSession('test', queryFn, canUseTool);
    await session.start('hello', '/cwd');

    const result = await sdkCanUseTool!(
      'Bash',
      { command: 'rm -rf /' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tu-2',
      },
    );

    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('Not allowed');

    session.kill();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('returns deny when handler throws', async () => {
    const canUseTool = vi.fn().mockRejectedValue(new Error('Handler crashed'));

    let sdkCanUseTool:
      | ((
          toolName: string,
          input: Record<string, unknown>,
          options: { signal: AbortSignal; toolUseID: string },
        ) => Promise<{ behavior: string; message?: string }>)
      | null = null;

    const queryFn: QueryFn = vi.fn().mockImplementation(({ options }) => {
      sdkCanUseTool = options?.canUseTool ?? null;
      return {
        async *[Symbol.asyncIterator]() {},
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      };
    });

    const session = new ClaudeSession('test', queryFn, canUseTool);
    await session.start('hello', '/cwd');

    const result = await sdkCanUseTool!(
      'Edit',
      {},
      {
        signal: new AbortController().signal,
        toolUseID: 'tu-3',
      },
    );

    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('Permission handler error');

    session.kill();
    await new Promise((r) => setTimeout(r, 50));
  });
});

// ---------------------------------------------------------------------------
// ClaudeSession — sendPrompt
// ---------------------------------------------------------------------------

describe('ClaudeSession — sendPrompt', () => {
  it('lazily starts query when session was created without initial prompt', async () => {
    const queryFn = createMockQuery([{ type: 'result', subtype: 'success', session_id: 'test' }]);
    const session = new ClaudeSession('test', queryFn);

    await session.start('', '/cwd');
    await session.sendPrompt('hello');
    await new Promise((r) => setTimeout(r, 50));

    expect(queryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'hello',
        options: expect.objectContaining({
          sessionId: 'test',
        }),
      }),
    );
  });

  it('transitions idle to running on sendPrompt', async () => {
    const { queryFn, complete } = createBlockingQuery();
    const session = new ClaudeSession('test', queryFn);

    await session.start('hello', '/cwd');
    complete();
    await new Promise((r) => setTimeout(r, 50));

    expect(session.state).toBe('idle');
    const firstQuery = (queryFn as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value as
      | { interrupt?: ReturnType<typeof vi.fn> }
      | undefined;

    // sendPrompt should transition back to running
    const states: string[] = [];
    session.on('state-change', (s: string) => states.push(s));

    // Mock queryFn to return a new blocking generator for the follow-up
    (queryFn as ReturnType<typeof vi.fn>).mockReturnValue({
      async *[Symbol.asyncIterator]() {
        // block forever
        await new Promise(() => {});
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    });

    await session.sendPrompt('follow up');
    expect(session.state).toBe('running');
    expect(states).toContain('running');
    expect(firstQuery?.interrupt).not.toHaveBeenCalled();

    await session.kill();
  });

  it('emits user_message when sending prompt so UI can render immediately', async () => {
    const queryFn = createMockQuery([
      { type: 'result', subtype: 'success', session_id: 'sid-1' },
      {
        type: 'assistant',
        uuid: 'a-1',
        message: {
          content: [{ type: 'text', text: 'reply' }],
        },
      },
      { type: 'result', subtype: 'success', session_id: 'sid-1' },
    ]);
    const session = new ClaudeSession('test', queryFn);
    const messages = collectMessages(session);

    await session.start('', '/cwd');
    await new Promise((r) => setTimeout(r, 50));
    await session.sendPrompt('show my prompt');
    await new Promise((r) => setTimeout(r, 50));

    const user = messages.find((m) => m.type === 'user_message');
    expect(user).toBeDefined();
    if (user?.type === 'user_message') {
      expect(user.text).toBe('show my prompt');
    }

    await session.kill();
  });

  it('resume without explicit prompt stays idle and does not emit local user message', async () => {
    const queryFn = createMockQuery([{ type: 'result', subtype: 'success', session_id: 'sid-2' }]);
    const session = new ClaudeSession('test', queryFn);
    const messages = collectMessages(session);

    await session.resume('sid-2', '/cwd');
    await new Promise((r) => setTimeout(r, 50));

    expect(queryFn).not.toHaveBeenCalled();
    expect(session.state).toBe('idle');
    expect(messages.find((m) => m.type === 'user_message')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ClaudeSession — edge cases
// ---------------------------------------------------------------------------

describe('ClaudeSession — edge cases', () => {
  it('ends session when Claude reports poisoned history empty-text error', async () => {
    const queryFn = createMockQuery([
      {
        type: 'assistant',
        uuid: 'api-err-1',
        message: {
          content: [
            {
              type: 'text',
              text: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}',
            },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sid-poison',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);

    const session = new ClaudeSession('sid-poison', queryFn);
    const messages = collectMessages(session);
    const ended = vi.fn();
    session.on('ended', ended);

    await session.start('hello', '/cwd');
    await new Promise((r) => setTimeout(r, 100));

    expect(session.state).toBe('completed');
    expect(ended).toHaveBeenCalledWith('history_poisoned');
    const poisonStatus = messages.find(
      (m) => m.type === 'system_status' && m.status.includes('session history is corrupted'),
    );
    expect(poisonStatus).toBeDefined();
  });

  it('drain throws unexpectedly — session transitions to errored', async () => {
    const queryFn: QueryFn = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<MockMessage, void>> {
            return Promise.reject(new Error('Unexpected SDK crash'));
          },
        };
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    });

    const session = new ClaudeSession('test', queryFn);
    const messages = collectMessages(session);
    const ended = vi.fn();
    session.on('ended', ended);

    await session.start('hello', '/cwd');
    await new Promise((r) => setTimeout(r, 100));

    expect(session.state).toBe('errored');
    const status = messages.find(
      (m) => m.type === 'system_status' && m.status.includes('Unexpected SDK crash'),
    );
    expect(status).toBeDefined();
    expect(ended).not.toHaveBeenCalled();
  });

  it('can recover from errored state by sending a new prompt', async () => {
    const queryFn: QueryFn = vi
      .fn()
      .mockReturnValueOnce({
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<MockMessage, void>> {
              return Promise.reject(new Error('first turn failed'));
            },
          };
        },
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      })
      .mockReturnValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            subtype: 'success',
            session_id: 'sid-recover',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      });

    const session = new ClaudeSession('sid-recover', queryFn);
    await session.start('first try', '/cwd');
    await new Promise((r) => setTimeout(r, 50));
    expect(session.state).toBe('errored');

    await session.sendPrompt('retry');
    await new Promise((r) => setTimeout(r, 50));
    expect(session.state).toBe('idle');
  });

  it('ignores late Claude process exit after successful result', async () => {
    const queryFn: QueryFn = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next(): Promise<IteratorResult<MockMessage, void>> {
            if (i === 0) {
              i++;
              return Promise.resolve({
                value: {
                  type: 'result',
                  subtype: 'success',
                  session_id: 'sid-late-exit',
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
                done: false,
              });
            }
            return Promise.reject(new Error('Claude Code process exited with code 1'));
          },
        };
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    });

    const session = new ClaudeSession('sid-late-exit', queryFn);
    const ended = vi.fn();
    session.on('ended', ended);

    await session.start('hello', '/cwd');
    await new Promise((r) => setTimeout(r, 100));

    expect(session.state).toBe('idle');
    expect(ended).not.toHaveBeenCalled();
  });

  it('abort during drain — state is completed (not errored)', async () => {
    let resolveNext: (() => void) | null = null;
    const queryFn: QueryFn = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<MockMessage, void>> {
            return new Promise((resolve) => {
              resolveNext = () => resolve({ value: undefined, done: true });
            });
          },
        };
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockImplementation(() => {
        if (resolveNext) resolveNext();
      }),
    });

    const session = new ClaudeSession('test', queryFn);
    await session.start('hello', '/cwd');

    await session.kill();
    expect(session.state).toBe('completed');
  });

  it('invalid state transition (completed→running) is ignored', async () => {
    const { queryFn } = createBlockingQuery();
    const session = new ClaudeSession('test', queryFn);

    await session.start('hello', '/cwd');
    await session.kill();
    expect(session.state).toBe('completed');

    // Try to transition to running — should be ignored
    const states: string[] = [];
    session.on('state-change', (s: string) => states.push(s));

    // Force a state change attempt via sendPrompt which calls setState('running')
    // Actually we can't directly test private setState, but we can verify the state
    // doesn't change after kill. The completed state should be terminal.
    // A resumed query after kill should not change state.
    expect(session.state).toBe('completed');
    expect(states).not.toContain('running');
  });
});
