import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { claudeProjectsDir } from './jsonl-reader.js';

export interface WatcherOptions {
  /** Directory to watch (defaults to ~/.claude/projects/). */
  watchDir?: string;
  /** Debounce delay in ms (default: 300). */
  debounceMs?: number;
  /** Watch nested directories recursively. */
  recursive?: boolean;
  /** Emit onFileChanged for JSONL files directly in watchDir. */
  includeTopLevelFiles?: boolean;
  /** Callback when changes are detected. */
  onChange: () => void;
  /** Optional: called with the specific file that changed. */
  onFileChanged?: (filePath: string) => void;
}

/**
 * Watch ~/.claude/projects/ for changes.
 * Returns a cleanup function to stop watching.
 */
export function watchProjects(options: WatcherOptions): () => void {
  const watchDir = options.watchDir ?? claudeProjectsDir();
  const debounceMs = options.debounceMs ?? 300;
  const recursive = options.recursive ?? false;
  const includeTopLevelFiles = options.includeTopLevelFiles ?? false;

  const subWatchers = new Map<string, fs.FSWatcher>();
  const subRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const subRetryAttempts = new Map<string, number>();
  let topWatcher: fs.FSWatcher | null = null;
  let topRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let topRetryAttempt = 0;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let syncInFlight = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const RETRY_MIN_MS = 200;
  const RETRY_MAX_MS = 5_000;

  function backoffMs(attempt: number): number {
    return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, attempt - 1));
  }

  function scheduleChange() {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!stopped) {
        options.onChange();
      }
    }, debounceMs);
  }

  function closeSubWatcher(dirPath: string): void {
    const watcher = subWatchers.get(dirPath);
    if (!watcher) return;
    subWatchers.delete(dirPath);
    try {
      watcher.close();
    } catch {
      // Ignore close errors during cleanup/recovery.
    }
  }

  function clearSubRetry(dirPath: string): void {
    const timer = subRetryTimers.get(dirPath);
    if (timer) {
      clearTimeout(timer);
      subRetryTimers.delete(dirPath);
    }
  }

  function scheduleSubWatcherRetry(dirPath: string): void {
    if (stopped || subWatchers.has(dirPath) || subRetryTimers.has(dirPath)) return;
    const attempt = (subRetryAttempts.get(dirPath) ?? 0) + 1;
    subRetryAttempts.set(dirPath, attempt);
    const delay = backoffMs(attempt);
    const timer = setTimeout(() => {
      subRetryTimers.delete(dirPath);
      void setupSubWatcher(dirPath);
    }, delay);
    subRetryTimers.set(dirPath, timer);
  }

  async function setupSubWatcher(dirPath: string): Promise<void> {
    if (stopped || subWatchers.has(dirPath)) return;
    try {
      const stat = await fsp.stat(dirPath);
      if (!stat.isDirectory()) return;
    } catch {
      scheduleSubWatcherRetry(dirPath);
      return;
    }

    try {
      const watcher = fs.watch(dirPath, { persistent: false }, (_event, filename) => {
        if (!filename) {
          scheduleChange();
          scheduleSync();
          return;
        }
        const fileName = String(filename);
        if (isSessionJsonl(fileName)) {
          const filePath = path.join(dirPath, fileName);
          options.onFileChanged?.(filePath);
          scheduleChange();
        }
        // Handles directory renames/removals and late directory creation.
        scheduleSync();
      });
      watcher.on('error', () => {
        closeSubWatcher(dirPath);
        scheduleSubWatcherRetry(dirPath);
      });
      watcher.on('close', () => {
        if (!stopped && subWatchers.has(dirPath)) {
          subWatchers.delete(dirPath);
          scheduleSubWatcherRetry(dirPath);
        }
      });
      subWatchers.set(dirPath, watcher);
      subRetryAttempts.delete(dirPath);
      clearSubRetry(dirPath);
    } catch {
      scheduleSubWatcherRetry(dirPath);
    }
  }

  async function syncSubWatchers(): Promise<void> {
    if (stopped) return;
    if (syncInFlight) return;
    syncInFlight = true;
    // Watch existing project subdirectories for new/changed JSONL files
    try {
      const entries = await fsp.readdir(watchDir, { withFileTypes: true });
      const nextDirs = new Set<string>();
      if (recursive) {
        await collectNestedDirectories(watchDir, nextDirs);
      } else {
        for (const entry of entries) {
          if (entry.isDirectory()) {
            nextDirs.add(path.join(watchDir, entry.name));
          }
        }
      }
      for (const dirPath of subWatchers.keys()) {
        if (!nextDirs.has(dirPath)) {
          closeSubWatcher(dirPath);
          clearSubRetry(dirPath);
          subRetryAttempts.delete(dirPath);
        }
      }
      await Promise.all([...nextDirs].map((dirPath) => setupSubWatcher(dirPath)));
    } catch {
      // watchDir may not exist yet or may be temporarily unavailable.
    } finally {
      syncInFlight = false;
    }
  }

  function scheduleSync(delayMs = 50): void {
    if (stopped) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void syncSubWatchers();
    }, delayMs);
  }

  function startTopWatcher(): void {
    if (stopped || topWatcher) return;
    try {
      topWatcher = fs.watch(watchDir, { persistent: false }, (_event, filename) => {
        if (filename) {
          scheduleChange();
          if (includeTopLevelFiles) {
            const fileName = String(filename);
            if (isSessionJsonl(fileName)) {
              options.onFileChanged?.(path.join(watchDir, fileName));
            }
          }
        }
        // Some platforms emit null filename on directory changes; still resync.
        scheduleSync();
      });
      topWatcher.on('error', () => {
        if (topWatcher) {
          try {
            topWatcher.close();
          } catch {
            // Ignore close errors during retry setup.
          }
          topWatcher = null;
        }
        scheduleTopWatcherRetry();
      });
      topWatcher.on('close', () => {
        if (topWatcher) topWatcher = null;
        if (!stopped) scheduleTopWatcherRetry();
      });
      topRetryAttempt = 0;
    } catch {
      scheduleTopWatcherRetry();
    }
  }

  function scheduleTopWatcherRetry(): void {
    if (stopped || topRetryTimer) return;
    topRetryAttempt += 1;
    const delay = backoffMs(topRetryAttempt);
    topRetryTimer = setTimeout(() => {
      topRetryTimer = null;
      startTopWatcher();
    }, delay);
  }

  async function startWatching(): Promise<void> {
    try {
      await fsp.access(watchDir);
    } catch {
      scheduleTopWatcherRetry();
      return;
    }
    startTopWatcher();
    await syncSubWatchers();
  }

  // Start watching (async, but we don't need to await)
  void startWatching();

  // Return cleanup function
  return () => {
    stopped = true;
    if (syncTimer) clearTimeout(syncTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (topRetryTimer) clearTimeout(topRetryTimer);
    for (const timer of subRetryTimers.values()) clearTimeout(timer);
    subRetryTimers.clear();
    subRetryAttempts.clear();
    for (const dirPath of subWatchers.keys()) {
      closeSubWatcher(dirPath);
    }
    if (topWatcher) {
      try {
        topWatcher.close();
      } catch {
        // Ignore cleanup errors.
      }
      topWatcher = null;
    }
  };
}

export interface SessionTailer {
  /** Read new lines since last call. Returns parsed JSON objects. */
  readNew(): Promise<unknown[]>;
  /** Get the session ID (from filename). */
  readonly sessionId: string;
  /** Get the file path. */
  readonly filePath: string;
}

export function createSessionTailer(filePath: string): SessionTailer {
  let sessionId = path.basename(filePath, '.jsonl');
  let lastSize = 0;
  let lastInode: number | null = null;
  let partialLine = '';

  return {
    get sessionId() {
      return sessionId;
    },
    filePath,

    async readNew(): Promise<unknown[]> {
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(filePath);
      } catch {
        return [];
      }

      const currentSize = stat.size;
      const currentInode = stat.ino;
      const inodeChanged = lastInode !== null && currentInode !== lastInode;

      // File replaced/rotated or truncated: restart read from beginning.
      if (inodeChanged || currentSize < lastSize) {
        lastSize = 0;
        partialLine = '';
      } else if (currentSize === lastSize) {
        lastInode = currentInode;
        return [];
      }

      // Read only the new bytes
      const fd = await fsp.open(filePath, 'r');
      try {
        const bytesToRead = currentSize - lastSize;
        const buffer = Buffer.alloc(bytesToRead);
        await fd.read(buffer, 0, bytesToRead, lastSize);
        lastSize = currentSize;
        lastInode = currentInode;

        // Parse new lines
        const text = partialLine + buffer.toString('utf-8');
        const rawLines = text.split('\n');
        if (text.endsWith('\n')) {
          partialLine = '';
        } else {
          partialLine = rawLines.pop() ?? '';
        }
        const results: unknown[] = [];

        for (const line of rawLines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            results.push(parsed);
            const detected = detectSessionId(parsed);
            if (detected) {
              sessionId = detected;
            }
          } catch {
            // Malformed line — skip
          }
        }

        return results;
      } finally {
        await fd.close();
      }
    },
  };
}

function isSessionJsonl(fileName: string): boolean {
  return fileName.endsWith('.jsonl');
}

async function collectNestedDirectories(rootDir: string, out: Set<string>): Promise<void> {
  const queue: string[] = [rootDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      out.add(full);
      queue.push(full);
    }
  }
}

function detectSessionId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as Record<string, unknown>;
  const direct = [
    rec['sessionId'],
    rec['session_id'],
    rec['threadId'],
    rec['thread_id'],
    rec['id'],
  ];
  for (const candidate of direct) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  const payload =
    typeof rec['payload'] === 'object' && rec['payload'] !== null
      ? (rec['payload'] as Record<string, unknown>)
      : null;
  if (!payload) return null;
  const nested = [
    payload['sessionId'],
    payload['session_id'],
    payload['threadId'],
    payload['thread_id'],
    payload['id'],
  ];
  for (const candidate of nested) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return null;
}
