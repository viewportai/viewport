import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../core/config.js';
import { richMessagesFromUpdates } from './replay-events.js';
import type { PersistedReplayMeta, SessionUpdateEntry } from './replay-types.js';

interface PersistedJournalEntry {
  seq: number;
  sessionId: string;
  update: Record<string, unknown>;
}

const REPLAY_DIR = 'replay';

export function defaultReplayStorageDir(): string {
  return path.join(configDir(), REPLAY_DIR);
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
) {
  const persisted = loadPersistedJournalEntries(sessionId, options);
  return richMessagesFromUpdates(persisted.entries);
}

export function loadPersistedJournalEntries(
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

export async function appendPersistedJournalEntry(
  entry: SessionUpdateEntry,
  storageDir: string,
): Promise<void> {
  const filePath = journalFilePath(entry.sessionId, storageDir);
  const payload =
    JSON.stringify({
      seq: entry.seq,
      sessionId: entry.sessionId,
      update: entry.update,
    }) + '\n';

  await fsPromises.appendFile(filePath, payload, { encoding: 'utf8', mode: 0o600 });
  await ensureFileMode(filePath, 0o600);
}

export async function rewritePersistedJournal(
  sessionId: string,
  storageDir: string,
  entries: SessionUpdateEntry[],
): Promise<void> {
  const filePath = journalFilePath(sessionId, storageDir);
  if (entries.length === 0) {
    try {
      await fsPromises.unlink(filePath);
    } catch {
      // Best-effort cleanup only.
    }
    return;
  }

  const payload =
    entries
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
}

export async function writePersistedReplayMeta(
  meta: PersistedReplayMeta,
  storageDir: string,
): Promise<void> {
  const filePath = metaFilePath(meta.sessionId, storageDir);
  const payload = JSON.stringify(meta) + '\n';
  await fsPromises.writeFile(filePath, payload, { mode: 0o600 });
  await ensureFileMode(filePath, 0o600);
}

function replayStorageDir(explicit?: string): string {
  return explicit ?? defaultReplayStorageDir();
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

async function ensureFileMode(filePath: string, mode: number): Promise<void> {
  try {
    await fsPromises.chmod(filePath, mode);
  } catch {
    // Best-effort only.
  }
}
