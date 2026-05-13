import { configDir } from '../core/config.js';
import { transportFetch, type TlsVerifyMode } from '../cli/network.js';
import {
  assertCredentialsOrApprovedDevice,
  createVault,
  ensureUserOrApprovedDevice,
} from './local-edge-engine.js';
import { applyContextCandidateDecision } from './local-edge-candidates.js';
import { readCandidateDecisionApplications } from './local-edge-decision-applications.js';
import { verifyContextCandidateDecision } from './local-edge-decision-signature.js';
import { readContextMetadata, touchContextMetadata } from './local-edge-metadata.js';
import {
  exportContextIdentity,
  grantContextUser,
  importContextIdentity,
} from './local-edge-store.js';
import type {
  ContextCandidateDecisionPullRecord,
  ContextCredentials,
  ContextSyncEvent,
  ContextSyncPullRecord,
} from './local-edge-types.js';

export async function pushContextEvents(options: {
  contextResourceId: string;
  workspaceId?: string;
  serverUrl: string;
  credential: string;
  tlsVerify?: TlsVerifyMode;
  caCertPath?: string;
  tlsPins?: string[];
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<{ accepted: number; pushed: number; repoId: string }> {
  const home = options.home ?? configDir();
  const metadata = await readContextMetadata(options.contextResourceId, home);
  const vault = createVault(home, metadata.keyStore);
  const events = vault.listSyncEvents({ repoId: metadata.repoId });
  const candidateDecisionApplications = await readCandidateDecisionApplications({
    home,
    contextResourceId: options.contextResourceId,
  });
  if (events.length === 0 && candidateDecisionApplications.length === 0) {
    return { accepted: 0, pushed: 0, repoId: metadata.repoId };
  }

  const response = await postJson(
    options.fetchImpl ?? transportFetch,
    contextRuntimeUrl(options.serverUrl, options.workspaceId ?? options.contextResourceId, 'push'),
    {
      credential: options.credential,
      ...(options.workspaceId ? { target_workspace_id: options.workspaceId } : {}),
      events,
      ...(candidateDecisionApplications.length > 0
        ? { candidate_decision_applications: candidateDecisionApplications }
        : {}),
    },
    {
      tlsVerify: options.tlsVerify,
      caCertPath: options.caCertPath,
      tlsPins: options.tlsPins,
    },
  );

  return {
    accepted: numberField(response, 'accepted'),
    pushed: events.length,
    repoId: metadata.repoId,
  };
}

export async function pullContextEvents(options: {
  contextResourceId: string;
  workspaceId?: string;
  serverUrl: string;
  credential: string;
  tlsVerify?: TlsVerifyMode;
  caCertPath?: string;
  tlsPins?: string[];
  actorName: string;
  credentials: ContextCredentials;
  trustedDecisionKeys?: Record<string, string>;
  limit?: number;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<{
  appliedCandidateDecisions: number;
  imported: number;
  pendingCandidateDecisions: number;
  pulled: number;
  repoId: string;
}> {
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

  const response = await postJson(
    options.fetchImpl ?? transportFetch,
    contextRuntimeUrl(options.serverUrl, options.workspaceId ?? options.contextResourceId, 'pull'),
    {
      credential: options.credential,
      repo_id: metadata.repoId,
      context_resource_id: options.contextResourceId,
      ...(metadata.lastServerPullReceivedAt
        ? { after_received_at: metadata.lastServerPullReceivedAt }
        : {}),
      limit: options.limit ?? 500,
    },
    {
      tlsVerify: options.tlsVerify,
      caCertPath: options.caCertPath,
      tlsPins: options.tlsPins,
    },
  );
  const records = extractPulledRecords(response);
  const events = records.map((record) => record.signedEvent);
  const imported = await vault.importSyncEvents({
    repoId: metadata.repoId,
    events,
    actorName: options.actorName,
  });
  const candidateDecisions = extractPulledCandidateDecisions(response, options.trustedDecisionKeys);
  const candidateDecisionResults = [];
  for (const decision of candidateDecisions) {
    candidateDecisionResults.push(
      await applyContextCandidateDecision({
        contextResourceId: options.contextResourceId,
        actorName: options.actorName,
        credentials: options.credentials,
        home,
        decision,
      }),
    );
  }
  const appliedCandidateDecisions = candidateDecisionResults.filter(
    (result) => result.applied,
  ).length;
  const pendingCandidateDecisions = candidateDecisionResults.filter(
    (result) => result.reason === 'candidate_not_found',
  ).length;
  await touchContextMetadata(
    {
      ...metadata,
      lastServerPullReceivedAt:
        latestReceivedAt(
          records,
          candidateDecisionResults.some((result) => result.reason === 'candidate_not_found')
            ? []
            : candidateDecisions,
        ) ?? metadata.lastServerPullReceivedAt,
    },
    home,
  );

  return {
    appliedCandidateDecisions,
    imported: imported.imported.length,
    pendingCandidateDecisions,
    pulled: events.length,
    repoId: metadata.repoId,
  };
}

export async function recordContextCandidatePreviewProof(options: {
  workspaceId: string;
  serverUrl: string;
  credential: string;
  contextResourceId: string;
  candidateEventId: string;
  payloadDigest?: string | null;
  previewDigest?: string | null;
  tlsVerify?: TlsVerifyMode;
  caCertPath?: string;
  tlsPins?: string[];
  fetchImpl?: typeof transportFetch;
}): Promise<{ previewProofId: string; expiresAt: string | null }> {
  const response = await postJson(
    options.fetchImpl ?? transportFetch,
    contextCandidatePreviewProofUrl(options.serverUrl, options.workspaceId),
    {
      credential: options.credential,
      context_resource_id: options.contextResourceId,
      candidate_event_id: options.candidateEventId,
      ...(options.payloadDigest ? { payload_digest: options.payloadDigest } : {}),
      ...(options.previewDigest ? { preview_digest: options.previewDigest } : {}),
    },
    {
      tlsVerify: options.tlsVerify,
      caCertPath: options.caCertPath,
      tlsPins: options.tlsPins,
    },
  );

  if (!response || typeof response !== 'object') {
    throw new Error('Context preview proof response was not an object');
  }
  const previewProofId = (response as { preview_proof_id?: unknown }).preview_proof_id;
  if (typeof previewProofId !== 'string' || previewProofId === '') {
    throw new Error('Context preview proof response did not include preview_proof_id');
  }

  const expiresAt = (response as { expires_at?: unknown }).expires_at;
  return {
    previewProofId,
    expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
  };
}

export async function publishContextPublicIdentity(options: {
  workspaceId: string;
  serverUrl: string;
  credential: string;
  identityName: string;
  tlsVerify?: TlsVerifyMode;
  caCertPath?: string;
  tlsPins?: string[];
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<{ identityId: string; fingerprint: string | null }> {
  const publicIdentity = exportContextIdentity({
    name: options.identityName,
    home: options.home,
  });
  const response = await postJson(
    options.fetchImpl ?? transportFetch,
    contextPublicIdentityUrl(options.serverUrl, options.workspaceId),
    {
      credential: options.credential,
      name: options.identityName,
      public_identity: publicIdentity,
    },
    {
      tlsVerify: options.tlsVerify,
      caCertPath: options.caCertPath,
      tlsPins: options.tlsPins,
    },
  );
  const identity = objectField(response, 'identity');
  return {
    identityId: stringField(identity, 'id'),
    fingerprint: nullableStringField(identity, 'fingerprint'),
  };
}

export async function processPendingContextGrants(options: {
  contextResourceId: string;
  workspaceId: string;
  serverUrl: string;
  credential: string;
  actorName: string;
  credentials: ContextCredentials;
  tlsVerify?: TlsVerifyMode;
  caCertPath?: string;
  tlsPins?: string[];
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<{ emitted: number; missingIdentity: number; pushed: number }> {
  const fetchImpl = options.fetchImpl ?? transportFetch;
  const response = await postJson(
    fetchImpl,
    contextPendingGrantsUrl(options.serverUrl, options.workspaceId),
    {
      credential: options.credential,
      context_resource_id: options.contextResourceId,
    },
    {
      tlsVerify: options.tlsVerify,
      caCertPath: options.caCertPath,
      tlsPins: options.tlsPins,
    },
  );

  const grants = arrayField(response, 'grants');
  let emitted = 0;
  let missingIdentity = 0;
  let pushed = 0;

  for (const grant of grants) {
    const record = objectValue(grant);
    const recipient = objectField(record, 'recipient_identity', false);
    if (!recipient) {
      missingIdentity++;
      continue;
    }
    const publicIdentity = objectField(recipient, 'public_identity');
    const recipientName = stringField(recipient, 'name');
    importContextIdentity({ identity: publicIdentity, home: options.home });

    const result = await grantContextUser({
      contextResourceId: options.contextResourceId,
      actorName: options.actorName,
      recipientName,
      credentials: options.credentials,
      home: options.home,
    });
    const event = objectValue(result.event);
    const grantEventId = stringField(event, 'id');
    const grantPayload = objectField(event, 'grant', false);
    const keyEpoch = grantPayload ? numberField(grantPayload, 'keyEpoch', false) : null;

    const pushResult = await pushContextEvents({
      contextResourceId: options.contextResourceId,
      workspaceId: options.workspaceId,
      serverUrl: options.serverUrl,
      credential: options.credential,
      tlsVerify: options.tlsVerify,
      caCertPath: options.caCertPath,
      tlsPins: options.tlsPins,
      home: options.home,
      fetchImpl,
    });
    pushed += pushResult.accepted;

    await postJson(
      fetchImpl,
      contextMarkGrantEmittedUrl(options.serverUrl, options.workspaceId),
      {
        credential: options.credential,
        crypto_grant_id: stringField(record, 'id'),
        grant_event_id: grantEventId,
        ...(keyEpoch !== null ? { key_epoch: keyEpoch } : {}),
      },
      {
        tlsVerify: options.tlsVerify,
        caCertPath: options.caCertPath,
        tlsPins: options.tlsPins,
      },
    );
    emitted++;
  }

  return { emitted, missingIdentity, pushed };
}

function contextRuntimeUrl(
  serverUrl: string,
  workspaceId: string,
  operation: 'push' | 'pull',
): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/api/runtime/workspaces/${encodeURIComponent(workspaceId)}/context-vault/events/${operation}`;
}

function contextCandidatePreviewProofUrl(serverUrl: string, workspaceId: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/api/runtime/workspaces/${encodeURIComponent(workspaceId)}/context-vault/candidates/preview-proof`;
}

function contextPublicIdentityUrl(serverUrl: string, workspaceId: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/api/runtime/workspaces/${encodeURIComponent(workspaceId)}/context-vault/identities`;
}

function contextPendingGrantsUrl(serverUrl: string, workspaceId: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/api/runtime/workspaces/${encodeURIComponent(workspaceId)}/context-vault/grants/pending`;
}

function contextMarkGrantEmittedUrl(serverUrl: string, workspaceId: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/api/runtime/workspaces/${encodeURIComponent(workspaceId)}/context-vault/grants/mark-emitted`;
}

async function postJson(
  fetchImpl: typeof transportFetch,
  url: string,
  body: Record<string, unknown>,
  transportOptions: {
    tlsVerify?: TlsVerifyMode;
    caCertPath?: string;
    tlsPins?: string[];
  } = {},
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 5_000,
    ...transportOptions,
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const reason =
      typeof payload === 'object' && payload && 'reason' in payload
        ? String((payload as { reason?: unknown }).reason)
        : `${response.status} ${response.statusText}`;
    throw new Error(`Context sync request failed: ${reason}`);
  }

  return payload;
}

function extractPulledRecords(response: unknown): ContextSyncPullRecord[] {
  if (
    !response ||
    typeof response !== 'object' ||
    !Array.isArray((response as { data?: unknown }).data)
  ) {
    throw new Error('Context sync pull response did not include a data array');
  }

  return (response as { data: Array<{ signed_event?: unknown }> }).data.map((item, index) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !item.signed_event ||
      typeof item.signed_event !== 'object'
    ) {
      throw new Error(`Context sync pull response item ${index} did not include a signed_event`);
    }
    return {
      signedEvent: item.signed_event as ContextSyncEvent,
      receivedAt:
        typeof (item as { received_at?: unknown }).received_at === 'string'
          ? (item as { received_at: string }).received_at
          : undefined,
    };
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected object value');
  }
  return value as Record<string, unknown>;
}

function objectField(
  value: unknown,
  field: string,
  required: false,
): Record<string, unknown> | null;
function objectField(value: unknown, field: string, required?: true): Record<string, unknown>;
function objectField(
  value: unknown,
  field: string,
  required = true,
): Record<string, unknown> | null {
  const object = objectValue(value);
  const child = object[field];
  if (child === undefined || child === null) {
    if (!required) return null;
  }
  return objectValue(child);
}

function arrayField(value: unknown, field: string): unknown[] {
  const object = objectValue(value);
  const child = object[field];
  if (!Array.isArray(child)) {
    throw new Error(`Expected ${field} to be an array`);
  }
  return child;
}

function nullableStringField(value: unknown, field: string): string | null {
  const object = objectValue(value);
  const child = object[field];
  if (child === undefined || child === null) return null;
  if (typeof child !== 'string') {
    throw new Error(`Expected ${field} to be a string`);
  }
  return child;
}

function stringField(value: unknown, field: string): string {
  const object = objectValue(value);
  const child = object[field];
  if (typeof child !== 'string' || child.length === 0) {
    throw new Error(`Expected ${field} to be a non-empty string`);
  }
  return child;
}

function extractPulledCandidateDecisions(
  response: unknown,
  trustedDecisionKeys?: Record<string, string>,
): ContextCandidateDecisionPullRecord[] {
  if (
    !response ||
    typeof response !== 'object' ||
    !Array.isArray((response as { candidate_decisions?: unknown }).candidate_decisions)
  ) {
    return [];
  }

  return (response as { candidate_decisions: unknown[] }).candidate_decisions.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Context sync pull decision ${index} was not an object`);
    }
    const record = item as Partial<ContextCandidateDecisionPullRecord>;
    if (record.schema_version !== 'viewport.context_candidate_decision/v1') {
      throw new Error(`Context sync pull decision ${index} had an unsupported schema`);
    }
    if (record.decision !== 'approved' && record.decision !== 'rejected') {
      throw new Error(`Context sync pull decision ${index} had an unsupported decision`);
    }
    if (!record.repo_id || !record.candidate_event_id) {
      throw new Error(`Context sync pull decision ${index} was missing candidate identity`);
    }
    verifyContextCandidateDecision(
      record as ContextCandidateDecisionPullRecord,
      trustedDecisionKeys,
    );

    return record as ContextCandidateDecisionPullRecord;
  });
}

function latestReceivedAt(
  records: ContextSyncPullRecord[],
  decisions: ContextCandidateDecisionPullRecord[] = [],
): string | undefined {
  return [
    ...records
      .map((record) => record.receivedAt)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ...decisions
      .map((record) => record.decided_at)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  ]
    .sort()
    .at(-1);
}

function numberField(response: unknown, field: string, required: false): number | null;
function numberField(response: unknown, field: string, required?: true): number;
function numberField(response: unknown, field: string, required = true): number | null {
  const object = objectValue(response);
  const value = object[field];
  if (value === undefined || value === null) {
    if (!required) return null;
    throw new Error(`Context sync response did not include ${field}`);
  }
  if (typeof value !== 'number') {
    throw new Error(`Context sync response ${field} must be a number`);
  }
  return value;
}
