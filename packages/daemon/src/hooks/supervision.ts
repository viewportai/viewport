/**
 * SupervisionManager — tracks which sessions are being supervised by remote clients.
 *
 * When a session is supervised, blocking hooks (like PermissionRequest) will hold
 * and relay the request to the supervising clients instead of falling through to
 * the agent's local UI (e.g., the terminal prompt).
 *
 * When no clients are supervising, hooks fall through so the local UX is unaffected.
 */

import type { ConnectedClient } from '../server/hello-builder.js';
import { logger } from '../core/logger.js';

const log = logger.child({ module: 'supervision' });
const DEFAULT_MAX_SUPERVISED_SESSIONS = 4096;

export class SupervisionManager {
  /** sessionId → set of supervising clients */
  private readonly supervisors = new Map<string, Set<ConnectedClient>>();
  private readonly maxSupervisedSessions: number;

  constructor(maxSupervisedSessions = DEFAULT_MAX_SUPERVISED_SESSIONS) {
    this.maxSupervisedSessions = Math.max(1, Math.floor(maxSupervisedSessions));
  }

  /** Start supervising a session. */
  supervise(sessionId: string, client: ConnectedClient): void {
    let clients = this.supervisors.get(sessionId);
    if (!clients) {
      while (this.supervisors.size >= this.maxSupervisedSessions) {
        const oldest = this.supervisors.keys().next();
        if (oldest.done) break;
        this.supervisors.delete(oldest.value);
        log.warn(
          { sessionId: oldest.value, maxSupervisedSessions: this.maxSupervisedSessions },
          'Evicted oldest supervised session to enforce cap',
        );
      }
      clients = new Set();
      this.supervisors.set(sessionId, clients);
    }
    clients.add(client);
    log.info({ sessionId, supervisorCount: clients.size }, 'Client started supervising');
  }

  /** Stop supervising a session. */
  unsupervise(sessionId: string, client: ConnectedClient): void {
    const clients = this.supervisors.get(sessionId);
    if (!clients) return;
    clients.delete(client);
    if (clients.size === 0) {
      this.supervisors.delete(sessionId);
    }
    log.info({ sessionId, supervisorCount: clients?.size ?? 0 }, 'Client stopped supervising');
  }

  /** Check if any client is supervising this session. */
  isSupervised(sessionId: string): boolean {
    const clients = this.supervisors.get(sessionId);
    return clients !== undefined && clients.size > 0;
  }

  /** Get all supervising clients for a session. */
  getSupervisors(sessionId: string): ReadonlySet<ConnectedClient> {
    return this.supervisors.get(sessionId) ?? new Set();
  }

  /** Remove a client from all sessions (call on disconnect). */
  removeClient(client: ConnectedClient): string[] {
    const released: string[] = [];
    for (const [sessionId, clients] of this.supervisors) {
      if (clients.has(client)) {
        clients.delete(client);
        if (clients.size === 0) {
          this.supervisors.delete(sessionId);
          released.push(sessionId);
        }
      }
    }
    if (released.length > 0) {
      log.info({ released }, 'Client disconnected — released supervision');
    }
    return released;
  }

  /** Get all supervised session IDs. */
  getSupervisedSessions(): string[] {
    return [...this.supervisors.keys()];
  }
}
