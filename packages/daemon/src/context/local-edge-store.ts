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
  readContextMetadata,
  readContextMetadataRecords,
  toPublicContextRecord,
  touchContextMetadata,
  writeContextMetadata,
} from './local-edge-metadata.js';
import { repoIdForContextResource } from './local-edge-paths.js';
import {
  CONTEXT_BUNDLE_SCHEMA_VERSION,
  CONTEXT_EVENT_SCHEMA_VERSION,
  SERVER_SYNC_MODE,
  type ContextBundle,
  type ContextCredentials,
  type ContextKeyStore,
  type ContextResourceRecord,
  type ContextScope,
  type ContextStoredEntry,
} from './local-edge-types.js';

export type {
  ContextBundle,
  ContextCandidateProposal,
  ContextCredentials,
  ContextResourceRecord,
  ContextKeyStore,
  ContextScope,
  ContextStoredEntry,
} from './local-edge-types.js';

export { isResolverPinMismatch };

export async function initContextResource(options: {
  contextResourceId: string;
  userName: string;
  deviceName: string;
  credentials: ContextCredentials;
  keyStore?: ContextKeyStore;
  home?: string;
}): Promise<ContextResourceRecord> {
  const home = options.home ?? configDir();
  const keyStore = options.keyStore ?? resolveContextKeyStore();
  const vault = createVault(home, keyStore);
  await ensureUserAndDevice(vault, {
    userName: options.userName,
    deviceName: options.deviceName,
    credentials: options.credentials,
  });
  await ensureRepo(vault, {
    repoId: repoIdForContextResource(options.contextResourceId),
    contextResourceId: options.contextResourceId,
    userName: options.userName,
    deviceName: options.deviceName,
    home,
    keyStore,
  });
  return readContextMetadata(options.contextResourceId, home);
}

export async function joinContextResource(options: {
  contextResourceId: string;
  userName: string;
  deviceName: string;
  credentials: ContextCredentials;
  keyStore?: ContextKeyStore;
  home?: string;
}): Promise<ContextResourceRecord> {
  const home = options.home ?? configDir();
  const keyStore = options.keyStore ?? resolveContextKeyStore();
  const vault = createVault(home, keyStore);
  await ensureUserOrApprovedDevice(vault, {
    userName: options.userName,
    deviceName: options.deviceName,
    credentials: options.credentials,
  });
  const now = new Date().toISOString();
  await writeContextMetadata(
    {
      schemaVersion: CONTEXT_EVENT_SCHEMA_VERSION,
      engine: '@viewportai/context-engine',
      contextResourceId: options.contextResourceId,
      repoId: repoIdForContextResource(options.contextResourceId),
      userName: options.userName,
      deviceName: options.deviceName,
      keyStore,
      serverSync: SERVER_SYNC_MODE,
      createdAt: now,
      updatedAt: now,
    },
    home,
  );
  return readContextMetadata(options.contextResourceId, home);
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
  contextResourceId: string;
  actorName: string;
  recipientName: string;
  credentials: ContextCredentials;
  home?: string;
}): Promise<{ event: unknown; repoId: string }> {
  const home = options.home ?? configDir();
  const metadata = await readContextMetadata(options.contextResourceId, home);
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
  await touchContextMetadata(metadata, home);
  return { event, repoId: metadata.repoId };
}

export async function readContextStatus(options: {
  contextResourceId?: string;
  home?: string;
}): Promise<{
  contexts: Array<ContextResourceRecord & { entryCount: number }>;
}> {
  const home = options.home ?? configDir();
  const records = await readContextMetadataRecords(home);
  const filtered = options.contextResourceId
    ? records.filter((record) => record.contextResourceId === options.contextResourceId)
    : records;

  return {
    contexts: await Promise.all(
      filtered.map(async (record) => ({
        ...toPublicContextRecord(record),
        entryCount: await countApprovedEntryEvents(record.repoId, home),
      })),
    ),
  };
}

export async function addContextEntry(options: {
  contextResourceId: string;
  actorName: string;
  title: string;
  body: string;
  source?: string;
  scope?: ContextScope;
  credentials: ContextCredentials;
  home?: string;
}): Promise<ContextStoredEntry> {
  const home = options.home ?? configDir();
  const metadata = await readContextMetadata(options.contextResourceId, home);
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

  const scope = options.scope ?? 'resource';
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
  await touchContextMetadata(metadata, home);

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
  contextResourceId: string;
  actorName: string;
  query: string;
  credentials?: ContextCredentials;
  includePrivate?: boolean;
  profile?: string;
  profilePin?: { path?: string; digest?: string };
  home?: string;
}): Promise<ContextBundle> {
  const home = options.home ?? configDir();
  const metadata = await readContextMetadata(options.contextResourceId, home);
  const vault = createVault(home, metadata.keyStore);
  const credentials = options.credentials ?? { passphrase: '', recoveryCode: '' };
  assertCredentialsOrApprovedDevice(vault, {
    userName: metadata.userName,
    deviceName: options.actorName,
    credentials,
  });
  await ensureUserOrApprovedDevice(vault, {
    userName: metadata.userName,
    deviceName: options.actorName,
    credentials,
  });

  const engineBundle = vault.resolveBundle({
    repoId: metadata.repoId,
    actorName: options.actorName,
    includePrivate: options.includePrivate ?? false,
    query: options.query.trim() === '' ? null : options.query,
    profile: options.profile ?? null,
    profilePin: options.profilePin ?? null,
  });

  return {
    manifest: {
      schemaVersion: CONTEXT_BUNDLE_SCHEMA_VERSION,
      apiVersion: CONTEXT_BUNDLE_SCHEMA_VERSION,
      contextResourceId: metadata.contextResourceId,
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
  contextResourceId: string;
  name: string;
  packs: string[];
  query: string;
  maxItems?: number;
  credentials: ContextCredentials;
  home?: string;
}): Promise<{ path: string; digest: string }> {
  const home = options.home ?? configDir();
  const metadata = await readContextMetadata(options.contextResourceId, home);
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
