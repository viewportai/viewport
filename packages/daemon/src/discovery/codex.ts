import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DiscoveredSession, SessionDiscovery } from '../core/interfaces.js';
import { dedupeBySessionId } from './dedupe.js';
import { parseCodexSessionFile, type ParsedCodexSession } from './codex-parser.js';
import {
  readRichSessionMessagesFromFile,
  readRichSessionMessagesTailPageFromFile,
  readRichSessionMessagesTailFromFile,
  type RichSessionTailPage,
  type RichSessionMessage,
} from './jsonl-reader.js';

const MAX_FILES_PER_SCAN = 2_000;
const DEFAULT_PARSED_CACHE_REUSE_MS = 30_000;

export interface CodexDiscoveryOptions {
  /**
   * Reuse the parsed global Codex session tree for this long before checking
   * file fingerprints again. Discovery asks the same provider once per
   * registered directory, so checking the full Codex tree on every call makes
   * daemon startup scale with directories * sessions. A short reuse window keeps
   * startup responsive while the file watcher/tailer handles live transcript
   * updates.
   */
  parsedCacheReuseMs?: number;
}

export class CodexDiscovery implements SessionDiscovery {
  readonly agentId = 'codex';
  private parsedCache: {
    loadedAt: number;
    sessions: ParsedCodexSession[];
    fingerprint: SessionFileFingerprint;
  } | null = null;

  constructor(private readonly options: CodexDiscoveryOptions = {}) {}

  async discoverSessions(projectPath: string): Promise<DiscoveredSession[]> {
    const target = path.resolve(projectPath);
    const parsedSessions = await this.loadParsedSessions();
    const results: DiscoveredSession[] = [];

    for (const parsed of parsedSessions) {
      if (!parsed.cwd) continue;
      if (path.resolve(parsed.cwd) !== target) continue;

      results.push({
        agentId: this.agentId,
        sessionId: parsed.sessionId,
        summary: parsed.summary,
        lastModified: parsed.lastModified,
        cwd: parsed.cwd,
        resumable: true,
        messageCount: parsed.messageCount,
        sourcePath: parsed.sourcePath,
      });
    }

    results.sort((a, b) => b.lastModified - a.lastModified);
    return dedupeBySessionId(results);
  }

  private async loadParsedSessions(): Promise<ParsedCodexSession[]> {
    const now = Date.now();
    const cacheReuseMs = this.options.parsedCacheReuseMs ?? DEFAULT_PARSED_CACHE_REUSE_MS;
    if (this.parsedCache && now - this.parsedCache.loadedAt < cacheReuseMs) {
      return this.parsedCache.sessions;
    }

    const files = await listSessionFiles(codexSessionsDir());
    const fingerprint = await fingerprintSessionFiles(files);
    if (this.parsedCache && sameFingerprint(this.parsedCache.fingerprint, fingerprint)) {
      this.parsedCache.loadedAt = now;
      return this.parsedCache.sessions;
    }

    const sessions: ParsedCodexSession[] = [];
    for (const filePath of files) {
      const parsed = await parseCodexSessionFile(filePath);
      if (parsed) sessions.push(parsed);
    }
    this.parsedCache = { loadedAt: now, sessions, fingerprint };
    return sessions;
  }
}

interface SessionFileFingerprint {
  fileCount: number;
  newestMtimeMs: number;
  totalMtimeMs: number;
  totalSize: number;
}

async function fingerprintSessionFiles(files: string[]): Promise<SessionFileFingerprint> {
  let newestMtimeMs = 0;
  let totalMtimeMs = 0;
  let totalSize = 0;
  for (const filePath of files) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) continue;
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
    totalMtimeMs += stat.mtimeMs;
    totalSize += stat.size;
  }
  return { fileCount: files.length, newestMtimeMs, totalMtimeMs, totalSize };
}

function sameFingerprint(a: SessionFileFingerprint, b: SessionFileFingerprint): boolean {
  return (
    a.fileCount === b.fileCount &&
    a.newestMtimeMs === b.newestMtimeMs &&
    a.totalMtimeMs === b.totalMtimeMs &&
    a.totalSize === b.totalSize
  );
}

export function codexHomeDir(): string {
  const fromEnv = process.env['CODEX_HOME'];
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.codex');
}

export function codexSessionsDir(): string {
  return path.join(codexHomeDir(), 'sessions');
}

export async function findCodexSessionFile(
  sessionId: string,
  preferredSourcePath?: string,
): Promise<string | null> {
  if (preferredSourcePath) {
    try {
      await fs.access(preferredSourcePath);
      return preferredSourcePath;
    } catch {
      // Fall through to search by ID.
    }
  }

  const files = await listSessionFiles(codexSessionsDir());
  for (const filePath of files) {
    const parsed = await parseCodexSessionFile(filePath);
    if (!parsed) continue;
    if (parsed.sessionId === sessionId) return filePath;
  }
  return null;
}

export async function readCodexSessionMessagesRich(
  sessionId: string,
  preferredSourcePath?: string,
  options: { limit?: number } = {},
): Promise<RichSessionMessage[]> {
  const filePath = await findCodexSessionFile(sessionId, preferredSourcePath);
  if (!filePath) {
    throw new Error(`Codex session file not found for ${sessionId}`);
  }
  if (options.limit && options.limit > 0) {
    return readRichSessionMessagesTailFromFile(filePath, options.limit);
  }
  return readRichSessionMessagesFromFile(filePath);
}

export async function readCodexSessionMessagesPageRich(
  sessionId: string,
  preferredSourcePath: string | undefined,
  options: { limit: number; offset?: number },
): Promise<RichSessionTailPage> {
  const filePath = await findCodexSessionFile(sessionId, preferredSourcePath);
  if (!filePath) {
    throw new Error(`Codex session file not found for ${sessionId}`);
  }
  return readRichSessionMessagesTailPageFromFile(filePath, options.limit, options.offset ?? 0);
}

async function listSessionFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [rootDir];

  while (queue.length > 0 && out.length < MAX_FILES_PER_SCAN) {
    const dir = queue.shift();
    if (!dir) continue;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => b.name.localeCompare(a.name));

    for (const entry of entries) {
      if (out.length >= MAX_FILES_PER_SCAN) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')) continue;
      out.push(full);
    }
  }

  return out;
}
