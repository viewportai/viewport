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
  AgentAdapterDescriptor,
  Session,
  SessionOptions,
  PermissionHandler,
  PermissionContext,
} from '../core/interfaces.js';
import type { SessionState, SessionMessage } from '../core/types.js';
import { logger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import {
  type SDKRawMessage,
  normalizeAssistantMessage,
  normalizeStreamEvent,
  normalizeSystemMessage,
  normalizeToolProgressMessage,
  normalizeUserMessage,
  resultErrorDetail,
} from './claude-message-normalizer.js';

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
    tools?: string[] | { type: 'preset'; preset: 'claude_code' };
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
  private sessionOptions: SessionOptions | undefined;
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
    this.sessionOptions = options;
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
          ...claudeToolOptions(options),
          canUseTool: this.canUseTool ? this.wrapCanUseTool(this.canUseTool) : undefined,
        abortController: this.abortController,
        persistSession: true,
        ...claudePermissionOptions(options),
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
    this.sessionOptions = options;
    this.resumedContext = true;

    if (options?.deferInitialPrompt || explicitPrompt.length === 0) {
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
          ...claudeToolOptions(options),
          canUseTool: this.canUseTool ? this.wrapCanUseTool(this.canUseTool) : undefined,
        abortController: this.abortController,
        persistSession: true,
        ...claudePermissionOptions(options),
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
      const options = this.sessionOptions;
      this.query = this.queryFn({
        prompt: trimmed,
        options: {
          cwd: this.cwd,
          model: options?.model,
          ...(this.resumedContext ? { resume: this.id } : { sessionId: this.id }),
          ...claudeToolOptions(options),
          canUseTool: this.canUseTool ? this.wrapCanUseTool(this.canUseTool) : undefined,
          abortController: this.abortController,
          persistSession: true,
          ...claudePermissionOptions(options),
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
    const options = this.sessionOptions;

    log.info({ sessionId: this.id, cwd: this.cwd }, 'sendPrompt: creating new resumed query');
    this.query = this.queryFn({
      prompt: trimmed,
      options: {
        cwd: this.cwd,
        model: options?.model,
        resume: this.id,
        ...claudeToolOptions(options),
        canUseTool: this.canUseTool ? this.wrapCanUseTool(this.canUseTool) : undefined,
        abortController: this.abortController,
        persistSession: true,
        ...claudePermissionOptions(options),
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
        return normalizeSystemMessage(msg, now, this.id);

      case 'assistant':
        return this.normalizeAssistantMessage(msg, now);

      case 'user':
        return normalizeUserMessage(msg, now);

      case 'stream_event':
        return normalizeStreamEvent(msg, now);

      case 'result':
        return this.normalizeResultMessage(msg, now);

      case 'tool_progress':
        return normalizeToolProgressMessage(msg, now);

      default:
        return null;
    }
  }

  private normalizeAssistantMessage(msg: SDKRawMessage, now: number): SessionMessage[] | null {
    const result = normalizeAssistantMessage(msg, now);
    if (!result) return null;
    if (result.poisonedHistoryDetected && !this.endedForPoisonedHistory) {
      result.messages.push({
        type: 'system_status',
        status: 'error: session history is corrupted (empty text block). Start a new session.',
        sessionId: this.id,
        timestamp: now,
      });
      queueMicrotask(() => {
        this.endPoisonedHistorySession();
      });
    }
    return result.messages;
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
        msg.subtype === 'success' ? 'completed' : `error: ${resultErrorDetail(msg) ?? msg.subtype}`,
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

  describe(): AgentAdapterDescriptor {
    return {
      schema: 'viewport.agent_adapter/v2',
      agentId: this.agentId,
      displayName: 'Claude',
      adapterVersion: 'claude-agent-sdk',
      capabilities: {
        executionModes: {
          plan: 'provider',
          read_only: 'provider',
          review: 'provider',
          implement: 'provider',
        },
        toolAllowlist: 'provider',
        structuredOutput: 'prompt_only',
        permissionHooks: 'provider',
        usageReporting: 'reported',
        costReporting: 'reported',
        maxTurns: 'provider',
        maxBudget: 'provider',
        hardTimeout: 'hard',
      },
    };
  }

  async startSession(cwd: string, options?: SessionOptions): Promise<Session> {
    const sessionId = crypto.randomUUID();
    log.info({ sessionId, cwd }, 'ClaudeAdapter.startSession');
    const session = new ClaudeSession(sessionId, this.queryFn, options?.canUseTool);

    await session.start(
      options?.deferInitialPrompt ? '' : (options?.initialPrompt ?? ''),
      cwd,
      options,
    );
    return session;
  }

  async resumeSession(sessionId: string, cwd: string, options?: SessionOptions): Promise<Session> {
    log.info({ sessionId, cwd }, 'ClaudeAdapter.resumeSession');
    const session = new ClaudeSession(sessionId, this.queryFn, options?.canUseTool);

    await session.resume(sessionId, cwd, options);
    return session;
  }
}

function claudePermissionOptions(options: SessionOptions | undefined): { permissionMode?: string } {
  if (options?.config?.executionMode === 'plan') {
    return { permissionMode: 'plan' };
  }

  if (options?.config?.approvalPolicy === 'never') {
    return { permissionMode: 'bypassPermissions' };
  }

  return {};
}

function claudeToolOptions(
  options: SessionOptions | undefined,
): { tools?: string[] | { type: 'preset'; preset: 'claude_code' }; allowedTools?: string[] } {
  if (options?.config?.executionMode === 'plan') {
    return { tools: [] };
  }

  if (options?.config?.executionMode === 'read_only') {
    const tools = options.config.allowedTools ?? ['Read', 'Grep', 'Glob'];
    return { tools, allowedTools: tools };
  }

  return {};
}
