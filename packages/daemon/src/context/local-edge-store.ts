import { configDir } from '../core/config.js';
import { digestText } from './local-edge-crypto.js';
import { resolveContextKeyStore } from './local-edge-key-store.js';
import {
  assertCredentials,
  assertCredentialsOrApprovedDevice,
  createVault,
  ensureRepo,
  ensureUserAndDevice,
  ensureUserOrApprovedDevice,
  isResolverPinMismatch,
} from './local-edge-engine.js';
import {
  countApprovedEntryEvents,
  readProjectMetadata,
  readProjectMetadataRecords,
  toPublicProjectRecord,
  touchProjectMetadata,
  writeProjectMetadata,
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
  type ContextKeyStore,
  type ContextProjectRecord,
  type ContextScope,
  type ContextStoredEntry,
} from './local-edge-types.js';

export type {
  ContextBundle,
  ContextCandidateProposal,
  ContextCredentials,
  ContextProjectRecord,
  ContextKeyStore,
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
  keyStore?: ContextKeyStore;
  home?: string;
}): Promise<ContextProjectRecord> {
  const home = options.home ?? configDir();
  const keyStore = options.keyStore ?? resolveContextKeyStore();
  await migrateLegacyProjectIfNeeded({
    projectId: options.projectId,
    home,
    credentials: options.credentials,
    keyStore,
  });
  const vault = createVault(home, keyStore);
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
    keyStore,
  });
  return readProjectMetadata(options.projectId, home);
}

export async function joinContextProject(options: {
  projectId: string;
  userName: string;
  deviceName: string;
  credentials: ContextCredentials;
  keyStore?: ContextKeyStore;
  home?: string;
}): Promise<ContextProjectRecord> {
  const home = options.home ?? configDir();
  const keyStore = options.keyStore ?? resolveContextKeyStore();
  const vault = createVault(home, keyStore);
  await ensureUserOrApprovedDevice(vault, {
    userName: options.userName,
    deviceName: options.deviceName,
    credentials: options.credentials,
  });
  const now = new Date().toISOString();
  await writeProjectMetadata(
    {
      schemaVersion: CONTEXT_EVENT_SCHEMA_VERSION,
      engine: '@viewportai/context-engine',
      projectId: options.projectId,
      repoId: repoIdForProject(options.projectId),
      userName: options.userName,
      deviceName: options.deviceName,
      keyStore,
      serverSync: SERVER_SYNC_MODE,
      createdAt: now,
      updatedAt: now,
    },
    home,
  );
  return readProjectMetadata(options.projectId, home);
}

export async function initContextUser(options: {
  userName: string;
  deviceName: string;
  credentials: ContextCredentials;
  keyStore?: ContextKeyStore;
  home?: string;
}): Promise<{ userName: string; deviceName: string; keyStore: ContextKeyStore }> {
  const home = options.home ?? configDir();
  const keyStore = options.keyStore ?? resolveContextKeyStore();
  const vault = createVault(home, keyStore);
  await ensureUserAndDevice(vault, {
    userName: options.userName,
    deviceName: options.deviceName,
    credentials: options.credentials,
  });
  return { userName: options.userName, deviceName: options.deviceName, keyStore };
}

export function exportContextIdentity(options: {
  name: string;
  home?: string;
}): Record<string, unknown> {
  return createVault(options.home ?? configDir()).exportPublicIdentity(options.name);
}

export function importContextIdentity(options: {
  identity: Record<string, unknown>;
  home?: string;
}): Record<string, unknown> {
  createVault(options.home ?? configDir()).importPublicIdentity(options.identity);
  return options.identity;
}

export function createContextDeviceRequest(options: {
  deviceName: string;
  code: string;
  keyStore?: ContextKeyStore;
  home?: string;
}): unknown {
  const home = options.home ?? configDir();
  const keyStore = options.keyStore ?? resolveContextKeyStore();
  return createVault(home, keyStore).createDeviceApprovalRequest({
    deviceName: options.deviceName,
    code: options.code,
  });
}

export async function approveContextDeviceRequest(options: {
  userName: string;
  request: unknown;
  code: string;
  credentials: ContextCredentials;
  home?: string;
}): Promise<unknown> {
  return createVault(options.home ?? configDir()).approveDeviceRequest({
    userName: options.userName,
    request: options.request,
    code: options.code,
    ...options.credentials,
  });
}

export async function acceptContextDeviceApproval(options: {
  userName: string;
  deviceName: string;
  approval: unknown;
  code: string;
  keyStore?: ContextKeyStore;
  home?: string;
}): Promise<unknown> {
  const home = options.home ?? configDir();
  const keyStore = options.keyStore ?? resolveContextKeyStore();
  return createVault(home, keyStore).acceptDeviceApproval({
    userName: options.userName,
    deviceName: options.deviceName,
    approval: options.approval,
    code: options.code,
  });
}

export async function grantContextUser(options: {
  projectId: string;
  actorName: string;
  recipientName: string;
  credentials: ContextCredentials;
  home?: string;
}): Promise<{ event: unknown; repoId: string }> {
  const home = options.home ?? configDir();
  const metadata = await readProjectMetadata(options.projectId, home);
  const vault = createVault(home, metadata.keyStore);
  assertCredentialsOrApprovedDevice(vault, {
    userName: metadata.userName,
    deviceName: options.actorName,
    credentials: options.credentials,
  });
  await ensureUserOrApprovedDevice(vault, {
    userName: metadata.userName,
    deviceName: options.actorName,
    credentials: options.credentials,
  });
  const event = await vault.grantRepoHpke({
    repoId: metadata.repoId,
    actorName: options.actorName,
    recipientName: options.recipientName,
  });
  await touchProjectMetadata(metadata, home);
  return { event, repoId: metadata.repoId };
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
    keyStore: 'file',
  });
  const metadata = await readProjectMetadata(options.projectId, home);
  const vault = createVault(home, metadata.keyStore);
  assertCredentialsOrApprovedDevice(vault, {
    userName: metadata.userName,
    deviceName: options.actorName,
    credentials: options.credentials,
  });
  await ensureUserOrApprovedDevice(vault, {
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
    keyStore: 'file',
  });
  const metadata = await readProjectMetadata(options.projectId, home);
  const vault = createVault(home, metadata.keyStore);
  assertCredentialsOrApprovedDevice(vault, {
    userName: metadata.userName,
    deviceName: options.actorName,
    credentials: options.credentials,
  });
  await ensureUserOrApprovedDevice(vault, {
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
  const vault = createVault(home, metadata.keyStore);
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
