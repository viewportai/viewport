import path from 'node:path';
import fs from 'node:fs/promises';
import type { Daemon } from './core/daemon.js';
import type { AgentRegistry } from './core/agent-registry.js';
import { watchProjects, createSessionTailer, type SessionTailer } from './discovery/watcher.js';
import { encodeProjectDir, parseJSONLEntry } from './discovery/jsonl-reader.js';
import type { RichSessionMessage } from './discovery/jsonl-reader.js';
import { codexSessionsDir } from './discovery/codex.js';
import { autoRegisterDirectories } from './startup-agents.js';
import { metrics } from './core/metrics.js';

interface TailerEntry {
  tailer: SessionTailer;
  lastAccessed: number;
  pendingToolIds: Set<string>;
  sessionAliases: Set<string>;
  wasWaiting: boolean;
  lastToolName?: string;
  lastToolInput?: Record<string, unknown>;
}

function resolveDirectoryContext(
  daemon: Daemon,
  filePath: string,
  currentSessionId: string,
): { directoryId: string | null; sessionId: string } {
  const parentDir = path.basename(path.dirname(filePath));
  for (const dir of daemon.directoryManager.list()) {
    if (encodeProjectDir(dir.path) === parentDir) {
      return { directoryId: dir.id, sessionId: currentSessionId };
    }
  }

  const normalizedFilePath = path.resolve(filePath);
  for (const [directoryId, sessions] of daemon.getDiscoveredSessions()) {
    for (const session of sessions) {
      const sourcePath = session.sourcePath ? path.resolve(session.sourcePath) : null;
      if (sourcePath && sourcePath === normalizedFilePath) {
        return { directoryId, sessionId: session.sessionId };
      }
      if (session.sessionId === currentSessionId) {
        return { directoryId, sessionId: session.sessionId };
      }
    }
  }

  return { directoryId: null, sessionId: currentSessionId };
}

export interface DiscoveryWatchHandle {
  stop: () => void;
}

export async function startDiscoveryWatchers(
  daemon: Daemon,
  registry: AgentRegistry,
): Promise<DiscoveryWatchHandle> {
  const watchDirs = registry.getAllWatchDirs();
  const stopWatchers: Array<() => void> = [];
  const tailers = new Map<string, TailerEntry>();
  const processingFiles = new Set<string>();

  const TAILER_IDLE_MS = 5 * 60 * 1000;
  const TAILER_CLEANUP_INTERVAL_MS = 60 * 1000;
  const TAILER_POLL_INTERVAL_MS = 1_500;
  const sourceStats = new Map<string, { size: number; mtimeMs: number }>();

  const processFileChange = async (rawFilePath: string): Promise<void> => {
    const filePath = path.resolve(rawFilePath);
    if (processingFiles.has(filePath)) return;
    processingFiles.add(filePath);

    try {
      let entry = tailers.get(filePath);
      if (!entry) {
        const initialSessionId = path.basename(filePath, '.jsonl');
        entry = {
          tailer: createSessionTailer(filePath),
          lastAccessed: Date.now(),
          pendingToolIds: new Set(),
          sessionAliases: new Set([initialSessionId]),
          wasWaiting: false,
        };
        tailers.set(filePath, entry);
      }

      entry.lastAccessed = Date.now();
      const beforeSessionId = entry.tailer.sessionId;
      const newEntries = await entry.tailer.readNew();
      if (newEntries.length === 0) return;
      entry.sessionAliases.add(beforeSessionId);
      entry.sessionAliases.add(entry.tailer.sessionId);

      // Keep alias set bounded in pathological session-id churn cases.
      if (entry.sessionAliases.size > 8) {
        const canonical = entry.tailer.sessionId;
        entry.sessionAliases = new Set([canonical]);
      }

      const resolvedContext = resolveDirectoryContext(daemon, filePath, entry.tailer.sessionId);
      const sessionId = resolvedContext.sessionId;
      entry.sessionAliases.add(sessionId);

      const newBlocks: RichSessionMessage[] = [];
      for (const raw of newEntries) {
        newBlocks.push(...parseJSONLEntry(raw));
      }
      if (newBlocks.length === 0) return;

      for (const block of newBlocks) {
        if (block.kind === 'tool_use') {
          entry.pendingToolIds.add(block.toolId);
          entry.lastToolName = block.toolName;
          entry.lastToolInput = block.input;
        } else if (block.kind === 'tool_result') {
          entry.pendingToolIds.delete(block.toolId);
        }
      }

      const waiting = entry.pendingToolIds.size > 0;
      if (waiting !== entry.wasWaiting) {
        entry.wasWaiting = waiting;
        const waitingDirectoryId = resolvedContext.directoryId;
        if (waitingDirectoryId) {
          daemon.emit('discovery:session-waiting', {
            sessionId,
            directoryId: waitingDirectoryId,
            waiting,
            toolName: waiting ? entry.lastToolName : undefined,
            toolInput: waiting ? entry.lastToolInput : undefined,
          });
        }
      }

      const directoryId = resolvedContext.directoryId;
      if (directoryId) {
        metrics.increment('discovery.tail_events_emitted');
        daemon.emit('discovery:session-tail', {
          sessionId,
          sessionIds: [...entry.sessionAliases],
          directoryId,
          newBlocks,
        });
      }
    } finally {
      processingFiles.delete(filePath);
    }
  };

  const tailerCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [filePath, entry] of tailers) {
      if (now - entry.lastAccessed > TAILER_IDLE_MS) {
        tailers.delete(filePath);
      }
    }
  }, TAILER_CLEANUP_INTERVAL_MS);

  const tailerPollTimer = setInterval(() => {
    metrics.increment('discovery.poll_cycles');
    const discoveredSourcePaths = new Set<string>();
    for (const [, sessions] of daemon.getDiscoveredSessions()) {
      for (const session of sessions) {
        if (!session.sourcePath) continue;
        if (!session.sourcePath.endsWith('.jsonl')) continue;
        discoveredSourcePaths.add(path.resolve(session.sourcePath));
      }
    }
    metrics.gauge('discovery.poll_files_scanned', discoveredSourcePaths.size);
    metrics.increment('discovery.files_scanned', discoveredSourcePaths.size);
    for (const sourcePath of discoveredSourcePaths) {
      void (async () => {
        try {
          const stat = await fs.stat(sourcePath);
          const previous = sourceStats.get(sourcePath);
          const current = { size: stat.size, mtimeMs: stat.mtimeMs };
          sourceStats.set(sourcePath, current);
          if (previous && previous.size === current.size && previous.mtimeMs === current.mtimeMs) {
            return;
          }
          await processFileChange(sourcePath);
        } catch {
          sourceStats.delete(sourcePath);
        }
      })();
    }
  }, TAILER_POLL_INTERVAL_MS);

  for (const watchDir of watchDirs) {
    const codexWatchDir = path.resolve(watchDir) === path.resolve(codexSessionsDir());
    try {
      const stop = watchProjects({
        watchDir,
        recursive: codexWatchDir,
        includeTopLevelFiles: codexWatchDir,
        onFileChanged: async (filePath: string) => {
          await processFileChange(filePath);
        },
        onChange: async () => {
          try {
            await autoRegisterDirectories(daemon, registry);
            await daemon.runDiscovery();
            daemon.emit('discovery:updated', {});
          } catch {
            // Re-discovery failure is non-fatal.
          }
        },
      });
      stopWatchers.push(stop);
    } catch {
      // Watcher failure is non-fatal.
    }
  }

  return {
    stop: () => {
      clearInterval(tailerCleanupTimer);
      clearInterval(tailerPollTimer);
      tailers.clear();
      processingFiles.clear();
      sourceStats.clear();
      for (const stop of stopWatchers) {
        stop();
      }
    },
  };
}
