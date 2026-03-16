/**
 * Hybrid replay store for session update reconnects.
 *
 * Keeps a bounded in-memory ring for recent live traffic and a durable
 * per-session journal for canonical recoverable events. Sequence allocation is
 * persisted so replay can continue across daemon restarts even when some
 * transient updates are intentionally not journaled.
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { RichSessionMessage } from '../discovery/jsonl-reader.js';
import { configDir } from '../core/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionUpdateEntry {
  seq: number;
  sessionId: string;
  update: Record<string, unknown>;
}

export interface ReplayWindow {
  entries: SessionUpdateEntry[];
  droppedWindow: boolean;
  requestedLastSeq: number;
  earliestAvailableSeq: number;
  latestAvailableSeq: number;
}

export interface PersistedReplayMeta {
  sessionId: string;
  directoryId?: string;
  latestSeq: number;
  updatedAt: number;
}

export interface RingBufferOptions {
  sessionId?: string;
  storageDir?: string;
  durableTtlMs?: number;
  maxDurableEntries?: number;
}

interface PersistedJournalEntry {
  seq: number;
  sessionId: string;
  update: Record<string, unknown>;
}

const DEFAULT_MAX_SIZE = 500;
const DEFAULT_MAX_DURABLE_ENTRIES = 5_000;
const DEFAULT_DURABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REPLAY_DIR = 'replay';

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

export class RingBuffer {
  private buffer: (SessionUpdateEntry | null)[];
  private writeIndex = 0;
  private count = 0;
  private seq = 0;
  private readonly maxSize: number;
  private readonly persistenceEnabled: boolean;
  private readonly storageDir: string;
  private readonly durableTtlMs: number;
  private readonly maxDurableEntries: number;
  private sessionId: string | null = null;
  private directoryId: string | undefined;
  private initialized = false;
  private durableEntries: SessionUpdateEntry[] = [];
  private persistenceDisabled = false;
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(maxSize: number, options?: RingBufferOptions);
  constructor(options?: RingBufferOptions);
  constructor(
    maxSizeOrOptions: number | RingBufferOptions = DEFAULT_MAX_SIZE,
    maybeOptions?: RingBufferOptions,
  ) {
    const maxSize = typeof maxSizeOrOptions === 'number' ? maxSizeOrOptions : DEFAULT_MAX_SIZE;
    const options = typeof maxSizeOrOptions === 'number' ? maybeOptions : maxSizeOrOptions;

    this.maxSize = maxSize;
    this.buffer = new Array(maxSize).fill(null);
    this.persistenceEnabled =
      typeof options?.sessionId === 'string' || typeof options?.storageDir === 'string';
    this.storageDir = options?.storageDir ?? path.join(configDir(), REPLAY_DIR);
    this.durableTtlMs = options?.durableTtlMs ?? DEFAULT_DURABLE_TTL_MS;
    this.maxDurableEntries = options?.maxDurableEntries ?? DEFAULT_MAX_DURABLE_ENTRIES;
    if (options?.sessionId) {
      this.ensureInitialized(options.sessionId);
    }
  }

  push(sessionId: string, update: Record<string, unknown>): SessionUpdateEntry {
    this.ensureInitialized(sessionId);
    this.seq++;
    const entry: SessionUpdateEntry = { seq: this.seq, sessionId, update };

    this.buffer[this.writeIndex] = entry;
    this.writeIndex = (this.writeIndex + 1) % this.maxSize;
    if (this.count < this.maxSize) this.count++;

    this.persistMeta();
    if (isDurableUpdate(update)) {
      this.durableEntries.push(entry);
      this.appendDurableEntry(entry);
      this.compactDurableEntries();
    }

    return entry;
  }

  getReplayWindow(lastSeq: number): ReplayWindow {
    const requestedLastSeq = Math.max(0, lastSeq);
    const entries = this.getMergedEntries();
    const earliestAvailableSeq = entries[0]?.seq ?? 0;
    const latestAvailableSeq = this.seq;

    const droppedWindow =
      requestedLastSeq > 0 &&
      earliestAvailableSeq > 0 &&
      requestedLastSeq < earliestAvailableSeq - 1;

    if (entries.length === 0 && latestAvailableSeq === 0) {
      return {
        entries: [],
        droppedWindow: false,
        requestedLastSeq,
        earliestAvailableSeq: 0,
        latestAvailableSeq: 0,
      };
    }

    const effectiveLastSeq = droppedWindow ? earliestAvailableSeq - 1 : requestedLastSeq;
    return {
      entries: this.getAfter(effectiveLastSeq),
      droppedWindow,
      requestedLastSeq,
      earliestAvailableSeq,
      latestAvailableSeq,
    };
  }

  getAfter(lastSeq: number): SessionUpdateEntry[] {
    return this.getMergedEntries().filter((entry) => entry.seq > lastSeq);
  }

  getAll(): SessionUpdateEntry[] {
    return this.getAfter(0);
  }

  setDirectoryId(directoryId: string | undefined): void {
    if (!directoryId || directoryId === this.directoryId) {
      return;
    }
    this.directoryId = directoryId;
    if (this.sessionId) {
      this.persistMeta();
    }
  }

  getDirectoryId(): string | undefined {
    return this.directoryId;
  }

  getRichHistory(): RichSessionMessage[] {
    return richMessagesFromUpdates(this.durableEntries);
  }

  async flushPersistence(): Promise<void> {
    await this.persistenceQueue;
  }

  private ensureInitialized(sessionId: string): void {
    if (this.initialized && this.sessionId === sessionId) {
      return;
    }
    this.initialized = true;
    this.sessionId = sessionId;
    if (!this.persistenceEnabled) {
      return;
    }
    try {
      fs.mkdirSync(this.storageDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(this.storageDir, 0o700);
      } catch {
        // Best-effort hardening.
      }
    } catch {
      this.persistenceDisabled = true;
      return;
    }

    const meta = readPersistedReplayMeta(sessionId, { storageDir: this.storageDir });
    const durableEntries = loadPersistedJournalEntries(sessionId, { storageDir: this.storageDir });
    this.durableEntries = durableEntries.entries;
    this.directoryId = meta?.directoryId;
    this.seq = Math.max(meta?.latestSeq ?? 0, durableEntries.entries.at(-1)?.seq ?? 0);

    if (durableEntries.needsRewrite) {
      this.rewriteDurableJournal();
    }
    this.compactDurableEntries();
  }

  private appendDurableEntry(entry: SessionUpdateEntry): void {
    if (!this.persistenceEnabled || this.persistenceDisabled) {
      return;
    }
    const filePath = journalFilePath(entry.sessionId, this.storageDir);
    const payload =
      JSON.stringify({
        seq: entry.seq,
        sessionId: entry.sessionId,
        update: entry.update,
      }) + '\n';

    this.enqueuePersistence(async () => {
      await fsPromises.appendFile(filePath, payload, { encoding: 'utf8', mode: 0o600 });
      await ensureFileMode(filePath, 0o600);
    });
  }

  private compactDurableEntries(): void {
    if (this.durableEntries.length === 0 || !this.sessionId) {
      return;
    }

    const now = Date.now();
    const ttlCutoff = now - this.durableTtlMs;
    const retainedByTtl = this.durableEntries.filter((entry) =>
      entryHasTimestamp(entry, ttlCutoff),
    );
    const retained =
      retainedByTtl.length > this.maxDurableEntries
        ? retainedByTtl.slice(-this.maxDurableEntries)
        : retainedByTtl;

    if (retained.length === this.durableEntries.length) {
      return;
    }

    this.durableEntries = retained;
    this.rewriteDurableJournal();
  }

  private rewriteDurableJournal(): void {
    if (!this.persistenceEnabled || !this.sessionId || this.persistenceDisabled) {
      return;
    }

    const filePath = journalFilePath(this.sessionId, this.storageDir);
    const snapshot = [...this.durableEntries];
    this.enqueuePersistence(async () => {
      if (snapshot.length === 0) {
        try {
          await fsPromises.unlink(filePath);
        } catch {
          // Best-effort cleanup only.
        }
        return;
      }

      const payload =
        snapshot
          .map((entry) =>
            JSON.stringify({
              seq: entry.seq,
              sessionId: entry.sessionId,
              update: entry.update,
            }),
          )
          .join('\n') + '\n';
      const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      await fsPromises.writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 });
      await ensureFileMode(tempPath, 0o600);
      await fsPromises.rename(tempPath, filePath);
      await ensureFileMode(filePath, 0o600);
    });
  }

  private persistMeta(): void {
    if (!this.persistenceEnabled || !this.sessionId || this.persistenceDisabled) {
      return;
    }

    const meta: PersistedReplayMeta = {
      sessionId: this.sessionId,
      directoryId: this.directoryId,
      latestSeq: this.seq,
      updatedAt: Date.now(),
    };
    const filePath = metaFilePath(this.sessionId, this.storageDir);
    const payload = JSON.stringify(meta) + '\n';
    this.enqueuePersistence(async () => {
      await fsPromises.writeFile(filePath, payload, { mode: 0o600 });
      await ensureFileMode(filePath, 0o600);
    });
  }

  private enqueuePersistence(task: () => Promise<void>): void {
    if (!this.persistenceEnabled || this.persistenceDisabled) {
      return;
    }
    this.persistenceQueue = this.persistenceQueue
      .then(async () => {
        if (this.persistenceDisabled) return;
        try {
          await task();
        } catch {
          this.persistenceDisabled = true;
        }
      })
      .catch(() => {
        this.persistenceDisabled = true;
      });
  }

  private getMemoryEntries(): SessionUpdateEntry[] {
    const result: SessionUpdateEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.writeIndex - this.count + i + this.maxSize) % this.maxSize;
      const entry = this.buffer[idx];
      if (entry) {
        result.push(entry);
      }
    }
    return result;
  }

  private getMergedEntries(): SessionUpdateEntry[] {
    const merged = [...this.durableEntries];
    const seenSeqs = new Set(merged.map((entry) => entry.seq));

    for (const entry of this.getMemoryEntries()) {
      if (seenSeqs.has(entry.seq)) {
        continue;
      }
      seenSeqs.add(entry.seq);
      merged.push(entry);
    }

    merged.sort((a, b) => a.seq - b.seq);
    return merged;
  }
}

export function readPersistedReplayMeta(
  sessionId: string,
  options?: { storageDir?: string },
): PersistedReplayMeta | null {
  try {
    const raw = fs.readFileSync(metaFilePath(sessionId, options?.storageDir), 'utf8');
    const parsed = JSON.parse(raw) as PersistedReplayMeta;
    if (!parsed || typeof parsed.latestSeq !== 'number' || parsed.sessionId !== sessionId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function readPersistedSessionMessagesRich(
  sessionId: string,
  options?: { storageDir?: string },
): RichSessionMessage[] {
  const persisted = loadPersistedJournalEntries(sessionId, options);
  return richMessagesFromUpdates(persisted.entries);
}

function replayStorageDir(explicit?: string): string {
  return explicit ?? path.join(configDir(), REPLAY_DIR);
}

function safeSessionFileName(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

function journalFilePath(sessionId: string, explicitStorageDir?: string): string {
  return path.join(replayStorageDir(explicitStorageDir), `${safeSessionFileName(sessionId)}.jsonl`);
}

function metaFilePath(sessionId: string, explicitStorageDir?: string): string {
  return path.join(
    replayStorageDir(explicitStorageDir),
    `${safeSessionFileName(sessionId)}.meta.json`,
  );
}

function loadPersistedJournalEntries(
  sessionId: string,
  options?: { storageDir?: string },
): { entries: SessionUpdateEntry[]; needsRewrite: boolean } {
  const filePath = journalFilePath(sessionId, options?.storageDir);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    const entries: SessionUpdateEntry[] = [];
    let needsRewrite = false;
    let lastSeq = 0;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as PersistedJournalEntry;
        if (
          parsed.sessionId !== sessionId ||
          typeof parsed.seq !== 'number' ||
          parsed.seq <= lastSeq ||
          typeof parsed.update !== 'object' ||
          parsed.update === null
        ) {
          needsRewrite = true;
          continue;
        }
        entries.push({
          seq: parsed.seq,
          sessionId: parsed.sessionId,
          update: parsed.update,
        });
        lastSeq = parsed.seq;
      } catch {
        needsRewrite = true;
      }
    }

    return { entries, needsRewrite };
  } catch {
    return { entries: [], needsRewrite: false };
  }
}

function richMessagesFromUpdates(entries: SessionUpdateEntry[]): RichSessionMessage[] {
  const blocks: RichSessionMessage[] = [];

  for (const entry of entries) {
    const updateType =
      typeof entry.update['updateType'] === 'string' ? entry.update['updateType'] : '';
    const timestamp = updateTimestamp(entry.update);
    const uuid = `replay-${entry.seq}`;

    switch (updateType) {
      case 'user-message':
        if (
          typeof entry.update['text'] === 'string' &&
          typeof entry.update['messageId'] === 'string'
        ) {
          blocks.push({
            kind: 'text',
            role: 'user',
            text: entry.update['text'],
            ts: timestamp,
            uuid: entry.update['messageId'],
          });
        }
        break;
      case 'agent-message':
        if (
          typeof entry.update['text'] === 'string' &&
          typeof entry.update['messageId'] === 'string'
        ) {
          blocks.push({
            kind: 'text',
            role: 'assistant',
            text: entry.update['text'],
            ts: timestamp,
            uuid: entry.update['messageId'],
          });
        }
        break;
      case 'tool-call':
        if (
          typeof entry.update['toolCallId'] === 'string' &&
          typeof entry.update['toolName'] === 'string'
        ) {
          blocks.push({
            kind: 'tool_use',
            toolId: entry.update['toolCallId'],
            toolName: entry.update['toolName'],
            input:
              typeof entry.update['input'] === 'object' && entry.update['input'] !== null
                ? (entry.update['input'] as Record<string, unknown>)
                : {},
            ts: timestamp,
            uuid,
          });
        }
        break;
      case 'tool-call-update':
        if (typeof entry.update['toolCallId'] === 'string') {
          blocks.push({
            kind: 'tool_result',
            toolId: entry.update['toolCallId'],
            output: typeof entry.update['output'] === 'string' ? entry.update['output'] : '',
            isError: entry.update['status'] === 'error',
            ts: timestamp,
            uuid,
          });
        }
        break;
      default:
        break;
    }
  }

  return blocks;
}

function updateTimestamp(update: Record<string, unknown>): string {
  const timestamp = typeof update['timestamp'] === 'number' ? update['timestamp'] : Date.now();
  return new Date(timestamp).toISOString();
}

function entryHasTimestamp(entry: SessionUpdateEntry, cutoff: number): boolean {
  const timestamp = entry.update['timestamp'];
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return false;
  }
  return timestamp >= cutoff;
}

function isDurableUpdate(update: Record<string, unknown>): boolean {
  const updateType = update['updateType'];
  if (typeof updateType !== 'string') {
    return false;
  }
  const timestamp = update['timestamp'];
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return false;
  }

  switch (updateType) {
    case 'agent-message':
    case 'user-message':
    case 'tool-call':
    case 'tool-call-update':
    case 'token-usage':
    case 'state-change':
    case 'step-committed':
    case 'step-rollback':
    case 'step-branch-retry':
    case 'step-squash-merged':
    case 'permission-request':
    case 'permission-resolved':
    case 'attention':
      return true;
    default:
      return false;
  }
}

async function ensureFileMode(filePath: string, mode: number): Promise<void> {
  try {
    await fsPromises.chmod(filePath, mode);
  } catch {
    // Best-effort only.
  }
}
