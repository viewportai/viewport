/**
 * PermissionCoordinator — handles permission resolution and async approval flow.
 *
 * Builds the canUseTool handler that adapters receive, resolves auto-approve/deny
 * from config, and waits for user responses via the event bus for require-approval.
 */

import type { TypedEventEmitter } from './events.js';
import type { DaemonEvents } from './events.js';
import type {
  SessionConfig,
  PermissionDecision,
  PermissionRequest,
  PendingPermissionRequest,
  SessionAgentMode,
} from './types.js';
import { resolvePermission } from '../permissions/engine.js';
import { ViewportError } from './errors.js';

/** Default timeout for permission requests (5 minutes). */
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

export class PermissionCoordinator {
  /** Tracks pending permission requests per session: sessionId -> Set<requestId>. */
  private pendingPermissions = new Map<string, Set<string>>();
  /** Maps requestId -> toolName for resolving allow-always. */
  private requestToolNames = new Map<string, string>();
  /** Maps requestId -> full pending request metadata (for operator tooling). */
  private pendingRequestDetails = new Map<string, PendingPermissionRequest>();
  /** Per-session operator mode. */
  private sessionModes = new Map<string, SessionAgentMode>();

  constructor(
    private readonly eventBus: TypedEventEmitter<DaemonEvents>,
    private readonly timeoutMs: number = PERMISSION_TIMEOUT_MS,
  ) {}

  /**
   * Create the async permission handler for an agent session.
   *
   * The returned function matches the SDK's canUseTool signature. It:
   * 1. Checks the config for auto-approve / deny
   * 2. For require-approval, emits a permission:requested event and
   *    waits for permission:responded on the event bus
   */
  createPermissionHandler(
    sessionId: string,
    configOrGetter: SessionConfig | (() => SessionConfig),
  ): (
    toolName: string,
    input: Record<string, unknown>,
    context: { signal: AbortSignal; toolUseId: string; decisionReason?: string },
  ) => Promise<PermissionDecision> {
    const getConfig = (): SessionConfig =>
      typeof configOrGetter === 'function' ? configOrGetter() : configOrGetter;

    return async (toolName, input, context) => {
      if (this.sessionModes.get(sessionId) === 'bypass') {
        return { behavior: 'allow' };
      }

      const resolution = resolvePermission(toolName, input, getConfig().permissions);

      if (resolution === 'auto-approve') {
        return { behavior: 'allow' };
      }

      if (resolution === 'deny') {
        return { behavior: 'deny', message: `Tool "${toolName}" is denied by policy` };
      }

      // require-approval — emit event and wait for response
      const request: PermissionRequest = {
        requestId: context.toolUseId,
        toolName,
        description: `${toolName} wants to execute`,
        input,
        decisionReason: context.decisionReason,
      };

      this.eventBus.emit('permission:requested', { sessionId, request });

      // Track this pending permission
      if (!this.pendingPermissions.has(sessionId)) {
        this.pendingPermissions.set(sessionId, new Set());
      }
      this.pendingPermissions.get(sessionId)!.add(context.toolUseId);
      this.requestToolNames.set(context.toolUseId, toolName);
      this.pendingRequestDetails.set(context.toolUseId, {
        sessionId,
        requestId: context.toolUseId,
        toolName,
        description: request.description,
        input: request.input,
        decisionReason: request.decisionReason,
        blockedPath: request.blockedPath,
        createdAt: Date.now(),
      });

      // Return a promise that resolves when respondPermission is called
      return new Promise<PermissionDecision>((resolve) => {
        let resolved = false;

        const cleanup = () => {
          const pending = this.pendingPermissions.get(sessionId);
          if (pending) {
            pending.delete(context.toolUseId);
            if (pending.size === 0) {
              this.pendingPermissions.delete(sessionId);
            }
          }
          this.requestToolNames.delete(context.toolUseId);
          this.pendingRequestDetails.delete(context.toolUseId);
        };

        const resolveOnce = (decision: PermissionDecision) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          this.eventBus.off('permission:responded', handler);
          cleanup();
          resolve(decision);
        };

        // Auto-deny after timeout
        const timer = setTimeout(() => {
          this.eventBus.emit('session:attention', {
            sessionId,
            attention: {
              requiresAttention: true,
              reason: 'idle_timeout',
              timestamp: Date.now(),
            },
          });
          resolveOnce({
            behavior: 'deny',
            message: `Permission request timed out after ${this.timeoutMs / 1000}s`,
          });
        }, this.timeoutMs);

        const handler = (data: {
          sessionId: string;
          requestId: string;
          decision: PermissionDecision;
        }) => {
          if (data.sessionId === sessionId && data.requestId === context.toolUseId) {
            resolveOnce(data.decision);
          }
        };
        this.eventBus.on('permission:responded', handler);

        // Abort signal cancellation
        context.signal.addEventListener(
          'abort',
          () => {
            resolveOnce({ behavior: 'deny', message: 'Request cancelled' });
          },
          { once: true },
        );
      });
    };
  }

  /**
   * Respond to a pending permission request by emitting the responded event.
   *
   * The daemon's createPermissionHandler listens for this event to resolve
   * the pending promise.
   */
  respondPermission(sessionId: string, requestId: string, decision: PermissionDecision): void {
    this.eventBus.emit('permission:responded', { sessionId, requestId, decision });
  }

  /**
   * Reject any pending permission promises for a session.
   *
   * Called on session end/error to prevent dangling promises. Emits a deny
   * response for each pending request, which resolves the waiting promises
   * in the permission handlers.
   */
  rejectPendingPermissions(sessionId: string): void {
    const pending = this.pendingPermissions.get(sessionId);
    if (!pending || pending.size === 0) return;

    // Copy the set since respondPermission will modify it via the handler cleanup
    const requestIds = [...pending];
    for (const requestId of requestIds) {
      this.respondPermission(sessionId, requestId, {
        behavior: 'deny',
        message: 'Session ended',
      });
    }

    // Ensure cleanup even if handlers didn't fire
    this.pendingPermissions.delete(sessionId);
    for (const [requestId, detail] of this.pendingRequestDetails) {
      if (detail.sessionId === sessionId) {
        this.pendingRequestDetails.delete(requestId);
      }
    }
  }

  /**
   * Validate that a session exists before responding to a permission.
   * Throws SESSION_NOT_FOUND if the session is not active.
   */
  respondPermissionForSession(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
    sessionExists: boolean,
  ): void {
    if (!sessionExists) {
      throw new ViewportError('SESSION_NOT_FOUND', `No active session: ${sessionId}`);
    }
    this.respondPermission(sessionId, requestId, decision);
  }

  /** Get the tool name for a pending permission request. */
  getRequestToolName(requestId: string): string | undefined {
    return this.requestToolNames.get(requestId);
  }

  /**
   * Add a tool to a session's auto-approve list at runtime.
   * Used when the user selects "Always Allow" for a tool.
   */
  addAutoApprove(config: SessionConfig, toolName: string): SessionConfig {
    if (!config.permissions.autoApprove.includes(toolName)) {
      return {
        ...config,
        permissions: {
          ...config.permissions,
          autoApprove: [...config.permissions.autoApprove, toolName],
        },
      };
    }
    return config;
  }

  setSessionMode(sessionId: string, mode: SessionAgentMode): void {
    this.sessionModes.set(sessionId, mode);
  }

  getSessionMode(sessionId: string): SessionAgentMode {
    return this.sessionModes.get(sessionId) ?? 'detect';
  }

  clearSessionMode(sessionId: string): void {
    this.sessionModes.delete(sessionId);
  }

  listPendingPermissions(sessionId?: string): PendingPermissionRequest[] {
    const out: PendingPermissionRequest[] = [];
    for (const detail of this.pendingRequestDetails.values()) {
      if (!sessionId || detail.sessionId === sessionId) {
        out.push({ ...detail });
      }
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }
}
