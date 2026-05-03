/**
 * HookRouter — central dispatcher for agent hook events.
 *
 * Receives events from the HTTP endpoint (posted by `vpd hook notify`),
 * validates them, emits typed events on the daemon bus, and handles
 * blocking hooks like PermissionRequest by holding the HTTP response
 * until a supervising client responds.
 *
 * Design:
 *   - Event definitions are data (HookEventDefinition), not code.
 *   - Adding a new hook = adding a schema + definition. No switch statements.
 *   - The router doesn't know about specific agents — it's adapter-agnostic.
 *   - Blocking logic is isolated to handleBlockingEvent().
 */

import type { TypedEventEmitter } from '../core/events.js';
import type { DaemonEvents } from '../core/events.js';
import type { SupervisionManager } from './supervision.js';
import {
  type HookEventKind,
  type HookEventDefinition,
  type HookResponse,
  HOOK_INPUT_SCHEMAS,
  DEFAULT_EVENT_DEFINITIONS,
  HookBaseInputSchema,
} from './types.js';
import { logger } from '../core/logger.js';
import { workflowHookRegistry } from '../workflows/hook-registry.js';
import { emitSpecificHookEvent } from './specific-events.js';

const log = logger.child({ module: 'hook-router' });
const MAX_PENDING_PERMISSION_REQUESTS = 512;

// ---------------------------------------------------------------------------
// Pending permission request — held while waiting for supervisor response
// ---------------------------------------------------------------------------

export interface PendingPermission {
  hookRequestId: string;
  sessionId: string;
  adapter: string;
  toolName: string;
  toolInput: unknown;
  cwd?: string;
  createdAt: number;
  timeoutMs: number;
  resolve: (response: HookResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// HookRouter
// ---------------------------------------------------------------------------

export class HookRouter {
  private readonly definitions = new Map<HookEventKind, HookEventDefinition>();
  private readonly pending = new Map<string, PendingPermission>();
  private hookRequestCounter = 0;

  constructor(
    private readonly eventBus: TypedEventEmitter<DaemonEvents>,
    private readonly supervision: SupervisionManager,
  ) {
    for (const def of DEFAULT_EVENT_DEFINITIONS) {
      this.definitions.set(def.kind, def);
    }

    // Listen for permission responses from WS clients
    this.eventBus.on('hook:permission-response', ({ hookRequestId, decision }) => {
      this.resolvePermission(hookRequestId, decision);
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Handle an incoming hook event from an agent.
   *
   * For non-blocking events: emits on the event bus and returns immediately.
   * For blocking events (PermissionRequest): holds if supervised, or returns
   * passthrough if nobody is watching.
   */
  async handleEvent(
    input: Record<string, unknown>,
    adapter: string = 'claude',
  ): Promise<HookResponse> {
    // Validate base fields
    const baseResult = HookBaseInputSchema.safeParse(input);
    if (!baseResult.success) {
      log.warn(
        { input: safeHookLogInput(input), error: baseResult.error.message },
        'Invalid hook input — missing base fields',
      );
      return { passthrough: true };
    }

    const kind = baseResult.data.hook_event_name as HookEventKind;
    const schema = HOOK_INPUT_SCHEMAS[kind];
    if (!schema) {
      log.debug({ kind }, 'Unknown hook event kind — passthrough');
      return { passthrough: true };
    }

    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      log.warn({ kind, error: parsed.error.message }, 'Hook input validation failed');
      return { passthrough: true };
    }

    const sessionId = baseResult.data.session_id;
    const cwd = baseResult.data.cwd;
    const workflowHook = workflowHookRegistry.resolve(
      sessionId,
      kind,
      parsed.data as Record<string, unknown>,
    );

    // Emit the generic hook:event for any listeners
    this.eventBus.emit('hook:event', {
      kind,
      sessionId,
      adapter,
      cwd,
      payload: parsed.data as Record<string, unknown>,
    });

    if (workflowHook) {
      this.eventBus.emit('workflow:hook-fired', {
        workflowRunId: workflowHook.registration.workflowRunId,
        workflowNodeId: workflowHook.registration.workflowNodeId,
        sessionId,
        kind,
        adapter,
        ...(workflowHook.response ? { response: workflowHook.response } : {}),
        payload: parsed.data as Record<string, unknown>,
      });
      if (workflowHook.response) {
        return workflowHook.response;
      }
    }

    // Dispatch to specific event handler
    const def = this.definitions.get(kind);
    if (def?.blocking) {
      return this.handleBlockingEvent(kind, parsed.data as Record<string, unknown>, {
        sessionId,
        adapter,
        cwd,
        timeoutMs: def.defaultTimeoutMs,
      });
    }

    // Non-blocking: emit specific event and return immediately
    this.emitSpecificEvent(kind, parsed.data as Record<string, unknown>, {
      sessionId,
      adapter,
      cwd,
    });
    return { passthrough: false };
  }

  /** Register or override an event definition. */
  registerDefinition(def: HookEventDefinition): void {
    this.definitions.set(def.kind, def);
  }

  /** Resolve a pending permission request (called by WS handler). */
  resolvePermission(
    hookRequestId: string,
    decision: { behavior: 'allow' | 'deny'; message?: string },
  ): boolean {
    const pending = this.pending.get(hookRequestId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pending.delete(hookRequestId);

    log.info(
      { hookRequestId, sessionId: pending.sessionId, decision: decision.behavior },
      'Permission resolved by supervisor',
    );

    pending.resolve({ passthrough: false, decision });
    return true;
  }

  /** Get all pending permission requests (for UI state). */
  getPendingPermissions(): ReadonlyMap<string, PendingPermission> {
    return this.pending;
  }

  /** Clean up all pending requests for a session (e.g., session ended). */
  releaseSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve({ passthrough: true });
      }
    }
  }

  /** Clean up on shutdown. */
  shutdown(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ passthrough: true });
    }
    this.pending.clear();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async handleBlockingEvent(
    kind: HookEventKind,
    data: Record<string, unknown>,
    ctx: { sessionId: string; adapter: string; cwd?: string; timeoutMs: number },
  ): Promise<HookResponse> {
    // If not supervised, fall through immediately
    if (!this.supervision.isSupervised(ctx.sessionId)) {
      log.debug({ kind, sessionId: ctx.sessionId }, 'Not supervised — passthrough');
      // Still emit the event for visibility (non-blocking listeners)
      this.emitSpecificEvent(kind, data, ctx);
      return { passthrough: true };
    }

    // For PermissionRequest: hold and wait for supervisor response
    if (kind === 'PermissionRequest') {
      return this.holdPermissionRequest(data, ctx);
    }

    // Other blocking events: emit and passthrough for now
    this.emitSpecificEvent(kind, data, ctx);
    return { passthrough: true };
  }

  private holdPermissionRequest(
    data: Record<string, unknown>,
    ctx: { sessionId: string; adapter: string; cwd?: string; timeoutMs: number },
  ): Promise<HookResponse> {
    if (this.pending.size >= MAX_PENDING_PERMISSION_REQUESTS) {
      log.warn(
        { sessionId: ctx.sessionId, pending: this.pending.size },
        'Permission request queue full; denying request defensively',
      );
      return Promise.resolve({
        passthrough: false,
        decision: {
          behavior: 'deny',
          message: 'Permission supervision queue is full',
        },
      });
    }

    const hookRequestId = `hk-${++this.hookRequestCounter}-${Date.now()}`;
    const toolName = (data.tool_name as string) ?? 'unknown';
    const toolInput = data.tool_input;

    // Emit the permission request event so WS server can broadcast
    this.eventBus.emit('hook:permission-request', {
      sessionId: ctx.sessionId,
      adapter: ctx.adapter,
      hookRequestId,
      toolName,
      toolInput,
      cwd: ctx.cwd,
    });

    return new Promise<HookResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(hookRequestId);
        log.info({ hookRequestId, sessionId: ctx.sessionId }, 'Permission request timed out');
        resolve({ passthrough: true });
      }, ctx.timeoutMs);

      this.pending.set(hookRequestId, {
        hookRequestId,
        sessionId: ctx.sessionId,
        adapter: ctx.adapter,
        toolName,
        toolInput,
        cwd: ctx.cwd,
        createdAt: Date.now(),
        timeoutMs: ctx.timeoutMs,
        resolve,
        timer,
      });
    });
  }

  private emitSpecificEvent(
    kind: HookEventKind,
    data: Record<string, unknown>,
    ctx: { sessionId: string; adapter: string; cwd?: string },
  ): void {
    emitSpecificHookEvent(this.eventBus, kind, data, ctx);
  }
}

function safeHookLogInput(input: Record<string, unknown>): Record<string, unknown> {
  return {
    hook_event_name: typeof input.hook_event_name === 'string' ? input.hook_event_name : undefined,
    adapter: typeof input.adapter === 'string' ? input.adapter : undefined,
    has_session_id: typeof input.session_id === 'string' && input.session_id.trim().length > 0,
    keys: Object.keys(input).filter(
      (key) =>
        !['body', 'metadata', 'plan', 'plan_markdown', 'tool_input', 'tool_response'].includes(key),
    ),
  };
}
