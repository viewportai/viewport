/**
 * ClaudeAdapter — bridges the Claude Agent SDK with the Viewport daemon.
 *
 * Uses the SDK's `query()` function to start/resume sessions, normalizes
 * SDK messages into Viewport's SessionMessage format, and handles the
 * permission flow by bridging SDK's `canUseTool` callback to the daemon's
 * event-based permission system.
 */

import { EventEmitter } from 'node:events';
import type {
  AgentAdapter,
  Session,
  SessionOptions,
  PermissionHandler,
  PermissionContext,
} from '../core/interfaces.js';
import type { SessionState, SessionMessage } from '../core/types.js';
import { toToolCallDetail } from '../core/types.js';
import { logger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';

const log = logger.child({ module: 'claude' });

// ---------------------------------------------------------------------------
// SDK type stubs — minimal shapes to avoid importing the full SDK at type level
// ---------------------------------------------------------------------------

/** Minimal shape of the SDK's query() return value. */
interface SDKQuery {
  [Symbol.asyncIterator](): AsyncIterator<SDKRawMessage, void>;
  interrupt(): Promise<void>;
  close(): void;
}

/**
 * Minimal shape of SDK messages we need to handle.
 * The actual SDK has 22+ message types — we normalize the ones we care about.
 */
interface SDKRawMessage {
  type: string;
  subtype?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK messages are untyped at our boundary
  [key: string]: any;
}

/** SDK's canUseTool callback signature. */
type SDKCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    toolUseID: string;
    decisionReason?: string;
    blockedPath?: string;
    agentID?: string;
  },
) => Promise<SDKPermissionResult>;

interface SDKPermissionResult {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

/** Shape of query() function. */
export type QueryFn = (params: {
  prompt: string;
  options?: {
    cwd?: string;
    model?: string;
    resume?: string;
    sessionId?: string;
    canUseTool?: SDKCanUseTool;
    allowedTools?: string[];
    maxTurns?: number;
    maxBudgetUsd?: number;
    abortController?: AbortController;
    systemPrompt?: string;
    permissionMode?: string;
    persistSession?: boolean;
  };
}) => SDKQuery;

// ---------------------------------------------------------------------------
// ClaudeSession
// ---------------------------------------------------------------------------

export class ClaudeSession extends EventEmitter implements Session {
  readonly id: string;
  state: SessionState = 'starting';

  private query: SDKQuery | null = null;
  private abortController: AbortController;
  private drainPromise: Promise<void> | null = null;
  private cwd: string = '';
  private resumedContext = false;
  private pendingMessages: SessionMessage[] = [];
  private pendingFlushScheduled = false;
  private endedForPoisonedHistory = false;

  constructor(
    sessionId: string,
    private queryFn: QueryFn,
    private canUseTool?: PermissionHandler,
  ) {
    super();
    this.id = sessionId;
    this.abortController = new AbortController();
    this.on('newListener', (eventName) => {
      if (eventName !== 'message') return;
      this.schedulePendingFlush();
    });
    log.debug({ sessionId }, 'ClaudeSession created');
  }

  /** Start the session with an initial prompt. */
  async start(prompt: string, cwd: string, options?: SessionOptions): Promise<void> {
    log.info({ sessionId: this.id, cwd, promptLen: prompt.length }, 'session.start');
    metrics.increment('sessions.launched');
    this.cwd = cwd;
    this.resumedContext = false;
    const initialPrompt = prompt.trim();
    if (initialPrompt.length === 0) {
      this.setState('idle');
      return;
    }

    this.emitLocalUserPrompt(initialPrompt);
    this.query = this.queryFn({
      prompt: initialPrompt,
      options: {
        cwd,
        model: options?.model,
        sessionId: this.id,
        canUseTool: this.canUseTool ? this.wrapCanUseTool(this.canUseTool) : undefined,
        abortController: this.abortController,
        persistSession: true,
      },
    });

    this.setState('running');
    this.drainPromise = this.drainMessages().catch((err) => {
      log.error({ sessionId: this.id, err }, 'Unhandled drain error');
    });
  }

  /** Resume an existing session. */
  async resume(sessionId: string, cwd: string, options?: SessionOptions): Promise<void> {
    log.info({ sessionId, cwd, hasPrompt: !!options?.initialPrompt }, 'session.resume');
    const explicitPrompt = options?.initialPrompt?.trim() ?? '';
    this.cwd = cwd;
    this.resumedContext = true;

    if (explicitPrompt.length === 0) {
      this.setState('idle');
      return;
    }
    this.emitLocalUserPrompt(explicitPrompt);
    this.query = this.queryFn({
      prompt: explicitPrompt,
      options: {
        cwd,
        model: options?.model,
        resume: sessionId,
        canUseTool: this.canUseTool ? this.wrapCanUseTool(this.canUseTool) : undefined,
        abortController: this.abortController,
        persistSession: true,
      },
    });

    this.setState('running');
    this.drainPromise = this.drainMessages().catch((err) => {
      log.error({ sessionId: this.id, err }, 'Unhandled drain error');
    });
  }

  async sendPrompt(text: string): Promise<void> {
    log.info(
      { sessionId: this.id, state: this.state, textLen: text.length, hasQuery: !!this.query },
      'sendPrompt called',
    );

    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new Error('Prompt text must be non-empty');
    }

    if (!this.query) {
      this.emitLocalUserPrompt(trimmed);
      this.abortController = new AbortController();
      this.query = this.queryFn({
        prompt: trimmed,
        options: {
          cwd: this.cwd,
          ...(this.resumedContext ? { resume: this.id } : { sessionId: this.id }),
          canUseTool: this.canUseTool ? this.wrapCanUseTool(this.canUseTool) : undefined,
          abortController: this.abortController,
          persistSession: true,
        },
      });
      this.setState('running');
      this.drainPromise = this.drainMessages().catch((err) => {
        log.error({ sessionId: this.id, err }, 'Unhandled drain error');
      });
      return;
    }

    this.emitLocalUserPrompt(trimmed);

    const hasInflightTurn =
      this.state === 'running' || this.state === 'waiting_permission' || this.state === 'starting';
    if (hasInflightTurn) {
      // If a turn is still inflight, interrupt and wait for drain to settle.
      try {
        log.debug({ sessionId: this.id }, 'sendPrompt: interrupting inflight query');
        await this.query.interrupt();
      } catch (err) {
        log.warn({ sessionId: this.id, err }, 'sendPrompt: interrupt() threw (ignoring)');
      }

      if (this.drainPromise) {
        log.debug({ sessionId: this.id }, 'sendPrompt: waiting for drain to finish');
        await this.drainPromise;
        log.debug({ sessionId: this.id }, 'sendPrompt: drain finished');
      }
    }

    // Fresh AbortController for the new query — the old one may be aborted
    this.abortController = new AbortController();

    log.info({ sessionId: this.id, cwd: this.cwd }, 'sendPrompt: creating new resumed query');
    this.query = this.queryFn({
      prompt: trimmed,
      options: {
        cwd: this.cwd,
        resume: this.id,
        canUseTool: this.canUseTool ? this.wrapCanUseTool(this.canUseTool) : undefined,
        abortController: this.abortController,
        persistSession: true,
      },
    });

    this.setState('running');
    this.drainPromise = this.drainMessages().catch((err) => {
      log.error({ sessionId: this.id, err }, 'Unhandled drain error');
    });
    log.debug({ sessionId: this.id }, 'sendPrompt: new drain started');
  }

  async kill(): Promise<void> {
    log.info({ sessionId: this.id }, 'session.kill');
    this.abortController.abort();
    if (this.query) {
      this.query.close();
    }
    this.setState('completed');
    this.emit('ended', 'killed');
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async drainMessages(): Promise<void> {
    if (!this.query) return;

    log.debug({ sessionId: this.id }, 'drainMessages: starting');
    let msgCount = 0;
    let sawSuccessfulResult = false;

    try {
      for await (const msg of this.query) {
        msgCount++;
        if (msg.type === 'result' && msg.subtype === 'success') {
          sawSuccessfulResult = true;
        }
        const normalized = this.normalizeMessage(msg as SDKRawMessage);
        if (normalized) {
          for (const m of normalized) {
            this.emitSessionMessage(m);
          }
        }
      }
      log.debug({ sessionId: this.id, msgCount }, 'drainMessages: generator exhausted');
      // Generator completed — session turn is done. Stay idle for follow-ups.
      // normalizeResultMessage already sets state to idle or errored.
      // Only set idle here if result message wasn't received (edge case).
      if (this.state === 'running' || this.state === 'starting') {
        this.setState('idle');
      }
    } catch (err) {
      if (this.abortController.signal.aborted) {
        log.debug({ sessionId: this.id, msgCount }, 'drainMessages: aborted (expected)');
        return;
      }
      const errMessage = err instanceof Error ? err.message : String(err);
      const lateProcessExitAfterSuccess =
        sawSuccessfulResult && /^Claude Code process exited with code \d+$/.test(errMessage.trim());
      if (lateProcessExitAfterSuccess) {
        log.warn(
          { sessionId: this.id, msgCount, errMessage },
          'Ignoring late Claude process exit after successful turn',
        );
        return;
      }
      log.error({ sessionId: this.id, err, msgCount }, 'drainMessages: unexpected error');
      metrics.increment('sessions.errors');
      this.emitSessionMessage({
        type: 'system_status',
        status: `error: ${errMessage}`,
        sessionId: this.id,
        timestamp: Date.now(),
      });
      this.setState('errored');
    }
  }

  /**
   * Normalize SDK messages into Viewport SessionMessage types.
   * Returns null for messages we don't care about.
   */
  private normalizeMessage(msg: SDKRawMessage): SessionMessage[] | null {
    const now = Date.now();

    switch (msg.type) {
      case 'system':
        return this.normalizeSystemMessage(msg, now);

      case 'assistant':
        return this.normalizeAssistantMessage(msg, now);

      case 'user':
        return this.normalizeUserMessage(msg, now);

      case 'stream_event':
        return this.normalizeStreamEvent(msg, now);

      case 'result':
        return this.normalizeResultMessage(msg, now);

      case 'tool_progress':
        return [
          {
            type: 'tool_call_update',
            toolCallId: msg.tool_use_id ?? 'unknown',
            toolName: msg.tool_name,
            status: 'completed',
            title: `Progress: ${msg.elapsed_time_seconds}s`,
            timestamp: now,
          },
        ];

      default:
        return null;
    }
  }

  private normalizeSystemMessage(msg: SDKRawMessage, now: number): SessionMessage[] | null {
    switch (msg.subtype) {
      case 'init':
        return [
          {
            type: 'system_status',
            status: 'initialized',
            sessionId: msg.session_id ?? this.id,
            timestamp: now,
          },
        ];

      case 'status':
        return [
          {
            type: 'system_status',
            status: msg.status ?? 'unknown',
            sessionId: this.id,
            timestamp: now,
          },
        ];

      default:
        return null;
    }
  }

  private normalizeAssistantMessage(msg: SDKRawMessage, now: number): SessionMessage[] | null {
    // Skip replay messages from session history (same as normalizeUserMessage)
    if (msg.isReplay) return null;

    const betaMessage = msg.message;
    if (!betaMessage?.content) return null;

    const messages: SessionMessage[] = [];

    for (const block of betaMessage.content) {
      if (block.type === 'text') {
        const text = typeof block.text === 'string' ? block.text : '';
        if (text.length === 0) continue;
        messages.push({
          type: 'agent_message',
          text,
          messageId: msg.uuid ?? `msg-${now}`,
          timestamp: now,
        });
        if (this.isPoisonedHistoryApiError(text) && !this.endedForPoisonedHistory) {
          messages.push({
            type: 'system_status',
            status: 'error: session history is corrupted (empty text block). Start a new session.',
            sessionId: this.id,
            timestamp: now,
          });
          queueMicrotask(() => {
            this.endPoisonedHistorySession();
          });
        }
      } else if (block.type === 'thinking') {
        messages.push({
          type: 'agent_thought_chunk',
          text: block.thinking ?? '',
          messageId: msg.uuid ?? `thought-${now}`,
          timestamp: now,
        });
      } else if (block.type === 'tool_use') {
        const input = block.input as Record<string, unknown>;
        messages.push({
          type: 'tool_call',
          toolCallId: block.id,
          toolName: block.name,
          title: block.name,
          input,
          detail: toToolCallDetail(block.name, input),
          status: 'in_progress',
          timestamp: now,
        });
      }
    }

    return messages.length > 0 ? messages : null;
  }

  /**
   * Normalize SDK 'user' messages — these carry tool results.
   *
   * The SDK sends tool execution results as user messages with a
   * `tool_use_result` field containing the output, and the `message.content`
   * array contains `tool_result` blocks.
   */
  private normalizeUserMessage(msg: SDKRawMessage, now: number): SessionMessage[] | null {
    // Skip replay messages from session history
    if (msg.isReplay) return null;

    const messages: SessionMessage[] = [];
    const content = msg.message?.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          const output = this.extractToolResultText(block);
          messages.push({
            type: 'tool_call_update',
            toolCallId: block.tool_use_id ?? 'unknown',
            status: block.is_error ? 'error' : 'completed',
            output,
            timestamp: now,
          });
        }
      }
    }

    return messages.length > 0 ? messages : null;
  }

  /** Extract human-readable text from a tool_result content block. */
  private extractToolResultText(block: SDKRawMessage): string {
    const content = block.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((c: SDKRawMessage) => {
          if (c.type === 'text') return c.text ?? '';
          if (c.type === 'image') return '[image]';
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

  private normalizeStreamEvent(msg: SDKRawMessage, now: number): SessionMessage[] | null {
    const event = msg.event;
    if (!event) return null;

    // Text streaming
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      return [
        {
          type: 'agent_message_chunk',
          text: event.delta.text,
          messageId: msg.uuid ?? `chunk-${now}`,
          timestamp: now,
        },
      ];
    }

    // Thinking streaming
    if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
      return [
        {
          type: 'agent_thought_chunk',
          text: event.delta.thinking ?? '',
          messageId: msg.uuid ?? `thought-${now}`,
          timestamp: now,
        },
      ];
    }

    // Tool use input streaming — track tool_use block start
    // Note: input is empty at this point; detail will be enriched on tool_call_update
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      return [
        {
          type: 'tool_call',
          toolCallId: event.content_block.id,
          toolName: event.content_block.name,
          title: event.content_block.name,
          input: {},
          detail: toToolCallDetail(event.content_block.name, {}),
          status: 'in_progress',
          timestamp: now,
        },
      ];
    }

    return null;
  }

  private normalizeResultMessage(msg: SDKRawMessage, now: number): SessionMessage[] | null {
    const messages: SessionMessage[] = [];

    if (msg.usage || msg.modelUsage) {
      messages.push({
        type: 'token_usage',
        inputTokens: msg.usage?.input_tokens ?? 0,
        outputTokens: msg.usage?.output_tokens ?? 0,
        totalCostUsd: msg.total_cost_usd,
        modelUsage: msg.modelUsage,
        durationMs: msg.duration_ms,
        numTurns: msg.num_turns,
        timestamp: now,
      });
    }

    if (this.endedForPoisonedHistory) {
      return messages.length > 0 ? messages : null;
    }

    messages.push({
      type: 'system_status',
      status:
        msg.subtype === 'success'
          ? 'completed'
          : `error: ${this.resultErrorDetail(msg) ?? msg.subtype}`,
      sessionId: msg.session_id ?? this.id,
      timestamp: now,
    });

    if (msg.subtype === 'success') {
      // Turn completed — session is idle and ready for follow-ups.
      // Do NOT emit 'ended' — the session stays alive for sendPrompt.
      this.setState('idle');
    } else {
      this.setState('errored');
    }

    return messages;
  }

  private isPoisonedHistoryApiError(text: string): boolean {
    const normalized = text.toLowerCase();
    return (
      normalized.includes('messages: text content blocks must be non-empty') ||
      normalized.includes('cache_control cannot be set for empty text blocks')
    );
  }

  private endPoisonedHistorySession(): void {
    if (this.endedForPoisonedHistory) return;
    this.endedForPoisonedHistory = true;
    try {
      this.query?.close();
    } catch {
      // Ignore close errors from SDK boundary.
    }
    this.setState('completed');
    this.emit('ended', 'history_poisoned');
  }

  private resultErrorDetail(msg: SDKRawMessage): string | undefined {
    if (Array.isArray(msg.errors) && msg.errors.length > 0) {
      const first = msg.errors[0];
      if (typeof first === 'string' && first.trim().length > 0) {
        return first.trim();
      }
    }
    if (typeof msg.result === 'string' && msg.result.trim().length > 0) {
      return msg.result.trim();
    }
    if (typeof msg.error === 'string' && msg.error.trim().length > 0) {
      return msg.error.trim();
    }
    if (msg.error && typeof msg.error === 'object') {
      try {
        const serialized = JSON.stringify(msg.error);
        if (serialized.length > 0) return serialized;
      } catch {
        // ignore serialization errors
      }
    }
    return undefined;
  }

  private wrapCanUseTool(handler: PermissionHandler): SDKCanUseTool {
    return async (toolName, input, options) => {
      const context: PermissionContext = {
        signal: options.signal,
        toolUseId: options.toolUseID,
        decisionReason: options.decisionReason,
        blockedPath: options.blockedPath,
        agentId: options.agentID,
      };

      this.setState('waiting_permission');

      try {
        const decision = await handler(toolName, input, context);
        this.setState('running');

        if (decision.behavior === 'allow') {
          const updatedInput =
            'updatedInput' in decision && decision.updatedInput !== undefined
              ? (decision.updatedInput as Record<string, unknown>)
              : input;
          return { behavior: 'allow' as const, updatedInput };
        }

        return {
          behavior: 'deny' as const,
          message: 'message' in decision ? (decision.message ?? 'Denied by user') : 'Denied',
        };
      } catch {
        this.setState('running');
        return { behavior: 'deny' as const, message: 'Permission handler error' };
      }
    };
  }

  private emitLocalUserPrompt(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.emitSessionMessage({
      type: 'user_message',
      text: trimmed,
      messageId: `local-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    } satisfies SessionMessage);
  }

  private emitSessionMessage(message: SessionMessage): void {
    if (this.listenerCount('message') === 0) {
      this.pendingMessages.push(message);
      return;
    }
    this.emit('message', message);
  }

  private schedulePendingFlush(): void {
    if (this.pendingFlushScheduled || this.pendingMessages.length === 0) {
      return;
    }
    this.pendingFlushScheduled = true;
    queueMicrotask(() => {
      this.pendingFlushScheduled = false;
      this.flushPendingMessages();
    });
  }

  private flushPendingMessages(): void {
    if (this.pendingMessages.length === 0 || this.listenerCount('message') === 0) {
      return;
    }
    const queued = this.pendingMessages;
    this.pendingMessages = [];
    for (const message of queued) {
      this.emit('message', message);
    }
  }

  /** Valid state transitions — guards against concurrent setState calls. */
  private static readonly VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
    starting: ['running', 'idle', 'errored', 'completed'],
    running: ['idle', 'waiting_permission', 'errored', 'completed'],
    waiting_permission: ['running', 'errored', 'completed'],
    idle: ['running', 'waiting_permission', 'errored', 'completed'],
    completed: [], // terminal
    errored: ['running', 'completed'],
  };

  private _transitioning = false;

  private setState(state: SessionState): void {
    if (this.state === state) return;
    if (this._transitioning) {
      log.warn(
        { sessionId: this.id, from: this.state, to: state },
        'Concurrent setState — ignored',
      );
      return;
    }

    const allowed = ClaudeSession.VALID_TRANSITIONS[this.state];
    if (!allowed.includes(state)) {
      log.warn(
        { sessionId: this.id, from: this.state, to: state },
        'Invalid state transition — ignored',
      );
      return;
    }

    this._transitioning = true;
    log.debug({ sessionId: this.id, from: this.state, to: state }, 'state change');
    this.state = state;
    this.emit('state-change', state);
    this._transitioning = false;
  }
}

// ---------------------------------------------------------------------------
// ClaudeAdapter
// ---------------------------------------------------------------------------

export class ClaudeAdapter implements AgentAdapter {
  readonly agentId = 'claude';

  constructor(private queryFn: QueryFn) {}

  async startSession(cwd: string, options?: SessionOptions): Promise<Session> {
    const sessionId = crypto.randomUUID();
    log.info({ sessionId, cwd }, 'ClaudeAdapter.startSession');
    const session = new ClaudeSession(sessionId, this.queryFn, options?.canUseTool);

    await session.start(options?.initialPrompt ?? '', cwd, options);
    return session;
  }

  async resumeSession(sessionId: string, cwd: string, options?: SessionOptions): Promise<Session> {
    log.info({ sessionId, cwd }, 'ClaudeAdapter.resumeSession');
    const session = new ClaudeSession(sessionId, this.queryFn, options?.canUseTool);

    await session.resume(sessionId, cwd, options);
    return session;
  }
}
