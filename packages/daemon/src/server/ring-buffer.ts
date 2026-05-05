/**
 * Hybrid replay store for session update reconnects.
 *
 * Keeps a bounded in-memory ring for recent live traffic and a durable
 * per-session journal for canonical recoverable events. Sequence allocation is
 * persisted so replay can continue across daemon restarts even when some
 * transient updates are intentionally not journaled.
 */

import fs from 'node:fs';
import type { RichSessionMessage } from '../discovery/jsonl-reader.js';
import { entryHasTimestamp, isDurableUpdate, richMessagesFromUpdates } from './replay-events.js';
import {
  appendPersistedJournalEntry,
  defaultReplayStorageDir,
  loadPersistedJournalEntries,
  readPersistedReplayMeta,
  rewritePersistedJournal,
  writePersistedReplayMeta,
} from './replay-persistence.js';
import type {
  PersistedReplayMeta,
  ReplayWindow,
  RingBufferOptions,
  SessionUpdateEntry,
} from './replay-types.js';

export type {
  PersistedReplayMeta,
  ReplayWindow,
  RingBufferOptions,
  SessionUpdateEntry,
} from './replay-types.js';
export { readPersistedReplayMeta, readPersistedSessionMessagesRich } from './replay-persistence.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SIZE = 500;
const DEFAULT_MAX_DURABLE_ENTRIES = 5_000;
const DEFAULT_DURABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
    this.storageDir = options?.storageDir ?? defaultReplayStorageDir();
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
    this.enqueuePersistence(() => appendPersistedJournalEntry(entry, this.storageDir));
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

    const snapshot = [...this.durableEntries];
    this.enqueuePersistence(() =>
      rewritePersistedJournal(this.sessionId!, this.storageDir, snapshot),
    );
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
    this.enqueuePersistence(() => writePersistedReplayMeta(meta, this.storageDir));
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
