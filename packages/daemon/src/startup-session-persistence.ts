import { logger } from './core/output.js';
import type { Daemon } from './core/daemon.js';
import {
  clearPersistedSessions,
  loadPersistedSessions,
  savePersistedSessions,
  type PersistedSession,
} from './core/session-state-file.js';

const PERSIST_DEBOUNCE_MS = 2000;

export interface SessionPersistenceController {
  flush: () => Promise<void>;
  clearPersistedState: () => Promise<void>;
}

export async function setupSessionPersistence(
  daemon: Daemon,
): Promise<SessionPersistenceController> {
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  const sessionMeta = new Map<string, { startedAt: number; lastStateChange: number }>();

  const persistSessions = async () => {
    try {
      const activeSessions = daemon.getActiveSessions();
      const entries: PersistedSession[] = activeSessions.map((sid) => {
        const info = daemon.getSessionInfo(sid);
        const dir = daemon.directoryManager.get(info.directoryId);
        const meta = sessionMeta.get(sid);
        return {
          sessionId: sid,
          directoryId: info.directoryId,
          agent: info.agent,
          startedAt: meta?.startedAt ?? Date.now(),
          lastStateChange: meta?.lastStateChange ?? Date.now(),
          state: info.state,
          cwd: dir?.path ?? '',
        };
      });
      await savePersistedSessions(entries);
    } catch (err) {
      logger.warn('persistSessions failed:', err);
    }
  };

  const debouncedPersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistSessions().catch((err) => logger.warn('persistSessions failed:', err));
    }, PERSIST_DEBOUNCE_MS);
  };

  daemon.on('session:started', ({ sessionId }) => {
    const now = Date.now();
    sessionMeta.set(sessionId, { startedAt: now, lastStateChange: now });
    debouncedPersist();
  });
  daemon.on('session:ended', ({ sessionId }) => {
    sessionMeta.delete(sessionId);
    debouncedPersist();
  });
  daemon.on('session:state-changed', ({ sessionId }) => {
    const existing = sessionMeta.get(sessionId);
    if (!existing) return;
    existing.lastStateChange = Date.now();
    debouncedPersist();
  });

  const orphaned = await loadPersistedSessions();
  if (orphaned.length > 0) {
    logger.log(`Found ${orphaned.length} orphaned session(s) from previous run (cleaned up)`);
    await clearPersistedSessions();
  }

  return {
    flush: async () => {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      await persistSessions();
    },
    clearPersistedState: async () => {
      await clearPersistedSessions();
    },
  };
}
