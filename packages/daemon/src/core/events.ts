/**
 * Typed event bus for the Viewport daemon.
 *
 * All inter-module communication goes through this bus. Modules emit events
 * rather than calling each other directly — this keeps the dependency graph
 * flat and makes testing straightforward.
 */

import { EventEmitter } from 'node:events';
import type {
  SessionState,
  SessionMessage,
  Step,
  PermissionRequest,
  PermissionDecision,
  SessionConfig,
  AttentionState,
} from './types.js';
import type { RichSessionMessage } from '../discovery/jsonl-reader.js';
import type { HookEventKind } from '../hooks/types.js';

// ---------------------------------------------------------------------------
// Event definitions
// ---------------------------------------------------------------------------

export interface DaemonEvents {
  // Session lifecycle
  'session:started': { sessionId: string; directoryId: string; config: SessionConfig };
  'session:state-changed': { sessionId: string; state: SessionState };
  'session:ended': { sessionId: string; reason: string };

  // Session messages (normalized from adapter)
  'session:message': { sessionId: string; message: SessionMessage };

  // Git tracking
  'step:committed': { sessionId: string; step: Step };
  'step:rollback': { sessionId: string; toSha: string };
  'step:branch-retry': { sessionId: string; fromSha: string; retryPath: string };
  'step:squash-merged': { sessionId: string; targetBranch: string };

  // Permissions
  'permission:requested': { sessionId: string; request: PermissionRequest };
  'permission:responded': { sessionId: string; requestId: string; decision: PermissionDecision };

  // Attention
  'session:attention': { sessionId: string; attention: AttentionState };

  // Config
  'config:changed': { directoryId?: string };

  // Directory
  'directory:registered': { directoryId: string; path: string };
  'directory:unregistered': { directoryId: string };

  // Discovery
  'discovery:updated': Record<string, never>;
  'discovery:session-tail': {
    sessionId: string;
    sessionIds?: string[];
    directoryId: string;
    newBlocks: RichSessionMessage[];
  };
  'discovery:session-waiting': {
    sessionId: string;
    directoryId: string;
    waiting: boolean;
    toolName?: string;
    toolInput?: Record<string, unknown>;
  };

  // External hooks (from agent CLI hooks — Claude Code, Gemini, etc.)
  'hook:event': {
    kind: HookEventKind;
    sessionId: string;
    adapter: string;
    cwd?: string;
    payload: Record<string, unknown>;
  };
  'hook:session-start': {
    sessionId: string;
    adapter: string;
    cwd?: string;
    source?: string;
    agentType?: string;
    model?: string;
  };
  'hook:session-end': {
    sessionId: string;
    adapter: string;
    reason?: string;
  };
  'hook:permission-request': {
    sessionId: string;
    adapter: string;
    hookRequestId: string;
    toolName: string;
    toolInput?: unknown;
    cwd?: string;
  };
  'hook:permission-response': {
    hookRequestId: string;
    decision: { behavior: 'allow' | 'deny'; message?: string };
  };
  'hook:notification': {
    sessionId: string;
    adapter: string;
    message: string;
    title?: string;
    notificationType?: string;
  };
  'hook:tool-completed': {
    sessionId: string;
    adapter: string;
    toolName: string;
    toolInput?: unknown;
    toolResponse?: unknown;
  };
  'hook:tool-failed': {
    sessionId: string;
    adapter: string;
    toolName: string;
    error?: string;
    isInterrupt?: boolean;
  };
  'hook:stop': {
    sessionId: string;
    adapter: string;
    lastMessage?: string;
  };
  'hook:subagent-start': {
    sessionId: string;
    adapter: string;
    agentId?: string;
    agentType?: string;
  };
  'hook:subagent-stop': {
    sessionId: string;
    adapter: string;
    agentId?: string;
    agentType?: string;
    lastMessage?: string;
  };
}

// ---------------------------------------------------------------------------
// TypedEventEmitter
// ---------------------------------------------------------------------------

/**
 * An EventEmitter with type-safe emit and on/off/once methods.
 *
 * Usage:
 *   const bus = new TypedEventEmitter<DaemonEvents>();
 *   bus.on('session:started', ({ sessionId, directoryId }) => { ... });
 *   bus.emit('session:started', { sessionId: '...', directoryId: '...' });
 */
export class TypedEventEmitter<TEvents extends { [K in keyof TEvents]: unknown }> {
  private emitter = new EventEmitter();

  constructor() {
    // Generous default: 20 base (ws-server + persistence handlers) + headroom
    this.emitter.setMaxListeners(100);
  }

  /**
   * Scale max listeners with active session count.
   * Base of 20 (ws-server + persistence handlers) + 5 per active session.
   */
  adjustMaxListeners(activeSessionCount: number): void {
    this.emitter.setMaxListeners(Math.max(100, 20 + activeSessionCount * 5));
  }

  emit<K extends keyof TEvents & string>(event: K, data: TEvents[K]): boolean {
    return this.emitter.emit(event, data);
  }

  on<K extends keyof TEvents & string>(event: K, handler: (data: TEvents[K]) => void): this {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    return this;
  }

  once<K extends keyof TEvents & string>(event: K, handler: (data: TEvents[K]) => void): this {
    this.emitter.once(event, handler as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof TEvents & string>(event: K, handler: (data: TEvents[K]) => void): this {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
    return this;
  }

  removeAllListeners<K extends keyof TEvents & string>(event?: K): this {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
    return this;
  }

  listenerCount<K extends keyof TEvents & string>(event: K): number {
    return this.emitter.listenerCount(event);
  }
}
