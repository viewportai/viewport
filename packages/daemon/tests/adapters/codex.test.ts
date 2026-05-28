import { describe, it, expect, vi } from 'vitest';
import { CodexAdapter, resolveCodexPathOverride } from '../../src/adapters/codex.js';
import { DEFAULT_CODEX_MODEL } from '../../src/agents/codex-defaults.js';
import type { SessionMessage } from '../../src/core/types.js';

describe('CodexAdapter', () => {
  it('resolves Codex executable like the Codex app bridge', () => {
    expect(resolveCodexPathOverride({ CODEX_CLI_PATH: '/custom/codex' })).toBe('/custom/codex');
    expect(resolveCodexPathOverride({})).toMatch(
      /^(codex|\/Applications\/Codex\.app\/Contents\/Resources\/codex)$/,
    );
  });

  it('streams chunks and emits final message for modern runStreamed() result.events', async () => {
    const runStreamed = vi.fn().mockResolvedValue({
      events: (async function* () {
        yield { type: 'item.updated', item: { type: 'agent_message', text: 'Hello ' } };
        yield { type: 'item.completed', item: { type: 'agent_message', text: 'world' } };
      })(),
    });

    const createClient = vi.fn().mockResolvedValue({
      startThread: vi.fn().mockReturnValue({
        id: 'codex-stream-1',
        runStreamed,
      }),
      resumeThread: vi.fn(),
    });

    const adapter = new CodexAdapter(createClient);
    const session = await adapter.startSession('/tmp/project');
    const messages: SessionMessage[] = [];
    session.on('message', (m: SessionMessage) => messages.push(m));

    await session.sendPrompt('ship it');

    expect(runStreamed).toHaveBeenCalledWith('ship it');
    expect(messages.some((m) => m.type === 'user_message' && m.text === 'ship it')).toBe(true);
    expect(
      messages
        .filter((m) => m.type === 'agent_message_chunk')
        .map((m) => m.text)
        .join(''),
    ).toBe('Hello world');
    expect(messages.some((m) => m.type === 'agent_message' && m.text === 'Hello world')).toBe(true);
  });

  it('uses run fallback and model override when stream API is unavailable', async () => {
    const run = vi.fn().mockResolvedValue({
      finalResponse: 'done',
    });
    const startThread = vi.fn().mockReturnValue({
      id: 'codex-run-1',
      run,
    });
    const createClient = vi.fn().mockResolvedValue({
      startThread,
      resumeThread: vi.fn(),
    });

    const adapter = new CodexAdapter(createClient);
    const session = await adapter.startSession('/tmp/project', {
      model: 'gpt-5-codex',
      initialPrompt: 'initial',
    });

    expect(startThread).toHaveBeenCalledWith({
      workingDirectory: '/tmp/project',
      model: 'gpt-5-codex',
      skipGitRepoCheck: true,
    });
    expect(run).toHaveBeenCalledWith('initial');

    await session.kill();
  });

  it('uses the Viewport Codex model default instead of silently inheriting user Codex config', async () => {
    const startThread = vi.fn().mockReturnValue({
      id: 'codex-default-model',
      run: vi.fn().mockResolvedValue({ finalResponse: 'done' }),
    });
    const createClient = vi.fn().mockResolvedValue({
      startThread,
      resumeThread: vi.fn(),
    });

    const adapter = new CodexAdapter(createClient);
    await adapter.startSession('/tmp/project');

    expect(startThread).toHaveBeenCalledWith({
      workingDirectory: '/tmp/project',
      model: DEFAULT_CODEX_MODEL,
      skipGitRepoCheck: true,
    });
  });

  it('passes configured sandbox and approval posture to Codex threads', async () => {
    const startThread = vi.fn().mockReturnValue({
      id: 'codex-writable-thread',
      run: vi.fn().mockResolvedValue({ finalResponse: 'done' }),
    });
    const createClient = vi.fn().mockResolvedValue({
      startThread,
      resumeThread: vi.fn(),
    });

    const adapter = new CodexAdapter(createClient);
    await adapter.startSession('/tmp/project', {
      config: {
        agent: 'codex',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
      } as never,
    });

    expect(startThread).toHaveBeenCalledWith({
      workingDirectory: '/tmp/project',
      model: DEFAULT_CODEX_MODEL,
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });
  });

  it('resumeSession defaults prompt to Continue and uses resumeThread when available', async () => {
    const run = vi.fn().mockResolvedValue('continuing');
    const resumeThread = vi.fn().mockReturnValue({ id: 'codex-resume-1', run });
    const createClient = vi.fn().mockResolvedValue({
      startThread: vi.fn(),
      resumeThread,
    });

    const adapter = new CodexAdapter(createClient);
    await adapter.resumeSession('codex-resume-1', '/tmp/project');

    expect(resumeThread).toHaveBeenCalledWith('codex-resume-1', {
      workingDirectory: '/tmp/project',
      model: DEFAULT_CODEX_MODEL,
      skipGitRepoCheck: true,
    });
    expect(run).toHaveBeenCalledWith('Continue.');
  });

  it('resumeSession with deferred initial prompt stays idle until a real prompt is sent', async () => {
    const run = vi.fn().mockResolvedValue('continuing');
    const resumeThread = vi.fn().mockReturnValue({ id: 'codex-resume-deferred', run });
    const createClient = vi.fn().mockResolvedValue({
      startThread: vi.fn(),
      resumeThread,
    });

    const adapter = new CodexAdapter(createClient);
    const session = await adapter.resumeSession('codex-resume-deferred', '/tmp/project', {
      deferInitialPrompt: true,
    });

    expect(session.state).toBe('idle');
    expect(resumeThread).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    await session.sendPrompt('continue now');

    expect(resumeThread).toHaveBeenCalledWith('codex-resume-deferred', {
      workingDirectory: '/tmp/project',
      model: DEFAULT_CODEX_MODEL,
      skipGitRepoCheck: true,
    });
    expect(run).toHaveBeenCalledWith('continue now');
  });

  it('resumeSession falls back to getThread when resumeThread is unavailable', async () => {
    const run = vi.fn().mockResolvedValue('continuing');
    const getThread = vi.fn().mockReturnValue({ id: 'codex-resume-2', run });
    const createClient = vi.fn().mockResolvedValue({
      startThread: vi.fn(),
      getThread,
    });

    const adapter = new CodexAdapter(createClient);
    await adapter.resumeSession('codex-resume-2', '/tmp/project');

    expect(getThread).toHaveBeenCalledWith('codex-resume-2');
    expect(run).toHaveBeenCalledWith('Continue.');
  });

  it('falls back to legacy run(params) when run(text) throws argument-shape errors', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('invalid input shape'))
      .mockResolvedValueOnce({ output: [{ text: 'legacy ok' }] });
    const createClient = vi.fn().mockResolvedValue({
      startThread: vi.fn().mockReturnValue({
        id: 'codex-legacy-1',
        run,
      }),
      resumeThread: vi.fn(),
    });

    const adapter = new CodexAdapter(createClient);
    const session = await adapter.startSession('/tmp/project');
    await session.sendPrompt('legacy prompt');

    expect(run).toHaveBeenNthCalledWith(1, 'legacy prompt');
    expect(run).toHaveBeenNthCalledWith(2, {
      input: 'legacy prompt',
      cwd: '/tmp/project',
    });
  });

  it('transitions session to errored and emits ended when run fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'));
    const createClient = vi.fn().mockResolvedValue({
      startThread: vi.fn().mockReturnValue({
        id: 'codex-error-1',
        run,
      }),
      resumeThread: vi.fn(),
    });

    const adapter = new CodexAdapter(createClient);
    const session = await adapter.startSession('/tmp/project');
    const ended = vi.fn();
    session.on('ended', ended);

    await expect(session.sendPrompt('trigger failure')).rejects.toThrow('boom');
    expect(session.state).toBe('errored');
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('emits tool and usage updates from streamed event payloads', async () => {
    const runStreamed = vi.fn().mockResolvedValue({
      events: (async function* () {
        yield {
          type: 'item.started',
          item: {
            type: 'function_call',
            id: 'tool-1',
            name: 'Bash',
            arguments: { command: 'echo hi' },
          },
        };
        yield {
          type: 'item.completed',
          item: {
            type: 'function_call',
            id: 'tool-1',
            name: 'Bash',
            result: 'ok',
          },
        };
        yield {
          type: 'turn.completed',
          usage: {
            input_tokens: 110,
            output_tokens: 20,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 5,
          },
          total_cost_usd: 0.0012,
          duration_ms: 1200,
          num_turns: 1,
          modelUsage: {
            'gpt-5-codex': {
              inputTokens: 110,
              outputTokens: 20,
              cacheReadInputTokens: 100,
              cacheCreationInputTokens: 5,
              costUSD: 0.0012,
            },
          },
        };
      })(),
    });

    const createClient = vi.fn().mockResolvedValue({
      startThread: vi.fn().mockReturnValue({
        id: 'codex-tool-1',
        runStreamed,
      }),
      resumeThread: vi.fn(),
    });

    const adapter = new CodexAdapter(createClient);
    const session = await adapter.startSession('/tmp/project');
    const messages: SessionMessage[] = [];
    session.on('message', (m: SessionMessage) => messages.push(m));

    await session.sendPrompt('run tool');

    expect(messages.some((m) => m.type === 'tool_call')).toBe(true);
    expect(messages.some((m) => m.type === 'tool_call_update')).toBe(true);
    expect(messages.find((m) => m.type === 'token_usage')).toMatchObject({
      type: 'token_usage',
      inputTokens: 110,
      inputTokenScope: 'billable',
      outputTokens: 20,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 5,
      billableInputTokens: 10,
      budgetedTotalTokens: 30,
      totalCostUsd: 0.0012,
      durationMs: 1200,
      numTurns: 1,
      modelUsage: {
        'gpt-5-codex': {
          inputTokens: 110,
          outputTokens: 20,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 5,
          costUsd: 0.0012,
        },
      },
    });
  });

  it('emits token usage from non-streamed Codex result envelopes', async () => {
    const run = vi.fn().mockResolvedValue({
      type: 'result',
      result: 'done',
      usage: {
        input_tokens: 210,
        output_tokens: 15,
        cache_read_input_tokens: 200,
      },
      total_cost_usd: 0.002,
    });
    const createClient = vi.fn().mockResolvedValue({
      startThread: vi.fn().mockReturnValue({
        id: 'codex-result-usage',
        run,
      }),
      resumeThread: vi.fn(),
    });

    const adapter = new CodexAdapter(createClient);
    const session = await adapter.startSession('/tmp/project');
    const messages: SessionMessage[] = [];
    session.on('message', (m: SessionMessage) => messages.push(m));

    await session.sendPrompt('summarize');

    expect(messages.find((m) => m.type === 'token_usage')).toMatchObject({
      type: 'token_usage',
      inputTokens: 210,
      inputTokenScope: 'billable',
      outputTokens: 15,
      cacheReadInputTokens: 200,
      billableInputTokens: 10,
      budgetedTotalTokens: 25,
      totalCostUsd: 0.002,
    });
  });

  it('marks Codex usage without cache accounting as raw provider input', async () => {
    const runStreamed = vi.fn().mockResolvedValue({
      events: (async function* () {
        yield {
          type: 'turn.completed',
          usage: {
            input_tokens: 880000,
            output_tokens: 7000,
          },
        };
      })(),
    });
    const createClient = vi.fn().mockResolvedValue({
      startThread: vi.fn().mockReturnValue({
        id: 'codex-raw-provider-usage',
        runStreamed,
      }),
      resumeThread: vi.fn(),
    });

    const adapter = new CodexAdapter(createClient);
    const session = await adapter.startSession('/tmp/project');
    const messages: SessionMessage[] = [];
    session.on('message', (m: SessionMessage) => messages.push(m));

    await session.sendPrompt('plan');

    expect(messages.find((m) => m.type === 'token_usage')).toMatchObject({
      type: 'token_usage',
      inputTokens: 880000,
      inputTokenScope: 'raw_provider',
      outputTokens: 7000,
      budgetedTotalTokens: 7000,
    });
  });

  it('passes canUseTool and trust mode into thread creation options', async () => {
    const startThread = vi.fn().mockReturnValue({
      id: 'codex-opt-1',
      run: vi.fn().mockResolvedValue('ok'),
    });

    const createClient = vi.fn().mockResolvedValue({
      startThread,
      resumeThread: vi.fn(),
    });

    const adapter = new CodexAdapter(createClient);
    const canUseTool = vi.fn().mockResolvedValue({ behavior: 'allow' });
    await adapter.startSession('/tmp/project', {
      initialPrompt: 'hello',
      model: 'gpt-5-codex',
      canUseTool,
      config: {
        agent: 'codex',
        model: 'gpt-5-codex',
        trust: 'automated',
        gitTracker: {
          enabled: false,
          commitOn: [],
          ignore: [],
          autoSquashOnComplete: false,
          branchPrefix: 'viewport/',
          commitAuthor: 'Viewport <noreply@example.test>',
          maxCommitsPerSession: 10,
          worktreeRoot: '.viewport/worktrees',
        },
        permissions: { autoApprove: [], requireApproval: ['*'], deny: [] },
      },
    });

    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: '/tmp/project',
        model: 'gpt-5-codex',
        canUseTool,
        trustMode: 'automated',
        skipGitRepoCheck: true,
      }),
    );
  });
});
