/**
 * CodexAdapter — bridges OpenAI Codex SDK threads with the Viewport daemon.
 *
 * This integration intentionally stays loose at the SDK boundary (unknown payload
 * shapes) so daemon builds remain stable as SDK response schemas evolve.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AgentAdapter, Session, SessionOptions } from '../core/interfaces.js';
import type { SessionMessage, SessionState } from '../core/types.js';
import { metrics } from '../core/metrics.js';
import { importCodexSdkModule } from './codex-sdk-loader.js';
import { DEFAULT_CODEX_MODEL } from '../agents/codex-defaults.js';
import {
  extractEventsStream,
  extractStreamError,
  extractStreamText,
  extractText,
  extractTokenUsageEvent,
  extractToolCallEvent,
  extractToolCallUpdateEvent,
  shouldFallbackToLegacyRun,
} from './codex-event-normalizers.js';

interface CodexThread {
  id?: string;
  run?: (input: unknown, turnOptions?: Record<string, unknown>) => Promise<unknown>;
  runStreamed?: (
    input: unknown,
    turnOptions?: Record<string, unknown>,
  ) => Promise<unknown> | AsyncIterable<unknown>;
}

interface CodexClient {
  startThread: (params?: Record<string, unknown>) => CodexThread | Promise<CodexThread>;
  resumeThread?: (
    threadId: string,
    params?: Record<string, unknown>,
  ) => CodexThread | Promise<CodexThread>;
  getThread?: (threadId: string) => CodexThread | Promise<CodexThread>;
}

type CodexClientFactory = (apiKey?: string) => Promise<CodexClient>;

async function defaultClientFactory(apiKey?: string): Promise<CodexClient> {
  const loaded = await importCodexSdkModule();
  if (!loaded?.module.Codex) {
    throw new Error(
      'Codex SDK import failed: install @openai/codex-sdk@latest (or @openai/codex@latest)',
    );
  }
  return new loaded.module.Codex({
    apiKey,
    config: {
      model: DEFAULT_CODEX_MODEL,
    },
  });
}

export class CodexSession extends EventEmitter implements Session {
  readonly id: string;
  state: SessionState = 'starting';

  private readonly thread: CodexThread;
  private readonly cwd: string;
  private readonly model?: string;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(params: { sessionId: string; thread: CodexThread; cwd: string; model?: string }) {
    super();
    this.id = params.sessionId;
    this.thread = params.thread;
    this.cwd = params.cwd;
    this.model = params.model;
  }

  async start(initialPrompt: string): Promise<void> {
    this.setState('running');
    if (initialPrompt.trim()) {
      await this.sendPrompt(initialPrompt);
    } else {
      this.setState('idle');
    }
  }

  async sendPrompt(text: string): Promise<void> {
    if (this.stopped) throw new Error('Session already ended');

    this.chain = this.chain.then(async () => {
      if (this.stopped) return;
      const now = Date.now();
      this.setState('running');
      this.emitMessage({
        type: 'user_message',
        text,
        messageId: randomUUID(),
        timestamp: now,
      });

      const chunkMessageId = randomUUID();
      let aggregated = '';

      if (typeof this.thread.runStreamed === 'function') {
        for await (const chunk of this.runStreamed(text)) {
          const toolCall = extractToolCallEvent(chunk);
          if (toolCall) this.emitMessage(toolCall);
          const toolUpdate = extractToolCallUpdateEvent(chunk);
          if (toolUpdate) this.emitMessage(toolUpdate);
          const usage = extractTokenUsageEvent(chunk);
          if (usage) this.emitMessage(usage);
          const textChunk = extractStreamText(chunk);
          if (!textChunk) continue;
          aggregated += textChunk;
          this.emitMessage({
            type: 'agent_message_chunk',
            text: textChunk,
            messageId: chunkMessageId,
            timestamp: Date.now(),
          });
        }
      } else if (typeof this.thread.run === 'function') {
        const result = await this.run(text);
        aggregated = extractText(result);
      } else {
        throw new Error('Codex thread does not expose run or runStreamed');
      }

      if (aggregated.trim()) {
        this.emitMessage({
          type: 'agent_message',
          text: aggregated,
          messageId: chunkMessageId,
          timestamp: Date.now(),
        });
      }

      this.setState('idle');
    });

    try {
      await this.chain;
    } catch (err) {
      metrics.increment('sessions.errors');
      this.setState('errored');
      this.emit('ended', `error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async kill(): Promise<void> {
    this.stopped = true;
    this.setState('completed');
    this.emit('ended', 'killed');
  }

  private emitMessage(msg: SessionMessage): void {
    this.emit('message', msg);
  }

  private setState(next: SessionState): void {
    this.state = next;
    this.emit('state-change', next);
  }

  private async *runStreamed(text: string): AsyncGenerator<unknown> {
    if (typeof this.thread.runStreamed !== 'function') return;

    const modern = await this.thread.runStreamed(text);
    const modernEvents = extractEventsStream(modern);
    if (modernEvents) {
      for await (const event of modernEvents) {
        const failure = extractStreamError(event);
        if (failure) throw new Error(failure);
        yield event;
      }
      return;
    }

    const legacyInput = this.buildLegacyInput(text);
    const legacy = await this.thread.runStreamed(legacyInput);
    const legacyEvents = extractEventsStream(legacy);
    if (legacyEvents) {
      for await (const event of legacyEvents) {
        const failure = extractStreamError(event);
        if (failure) throw new Error(failure);
        yield event;
      }
      return;
    }

    throw new Error('Codex runStreamed did not return an async event stream');
  }

  private async run(text: string): Promise<unknown> {
    if (typeof this.thread.run !== 'function') {
      throw new Error('Codex thread does not expose run');
    }

    try {
      return await this.thread.run(text);
    } catch (err) {
      if (!shouldFallbackToLegacyRun(err)) throw err;
      const legacyInput = this.buildLegacyInput(text);
      return this.thread.run(legacyInput);
    }
  }

  private buildLegacyInput(text: string): Record<string, unknown> {
    const input: Record<string, unknown> = {
      input: text,
      cwd: this.cwd,
    };
    if (this.model) input['model'] = this.model;
    return input;
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly agentId = 'codex';

  constructor(
    private readonly createClient: CodexClientFactory = defaultClientFactory,
    private readonly apiKey?: string,
  ) {}

  async startSession(cwd: string, options?: SessionOptions): Promise<Session> {
    metrics.increment('sessions.codex.started');
    const client = await this.createClient(this.apiKey);
    const thread = await this.createThread(client, cwd, options);
    const sessionId = typeof thread.id === 'string' && thread.id ? thread.id : randomUUID();
    const session = new CodexSession({
      sessionId,
      thread,
      cwd,
      model: options?.model,
    });
    await session.start(options?.deferInitialPrompt ? '' : (options?.initialPrompt ?? ''));
    return session;
  }

  async resumeSession(sessionId: string, cwd: string, options?: SessionOptions): Promise<Session> {
    metrics.increment('sessions.codex.resumed');
    const client = await this.createClient(this.apiKey);
    const thread = await this.resolveResumeThread(client, sessionId, cwd, options);
    const session = new CodexSession({
      sessionId,
      thread,
      cwd,
      model: options?.model,
    });
    await session.start(options?.deferInitialPrompt ? '' : (options?.initialPrompt ?? 'Continue.'));
    return session;
  }

  private async resolveResumeThread(
    client: CodexClient,
    sessionId: string,
    cwd: string,
    options?: SessionOptions,
  ): Promise<CodexThread> {
    if (typeof client.resumeThread === 'function') {
      const params = this.buildThreadOptions(cwd, options);
      try {
        return await Promise.resolve(client.resumeThread(sessionId, params.modern));
      } catch {
        return Promise.resolve(client.resumeThread(sessionId, params.legacy));
      }
    }

    if (typeof client.getThread === 'function') {
      return Promise.resolve(client.getThread(sessionId));
    }

    // Compatibility fallback for SDK variants lacking explicit resume methods.
    const params = this.buildThreadOptions(cwd, options);
    return Promise.resolve(
      client.startThread({
        ...params.modern,
        ...params.legacy,
        threadId: sessionId,
        sessionId,
        resume: true,
      }),
    );
  }

  private async createThread(
    client: CodexClient,
    cwd: string,
    options?: SessionOptions,
  ): Promise<CodexThread> {
    const params = this.buildThreadOptions(cwd, options);
    try {
      return await Promise.resolve(client.startThread(params.modern));
    } catch {
      return Promise.resolve(client.startThread(params.legacy));
    }
  }

  private buildThreadOptions(
    cwd: string,
    options?: SessionOptions,
  ): { modern: Record<string, unknown>; legacy: Record<string, unknown> } {
    const model = options?.model ?? DEFAULT_CODEX_MODEL;
    const modern: Record<string, unknown> = {
      workingDirectory: cwd,
      // Daemon sessions run in ephemeral worktrees that may not be pre-trusted by Codex CLI.
      // Avoid hard startup failure on trust-gate checks for these managed directories.
      skipGitRepoCheck: true,
    };
    const legacy: Record<string, unknown> = {
      cwd,
      skipGitRepoCheck: true,
    };
    if (model) {
      modern['model'] = model;
      legacy['model'] = model;
    }
    if (options?.canUseTool) {
      modern['canUseTool'] = options.canUseTool;
      legacy['canUseTool'] = options.canUseTool;
    }
    if (options?.config?.trust) {
      modern['trustMode'] = options.config.trust;
      legacy['trustMode'] = options.config.trust;
    }
    return { modern, legacy };
  }
}
