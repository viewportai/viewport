import type { EncryptedPayload, WrappedKey } from './local-edge-crypto.js';

export const CONTEXT_EVENT_SCHEMA_VERSION = 'viewport.context_event/v1';
export const CONTEXT_BUNDLE_SCHEMA_VERSION = 'viewport.context_bundle_manifest/v1';
export const SERVER_SYNC_MODE = 'disabled';
export const DEVICE_APPROVAL_CODE = '000000';

export type ContextScope = 'private' | 'project' | 'team' | 'organization';
export type ContextKeyStore = 'file' | 'macos-keychain';

export interface ContextCredentials {
  passphrase: string;
  recoveryCode: string;
}

export interface ContextProjectRecord {
  schemaVersion: typeof CONTEXT_EVENT_SCHEMA_VERSION;
  projectId: string;
  repoId: string;
  userName: string;
  deviceName: string;
  keyStore: ContextKeyStore;
  serverSync: typeof SERVER_SYNC_MODE;
  lastServerPullReceivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextSyncEvent {
  id: string;
  repoId: string;
  schemaVersion: typeof CONTEXT_EVENT_SCHEMA_VERSION;
  type: string;
  actorName: string;
  keyEpoch: number;
  visibility: ContextScope;
  createdAt: string;
  [key: string]: unknown;
}

export interface ContextSyncPullRecord {
  signedEvent: ContextSyncEvent;
  receivedAt?: string;
}

export interface ContextProjectMetadata extends ContextProjectRecord {
  engine: '@viewportai/context-engine';
}

export interface LegacyContextProjectRecord {
  schemaVersion: 'viewport.context_local_edge/seam-v0';
  projectId: string;
  userName: string;
  deviceName: string;
  serverSync: typeof SERVER_SYNC_MODE;
  createdAt: string;
  updatedAt: string;
  wrappedProjectKey: WrappedKey;
  entries: LegacyContextStoredEntry[];
}

export interface LegacyContextStoredEntry {
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

export interface ContextStoredEntry {
  id: string;
  scope: ContextScope;
  title?: EncryptedPayload;
  titleDigest: string;
  body?: EncryptedPayload;
  bodyDigest: string;
  source: string;
  trustState: 'approved' | 'canonical';
  actorName: string;
  createdAt: string;
  schemaVersion: typeof CONTEXT_EVENT_SCHEMA_VERSION;
}

export interface ContextResolvedItem {
  id: string;
  scope: ContextScope;
  title: string;
  body: string;
  source?: string;
  trustState: 'approved' | 'canonical';
  actorName?: string;
  createdAt?: string;
  digest?: string;
}

export interface ContextBundle {
  manifest: {
    schemaVersion: typeof CONTEXT_BUNDLE_SCHEMA_VERSION;
    apiVersion: typeof CONTEXT_BUNDLE_SCHEMA_VERSION;
    projectId: string;
    repoId: string;
    actorName: string;
    query: string;
    resolvedAt: string;
    serverSync: typeof SERVER_SYNC_MODE;
    itemCount: number;
    digest: string;
    engineManifest: Record<string, unknown>;
  };
  items: ContextResolvedItem[];
}

export interface ContextVaultInstance {
  home: string;
  createUser(options: {
    userName: string;
    passphrase: string;
    recoveryCode: string;
  }): Record<string, unknown>;
  recoverUserIdentity(options: {
    userName: string;
    passphrase: string;
    recoveryCode: string;
  }): unknown;
  createDeviceApprovalRequest(options: { deviceName: string; code: string }): unknown;
  approveDeviceRequest(options: {
    userName: string;
    request: unknown;
    passphrase: string;
    recoveryCode: string;
    code: string;
  }): Promise<unknown>;
  acceptDeviceApproval(options: {
    userName: string;
    deviceName: string;
    approval: unknown;
    code: string;
  }): Promise<unknown>;
  getIdentity(name: string): unknown;
  exportPublicIdentity(name: string): Record<string, unknown>;
  importPublicIdentity(identity: Record<string, unknown>): void;
  getRepoMetadata(repoId: string): { createdAt?: string; currentKeyEpoch?: number };
  createRepoHpke(
    repoId: string,
    ownerName: string,
    options: { actorName: string },
  ): Promise<{ createdAt?: string }>;
  addEntry(options: {
    repoId: string;
    actorName: string;
    scope: ContextScope;
    title: string;
    body: string;
    source: string;
    sourceKind: 'human';
    trustState: 'approved';
    appliesTo: string[];
  }): { id: string; createdAt: string; payloadDigest?: string; schemaVersion: string };
  grantRepoHpke(options: {
    repoId: string;
    actorName: string;
    recipientName: string;
  }): Promise<unknown>;
  resolveBundle(options: {
    repoId: string;
    actorName: string;
    includePrivate: boolean;
    query: string;
    profile?: string | null;
    profilePin?: { path?: string; digest?: string } | null;
  }): {
    manifest: {
      apiVersion: string;
      bundle_id: string;
      resolved_at: string;
      digest: string;
      profile?: unknown;
      items?: Array<{
        entry_id: string;
        version_id?: string;
        source?: string;
        trust?: 'approved' | 'canonical';
        scope?: ContextScope;
        title?: string;
      }>;
    };
    delivery: {
      items: Array<{
        id: string;
        title: string;
        body: string;
        scope: ContextScope;
        trust: 'approved' | 'canonical';
      }>;
    };
  };
  writeProfile(options: {
    repoId: string;
    name: string;
    profile: { packs: string[]; query: string; maxItems?: number };
  }): { path: string; digest: string };
  listSyncEvents(options: { repoId: string }): ContextSyncEvent[];
  importSyncEvents(options: {
    repoId: string;
    events: ContextSyncEvent[];
    actorName: string;
  }): Promise<{
    imported: ContextSyncEvent[];
    materialized: { entries: unknown[]; candidates: unknown[] };
  }>;
}

export interface ContextIdentitySecretStore {
  setIdentitySecrets(name: string, secrets: Record<string, unknown>): void;
  getIdentitySecrets(name: string): Record<string, unknown>;
}

export type ContextVaultConstructor = new (
  home: string,
  options?: { keyStore?: ContextIdentitySecretStore | null },
) => ContextVaultInstance;
