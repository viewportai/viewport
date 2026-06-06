import type { WebSocket } from 'ws';
import type { ClientConnectionMeta, WorkspaceState } from './types.js';

export class ConnectionRegistry {
  private readonly workspaces = new Map<string, WorkspaceState>();

  getOrCreate(
    key: string,
    metadata?: { workspaceId?: string; runtimeTargetId?: string },
  ): WorkspaceState {
    let state = this.workspaces.get(key);
    if (!state) {
      state = {
        workspaceId: metadata?.workspaceId ?? key,
        runtimeTargetId: metadata?.runtimeTargetId,
        daemon: null,
        daemonIssueGeneration: null,
        clients: new Map<WebSocket, ClientConnectionMeta>(),
        sessionEventSubscribers: new Map(),
        keyExchangeRequests: new Map(),
        sessionOwners: new Map(),
        pairingRequests: new Map(),
        lastActivityAt: Date.now(),
      };
      this.workspaces.set(key, state);
    } else if (metadata?.workspaceId) {
      state.workspaceId = metadata.workspaceId;
      state.runtimeTargetId = metadata.runtimeTargetId;
    }
    return state;
  }

  touch(workspaceId: string): void {
    const state = this.workspaces.get(workspaceId);
    if (!state) return;
    state.lastActivityAt = Date.now();
  }

  workspaceEntries(): Array<[string, WorkspaceState]> {
    return [...this.workspaces.entries()];
  }

  totalConnectionCount(): number {
    let count = 0;
    for (const [, state] of this.workspaces.entries()) {
      if (state.daemon) count += 1;
      count += state.clients.size;
    }
    return count;
  }

  pruneEmpty(ttlMs: number): string[] {
    const now = Date.now();
    const removed: string[] = [];
    for (const [workspaceId, state] of this.workspaces.entries()) {
      if (state.daemon || state.clients.size > 0) continue;
      if (now - state.lastActivityAt < ttlMs) continue;
      this.workspaces.delete(workspaceId);
      removed.push(workspaceId);
    }
    return removed;
  }

  removeClient(workspaceId: string, ws: WebSocket): void {
    const state = this.workspaces.get(workspaceId);
    if (!state) return;
    state.clients.delete(ws);
    for (const [requestId, owner] of state.pairingRequests.entries()) {
      if (owner.clientWs === ws) {
        state.pairingRequests.delete(requestId);
      }
    }
    for (const [requestId, owner] of state.keyExchangeRequests.entries()) {
      if (owner.clientWs === ws) {
        state.keyExchangeRequests.delete(requestId);
      }
    }
    for (const [sessionId, owner] of state.sessionOwners.entries()) {
      if (owner.clientWs === ws) {
        state.sessionOwners.delete(sessionId);
      }
    }
    for (const [channel, subscribers] of state.sessionEventSubscribers.entries()) {
      subscribers.delete(ws);
      if (subscribers.size === 0) {
        state.sessionEventSubscribers.delete(channel);
      }
    }
    state.lastActivityAt = Date.now();
  }

  clearDaemon(workspaceId: string, ws: WebSocket): boolean {
    const state = this.workspaces.get(workspaceId);
    if (!state) return false;
    let cleared = false;
    if (state.daemon === ws) {
      state.daemon = null;
      cleared = true;
    }
    if (cleared) {
      state.keyExchangeRequests.clear();
      state.sessionOwners.clear();
      state.pairingRequests.clear();
    }
    state.lastActivityAt = Date.now();

    return cleared;
  }
}
