import { configDir } from '../core/config.js';
import { digestText } from './local-edge-crypto.js';
import {
  assertCredentials,
  createVault,
  ensureDevice,
  ensureRepo,
  ensureUserAndDevice,
  isResolverPinMismatch,
} from './local-edge-engine.js';
import {
  countApprovedEntryEvents,
  readProjectMetadata,
  readProjectMetadataRecords,
  toPublicProjectRecord,
  touchProjectMetadata,
} from './local-edge-metadata.js';
import { migrateLegacyProjectIfNeeded } from './local-edge-migration.js';
import {
  archivedContextProjectPath,
  legacyContextProjectPath,
  repoIdForProject,
} from './local-edge-paths.js';
import {
  CONTEXT_BUNDLE_SCHEMA_VERSION,
  CONTEXT_EVENT_SCHEMA_VERSION,
  SERVER_SYNC_MODE,
  type ContextBundle,
  type ContextCredentials,
  type ContextProjectRecord,
  type ContextScope,
  type ContextStoredEntry,
} from './local-edge-types.js';

export type {
  ContextBundle,
  ContextCredentials,
  ContextProjectRecord,
  ContextScope,
  ContextStoredEntry,
} from './local-edge-types.js';

export { archivedContextProjectPath, isResolverPinMismatch };

export function contextProjectPath(projectId: string, home = configDir()): string {
  return legacyContextProjectPath(projectId, home);
}

export async function initContextProject(options: {
  projectId: string;
  userName: string;
  deviceName: string;
  credentials: ContextCredentials;
  home?: string;
}): Promise<ContextProjectRecord> {
  const home = options.home ?? configDir();
  await migrateLegacyProjectIfNeeded({
    projectId: options.projectId,
    home,
    credentials: options.credentials,
  });
  const vault = createVault(home);
  await ensureUserAndDevice(vault, {
    userName: options.userName,
    deviceName: options.deviceName,
    credentials: options.credentials,
  });
  await ensureRepo(vault, {
    repoId: repoIdForProject(options.projectId),
    projectId: options.projectId,
    userName: options.userName,
    deviceName: options.deviceName,
    home,
  });
  return readProjectMetadata(options.projectId, home);
}

export async function readContextStatus(options: { projectId?: string; home?: string }): Promise<{
  projects: Array<ContextProjectRecord & { entryCount: number }>;
}> {
  const home = options.home ?? configDir();
  const records = await readProjectMetadataRecords(home);
  const filtered = options.projectId
    ? records.filter((record) => record.projectId === options.projectId)
    : records;

  return {
    projects: await Promise.all(
      filtered.map(async (record) => ({
        ...toPublicProjectRecord(record),
        entryCount: await countApprovedEntryEvents(record.repoId, home),
      })),
    ),
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
  const home = options.home ?? configDir();
  await migrateLegacyProjectIfNeeded({
    projectId: options.projectId,
    home,
    credentials: options.credentials,
  });
  const metadata = await readProjectMetadata(options.projectId, home);
  const vault = createVault(home);
  assertCredentials(vault, metadata.userName, options.credentials);
  await ensureDevice(vault, {
    userName: metadata.userName,
    deviceName: options.actorName,
    credentials: options.credentials,
  });

  const scope = options.scope ?? 'project';
  const source = options.source ?? 'manual://vpd-context';
  const event = vault.addEntry({
    repoId: metadata.repoId,
    actorName: options.actorName,
    scope,
    title: options.title,
    body: options.body,
    source,
    sourceKind: 'human',
    trustState: 'approved',
    appliesTo: [],
  });
  await touchProjectMetadata(metadata, home);

  return {
    id: event.id,
    scope,
    titleDigest: digestText(options.title),
    bodyDigest: event.payloadDigest ?? digestText(options.body),
    source,
    trustState: 'approved',
    actorName: options.actorName,
    createdAt: event.createdAt,
    schemaVersion: CONTEXT_EVENT_SCHEMA_VERSION,
  };
}

export async function resolveContextBundle(options: {
  projectId: string;
  actorName: string;
  query: string;
  credentials: ContextCredentials;
  includePrivate?: boolean;
  profile?: string;
  profilePin?: { path?: string; digest?: string };
  home?: string;
}): Promise<ContextBundle> {
  const home = options.home ?? configDir();
  await migrateLegacyProjectIfNeeded({
    projectId: options.projectId,
    home,
    credentials: options.credentials,
  });
  const metadata = await readProjectMetadata(options.projectId, home);
  const vault = createVault(home);
  assertCredentials(vault, metadata.userName, options.credentials);
  await ensureDevice(vault, {
    userName: metadata.userName,
    deviceName: options.actorName,
    credentials: options.credentials,
  });

  const engineBundle = vault.resolveBundle({
    repoId: metadata.repoId,
    actorName: options.actorName,
    includePrivate: options.includePrivate ?? false,
    query: options.query,
    profile: options.profile ?? null,
    profilePin: options.profilePin ?? null,
  });

  return {
    manifest: {
      schemaVersion: CONTEXT_BUNDLE_SCHEMA_VERSION,
      apiVersion: CONTEXT_BUNDLE_SCHEMA_VERSION,
      projectId: metadata.projectId,
      repoId: metadata.repoId,
      actorName: options.actorName,
      query: options.query,
      resolvedAt: engineBundle.manifest.resolved_at,
      serverSync: SERVER_SYNC_MODE,
      itemCount: engineBundle.delivery.items.length,
      digest: engineBundle.manifest.digest,
      engineManifest: engineBundle.manifest as unknown as Record<string, unknown>,
    },
    items: engineBundle.delivery.items.map((item) => ({
      id: item.id,
      scope: item.scope,
      title: item.title,
      body: item.body,
      trustState: item.trust,
    })),
  };
}

export async function writeContextProfile(options: {
  projectId: string;
  name: string;
  packs: string[];
  query: string;
  maxItems?: number;
  credentials: ContextCredentials;
  home?: string;
}): Promise<{ path: string; digest: string }> {
  const home = options.home ?? configDir();
  const metadata = await readProjectMetadata(options.projectId, home);
  const vault = createVault(home);
  assertCredentials(vault, metadata.userName, options.credentials);
  return vault.writeProfile({
    repoId: metadata.repoId,
    name: options.name,
    profile: {
      packs: options.packs,
      query: options.query,
      maxItems: options.maxItems,
    },
  });
}
