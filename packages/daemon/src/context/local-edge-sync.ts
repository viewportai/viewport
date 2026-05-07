import { configDir } from '../core/config.js';
import {
  assertCredentialsOrApprovedDevice,
  createVault,
  ensureUserOrApprovedDevice,
} from './local-edge-engine.js';
import { readProjectMetadata, touchProjectMetadata } from './local-edge-metadata.js';
import type {
  ContextCredentials,
  ContextSyncEvent,
  ContextSyncPullRecord,
} from './local-edge-types.js';

export async function pushContextEvents(options: {
  projectId: string;
  serverUrl: string;
  credential: string;
  home?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ accepted: number; pushed: number; repoId: string }> {
  const home = options.home ?? configDir();
  const metadata = await readProjectMetadata(options.projectId, home);
  const vault = createVault(home, metadata.keyStore);
  const events = vault.listSyncEvents({ repoId: metadata.repoId });
  if (events.length === 0) {
    return { accepted: 0, pushed: 0, repoId: metadata.repoId };
  }

  const response = await postJson(
    options.fetchImpl ?? fetch,
    contextRuntimeUrl(options.serverUrl, options.projectId, 'push'),
    {
      credential: options.credential,
      events,
    },
  );

  return {
    accepted: numberField(response, 'accepted'),
    pushed: events.length,
    repoId: metadata.repoId,
  };
}

export async function pullContextEvents(options: {
  projectId: string;
  serverUrl: string;
  credential: string;
  actorName: string;
  credentials: ContextCredentials;
  limit?: number;
  home?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ imported: number; pulled: number; repoId: string }> {
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

  const response = await postJson(
    options.fetchImpl ?? fetch,
    contextRuntimeUrl(options.serverUrl, options.projectId, 'pull'),
    {
      credential: options.credential,
      repo_id: metadata.repoId,
      ...(metadata.lastServerPullReceivedAt
        ? { after_received_at: metadata.lastServerPullReceivedAt }
        : {}),
      limit: options.limit ?? 500,
    },
  );
  const records = extractPulledRecords(response);
  const events = records.map((record) => record.signedEvent);
  const imported = await vault.importSyncEvents({
    repoId: metadata.repoId,
    events,
    actorName: options.actorName,
  });
  await touchProjectMetadata(
    {
      ...metadata,
      lastServerPullReceivedAt: latestReceivedAt(records) ?? metadata.lastServerPullReceivedAt,
    },
    home,
  );

  return {
    imported: imported.imported.length,
    pulled: events.length,
    repoId: metadata.repoId,
  };
}

function contextRuntimeUrl(
  serverUrl: string,
  projectId: string,
  operation: 'push' | 'pull',
): string {
  const base = serverUrl.replace(/\/+$/, '');
  return `${base}/api/runtime/workspaces/${encodeURIComponent(projectId)}/context-vault/events/${operation}`;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
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

function latestReceivedAt(records: ContextSyncPullRecord[]): string | undefined {
  return records
    .map((record) => record.receivedAt)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
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
