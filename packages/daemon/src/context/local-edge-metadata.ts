import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CONTEXT_EVENT_SCHEMA_VERSION,
  SERVER_SYNC_MODE,
  type ContextResourceMetadata,
  type ContextResourceRecord,
} from './local-edge-types.js';
import { contextMetadataPath } from './local-edge-paths.js';

export async function readContextMetadata(
  contextResourceId: string,
  home: string,
): Promise<ContextResourceMetadata> {
  const file = contextMetadataPath(contextResourceId, home);
  let rawText: string;
  try {
    rawText = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Context vault ${contextResourceId} is not bound on this trusted edge. Run \`vpd context use ${contextResourceId}\` in the repo, then retry.`,
      );
    }
    throw error;
  }
  const raw = JSON.parse(rawText) as unknown;
  if (!isContextMetadata(raw)) {
    throw new Error(`Invalid canonical context metadata for ${contextResourceId}`);
  }
  return withMetadataDefaults(raw);
}

export async function readContextMetadataRecords(home: string): Promise<ContextResourceMetadata[]> {
  return readMetadataDir(path.join(home, 'context', 'canonical-resources'));
}

export async function writeContextMetadata(
  record: ContextResourceMetadata,
  home: string,
): Promise<void> {
  const file = contextMetadataPath(record.contextResourceId, home);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export async function touchContextMetadata(
  record: ContextResourceMetadata,
  home: string,
): Promise<void> {
  await writeContextMetadata({ ...record, updatedAt: new Date().toISOString() }, home);
}

export async function countApprovedEntryEvents(repoId: string, home: string): Promise<number> {
  const eventsDir = path.join(home, 'repos', repoId, 'events');
  try {
    const names = await fs.readdir(eventsDir);
    let count = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const raw = JSON.parse(await fs.readFile(path.join(eventsDir, name), 'utf8')) as {
        type?: string;
      };
      if (raw.type === 'entry.approved') count += 1;
    }
    return count;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

export function toPublicContextRecord(record: ContextResourceMetadata): ContextResourceRecord {
  return {
    schemaVersion: record.schemaVersion,
    contextResourceId: record.contextResourceId,
    repoId: record.repoId,
    userName: record.userName,
    deviceName: record.deviceName,
    keyStore: record.keyStore,
    serverSync: record.serverSync,
    lastServerPullReceivedAt: record.lastServerPullReceivedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function readMetadataDir(dir: string): Promise<ContextResourceMetadata[]> {
  try {
    const names = await fs.readdir(dir);
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(
          async (name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as unknown,
        ),
    );
    return records
      .filter((record): record is ContextResourceMetadata => isContextMetadata(record))
      .map(withMetadataDefaults);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function isContextMetadata(value: unknown): value is ContextResourceMetadata {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ContextResourceMetadata>;
  return (
    record.schemaVersion === CONTEXT_EVENT_SCHEMA_VERSION &&
    record.engine === '@viewportai/context-engine' &&
    typeof record.contextResourceId === 'string' &&
    typeof record.repoId === 'string' &&
    typeof record.userName === 'string' &&
    typeof record.deviceName === 'string' &&
    (record.keyStore === undefined ||
      record.keyStore === 'file' ||
      record.keyStore === 'macos-keychain') &&
    record.serverSync === SERVER_SYNC_MODE
  );
}

function withMetadataDefaults(record: ContextResourceMetadata): ContextResourceMetadata {
  return {
    ...record,
    keyStore: record.keyStore ?? 'file',
  };
}
