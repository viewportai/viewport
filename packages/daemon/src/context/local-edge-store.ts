import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../core/config.js';
import {
  createProjectKey,
  decryptText,
  digestJson,
  digestText,
  encryptText,
  unwrapProjectKey,
  wrapProjectKey,
  type EncryptedPayload,
  type WrappedKey,
} from './local-edge-crypto.js';

/**
 * First vpd trusted-edge seam.
 *
 * This module intentionally proves the local command/API boundary before the
 * canonical Context Vault engine is moved into the daemon. It is not the stable
 * Context Vault wire format. Before platform sync or workflow context injection
 * depends on this surface, replace the internals with the HPKE signed-event
 * materializer from the standalone Context Vault POC.
 */
const SCHEMA_VERSION = 'viewport.context_local_edge/seam-v0';
const SERVER_SYNC_MODE = 'disabled';

export type ContextScope = 'private' | 'project' | 'team' | 'organization';

export interface ContextCredentials {
  passphrase: string;
  recoveryCode: string;
}

export interface ContextProjectRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  projectId: string;
  userName: string;
  deviceName: string;
  serverSync: typeof SERVER_SYNC_MODE;
  createdAt: string;
  updatedAt: string;
  wrappedProjectKey: WrappedKey;
  entries: ContextStoredEntry[];
}

export interface ContextStoredEntry {
  id: string;
  scope: ContextScope;
  title: EncryptedPayload;
  titleDigest: string;
  body: EncryptedPayload;
  bodyDigest: string;
  source: string;
  trustState: 'approved';
  actorName: string;
  createdAt: string;
}

export interface ContextResolvedItem {
  id: string;
  scope: ContextScope;
  title: string;
  body: string;
  source: string;
  trustState: 'approved';
  actorName: string;
  createdAt: string;
  digest: string;
}

export interface ContextBundle {
  manifest: {
    schemaVersion: 'viewport.context_bundle_manifest/vpd-local-v1';
    projectId: string;
    actorName: string;
    query: string;
    resolvedAt: string;
    serverSync: typeof SERVER_SYNC_MODE;
    itemCount: number;
    digest: string;
  };
  items: ContextResolvedItem[];
}

export function contextProjectPath(projectId: string, home = configDir()): string {
  return path.join(home, 'context', 'projects', `${safeProjectId(projectId)}.json`);
}

export async function initContextProject(options: {
  projectId: string;
  userName: string;
  deviceName: string;
  credentials: ContextCredentials;
  home?: string;
}): Promise<ContextProjectRecord> {
  const now = new Date().toISOString();
  const projectKey = createProjectKey();
  const record: ContextProjectRecord = {
    schemaVersion: SCHEMA_VERSION,
    projectId: options.projectId,
    userName: options.userName,
    deviceName: options.deviceName,
    serverSync: SERVER_SYNC_MODE,
    createdAt: now,
    updatedAt: now,
    wrappedProjectKey: wrapProjectKey(projectKey, options.credentials),
    entries: [],
  };

  await writeProjectRecord(record, options.home);
  return redactProjectRecord(record);
}

export async function readContextStatus(options: { projectId?: string; home?: string }): Promise<{
  projects: Array<
    Omit<ContextProjectRecord, 'wrappedProjectKey' | 'entries'> & {
      entryCount: number;
    }
  >;
}> {
  const records = await readProjectRecords(options.home);
  const filtered = options.projectId
    ? records.filter((record) => record.projectId === options.projectId)
    : records;

  return {
    projects: filtered.map((record) => ({
      schemaVersion: record.schemaVersion,
      projectId: record.projectId,
      userName: record.userName,
      deviceName: record.deviceName,
      serverSync: record.serverSync,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      entryCount: record.entries.length,
    })),
  };
}

export async function addContextEntry(options: {
  projectId: string;
  actorName: string;
  title: string;
  body: string;
  source?: string;
  scope?: ContextScope;
  credentials: ContextCredentials;
  home?: string;
}): Promise<ContextStoredEntry> {
  const record = await loadProjectRecord(options.projectId, options.home);
  const projectKey = unwrapProjectKey(record.wrappedProjectKey, options.credentials);
  const now = new Date().toISOString();
  const entry: ContextStoredEntry = {
    id: `ctx_${cryptoId()}`,
    scope: options.scope ?? 'project',
    title: encryptText(options.title, projectKey),
    titleDigest: digestText(options.title),
    body: encryptText(options.body, projectKey),
    bodyDigest: digestText(options.body),
    source: options.source ?? 'manual://vpd-context',
    trustState: 'approved',
    actorName: options.actorName,
    createdAt: now,
  };
  record.entries.push(entry);
  record.updatedAt = now;
  await writeProjectRecord(record, options.home);
  return entry;
}

export async function resolveContextBundle(options: {
  projectId: string;
  actorName: string;
  query: string;
  credentials: ContextCredentials;
  includePrivate?: boolean;
  home?: string;
}): Promise<ContextBundle> {
  const record = await loadProjectRecord(options.projectId, options.home);
  const projectKey = unwrapProjectKey(record.wrappedProjectKey, options.credentials);
  const query = options.query.trim().toLowerCase();
  const items = record.entries
    .map((entry) => ({
      ...entry,
      titleText: decryptText(entry.title, projectKey),
      bodyText: decryptText(entry.body, projectKey),
    }))
    .filter((entry) => {
      if (entry.scope === 'private' && !options.includePrivate) return false;
      if (!query) return true;
      return (
        entry.titleText.toLowerCase().includes(query) ||
        entry.bodyText.toLowerCase().includes(query)
      );
    })
    .map(({ bodyText, titleText, ...entry }) => ({
      id: entry.id,
      scope: entry.scope,
      title: titleText,
      body: bodyText,
      source: entry.source,
      trustState: entry.trustState,
      actorName: entry.actorName,
      createdAt: entry.createdAt,
      digest: entry.bodyDigest,
    }));

  const manifestBase = {
    schemaVersion: 'viewport.context_bundle_manifest/vpd-local-v1' as const,
    projectId: record.projectId,
    actorName: options.actorName,
    query: options.query,
    resolvedAt: new Date().toISOString(),
    serverSync: SERVER_SYNC_MODE as typeof SERVER_SYNC_MODE,
    itemCount: items.length,
  };

  return {
    manifest: {
      ...manifestBase,
      digest: digestJson({ ...manifestBase, items: items.map((item) => item.digest) }),
    },
    items,
  };
}

async function loadProjectRecord(
  projectId: string,
  home = configDir(),
): Promise<ContextProjectRecord> {
  const raw = JSON.parse(await fs.readFile(contextProjectPath(projectId, home), 'utf8')) as unknown;
  if (!isProjectRecord(raw)) {
    throw new Error(`Invalid local context project record for ${projectId}`);
  }
  return raw;
}

async function readProjectRecords(home = configDir()): Promise<ContextProjectRecord[]> {
  const dir = path.join(home, 'context', 'projects');
  try {
    const names = await fs.readdir(dir);
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(
          async (name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as unknown,
        ),
    );
    return records.filter((record): record is ContextProjectRecord => isProjectRecord(record));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeProjectRecord(record: ContextProjectRecord, home = configDir()): Promise<void> {
  const file = contextProjectPath(record.projectId, home);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function redactProjectRecord(record: ContextProjectRecord): ContextProjectRecord {
  return {
    ...record,
    wrappedProjectKey: {
      ...record.wrappedProjectKey,
      ciphertext: '[encrypted]',
      tag: '[encrypted]',
    },
  };
}

function isProjectRecord(value: unknown): value is ContextProjectRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ContextProjectRecord>;
  return (
    record.schemaVersion === SCHEMA_VERSION &&
    typeof record.projectId === 'string' &&
    record.serverSync === SERVER_SYNC_MODE &&
    Array.isArray(record.entries) &&
    typeof record.wrappedProjectKey?.ciphertext === 'string'
  );
}

function safeProjectId(projectId: string): string {
  return projectId.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function cryptoId(): string {
  return globalThis.crypto.randomUUID().replaceAll('-', '');
}
