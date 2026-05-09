import type { EncryptedPayload } from './local-edge-crypto.js';

export const CONTEXT_EVENT_SCHEMA_VERSION = 'viewport.context_event/v1';
export const CONTEXT_BUNDLE_SCHEMA_VERSION = 'viewport.context_bundle_manifest/v1';
export const SERVER_SYNC_MODE = 'disabled';
export const DEVICE_APPROVAL_CODE = '000000';

export type ContextScope = 'private' | 'resource' | 'team' | 'organization';
export type ContextKeyStore = 'file' | 'macos-keychain';

export interface ContextCredentials {
  passphrase: string;
  recoveryCode: string;
}

export interface ContextResourceRecord {
  schemaVersion: typeof CONTEXT_EVENT_SCHEMA_VERSION;
  contextResourceId: string;
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
  contextResourceId?: string;
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

export interface ContextCandidateDecisionPullRecord {
  schema_version: 'viewport.context_candidate_decision/v1';
  id: string;
  inbox_item_id?: string;
  repo_id: string;
  context_resource_id?: string;
  candidate_event_id: string;
  payload_digest?: string | null;
  decision: 'approved' | 'rejected';
  message?: string | null;
  decided_at?: string;
  decided_by_user_id?: string | null;
  platform_signature: {
    algorithm: 'Ed25519';
    kid: string;
    public_key: string;
    signature: string;
    signed_payload_digest: string;
  };
}

export interface ContextCandidateDecisionApplication {
  schema_version: 'viewport.context_candidate_application/v1';
  decision_id: string;
  inbox_item_id?: string | null;
  repo_id: string;
  context_resource_id?: string;
  candidate_event_id: string;
  payload_digest?: string | null;
  decision: 'approved' | 'rejected';
  status: 'applied' | 'skipped';
  reason?: string;
  actor_name: string;
  candidate_id?: string;
  emitted: number;
  applied_at: string;
  platform_signature_digest: string;
}

export interface ContextResourceMetadata extends ContextResourceRecord {
  engine: '@viewportai/context-engine';
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

export interface ContextCandidateProposal {
  id: string;
  titleDigest: string;
  bodyDigest: string;
  source: string;
  trustState: 'candidate';
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
    contextResourceId: string;
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
    id?: string;
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
  proposeEntry(options: {
    repoId: string;
    actorName: string;
    contextResourceId?: string;
    title: string;
    body: string;
    source: string;
    sourceKind: 'workflow' | 'plan' | 'integration';
  }): { id: string; createdAt: string; payloadDigest?: string; schemaVersion: string };
  grantRepoHpke(options: {
    repoId: string;
    actorName: string;
    recipientName: string;
  }): Promise<unknown>;
  allCandidates(options: { repoId: string; actorName?: string }): Array<{
    id: string;
    proposal_event_id?: string | null;
    payload_digest?: string | null;
    title: string;
    body: string;
    source?: string;
    status: string;
  }>;
  approveCandidate(options: {
    repoId: string;
    actorName: string;
    candidateId: string;
    title: string;
    body: string;
    source?: string;
    contextResourceId?: string;
    review?: Record<string, unknown>;
  }): { approved: ContextSyncEvent; entry: ContextSyncEvent };
  rejectCandidate(options: {
    repoId: string;
    actorName: string;
    candidateId: string;
    reason?: string;
  }): ContextSyncEvent;
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
