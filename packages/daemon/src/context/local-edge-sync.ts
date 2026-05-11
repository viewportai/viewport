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

function contextRuntimeUrl(
  serverUrl: string,
  workspaceId: string,
  operation: 'push' | 'pull',
): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/api/runtime/workspaces/${encodeURIComponent(workspaceId)}/context-vault/events/${operation}`;
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

function numberField(response: unknown, field: string): number {
  if (!response || typeof response !== 'object') {
    throw new Error(`Context sync response did not include ${field}`);
  }
  const value = (response as Record<string, unknown>)[field];
  if (typeof value !== 'number') {
    throw new Error(`Context sync response ${field} must be a number`);
  }
  return value;
}
