import { transportFetch, type TlsVerifyMode } from '../cli/network.js';
import { configDir } from '../core/config.js';
import {
  createLocalTeamEpochKeyMaterial,
  createLocalUserEpochKeyMaterial,
  getActiveLocalTeamEpoch,
  getActiveLocalUserEpoch,
  upsertLocalTeamEpoch,
  upsertLocalUserEpoch,
  type LocalTeamCryptoEpoch,
  type LocalUserCryptoEpoch,
} from './epoch-store.js';
import {
  epochTransitionPayload,
  signEpochTransition,
  type EpochTransitionPayload,
  type JsonValue,
} from './epoch-protocol.js';
import { grantTeamEpochToUserEpoch } from './team-epoch-grants.js';

export interface CryptoEpochSyncTarget {
  workspaceId: string;
  serverUrl: string;
  credential: string;
  tlsVerify?: TlsVerifyMode;
  caCertPath?: string;
  tlsPins?: string[];
}

export async function ensureUserCryptoEpoch(options: {
  target: CryptoEpochSyncTarget;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<LocalUserCryptoEpoch> {
  const existing = await getActiveLocalUserEpoch(options.target.workspaceId, options.home);
  if (existing) return existing;

  const material = createLocalUserEpochKeyMaterial({
    workspaceId: options.target.workspaceId,
    epoch: 1,
  });
  const payload = await postJson(
    options.fetchImpl ?? transportFetch,
    `${options.target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(
      options.target.workspaceId,
    )}/crypto/user-epochs`,
    {
      credential: options.target.credential,
      epoch: 1,
      encryption_public_key_jwk: material.descriptor.encryptionPublicKeyJwk,
      signing_public_key_jwk: material.descriptor.signingPublicKeyJwk,
    },
    options.target,
  );
  const data = objectField(payload, 'data');

  return upsertLocalUserEpoch(
    {
      workspaceId: stringField(data, 'workspace_id'),
      userId: String(numberOrStringField(data, 'user_id')),
      platformEpochId: stringField(data, 'id'),
      epoch: numberField(data, 'epoch'),
      schema: 'viewport.user_crypto_epoch/v1',
      status: 'active',
      encryptionPublicKeyJwk: objectField(data, 'encryption_public_key_jwk') as JsonValue,
      encryptionPrivateKeyJwk: material.encryptionPrivateKeyJwk,
      signingPublicKeyJwk: objectField(data, 'signing_public_key_jwk') as JsonValue,
      signingPrivateKeyJwk: material.signingPrivateKeyJwk,
      fingerprint: stringField(data, 'fingerprint'),
      previousEpochFingerprint:
        typeof data.previous_epoch_fingerprint === 'string'
          ? data.previous_epoch_fingerprint
          : null,
    },
    options.home ?? configDir(),
  );
}

export async function rotateUserCryptoEpoch(options: {
  target: CryptoEpochSyncTarget;
  reason: EpochTransitionPayload['reason'];
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<LocalUserCryptoEpoch> {
  const previous = await getActiveLocalUserEpoch(options.target.workspaceId, options.home);
  if (!previous) {
    throw new Error('Cannot rotate user crypto epoch before an active local epoch exists.');
  }

  const material = createLocalUserEpochKeyMaterial({
    workspaceId: options.target.workspaceId,
    userId: previous.userId,
    epoch: previous.epoch + 1,
    previousEpochFingerprint: previous.fingerprint,
  });
  const createdAt = new Date().toISOString();
  const continuity = signEpochTransition({
    payload: epochTransitionPayload({
      from: {
        schema: previous.schema,
        workspaceId: previous.workspaceId,
        subjectType: 'user',
        subjectId: previous.userId,
        epoch: previous.epoch,
        encryptionPublicKeyJwk: previous.encryptionPublicKeyJwk,
        signingPublicKeyJwk: previous.signingPublicKeyJwk,
        previousEpochFingerprint: previous.previousEpochFingerprint ?? null,
        createdAt: previous.createdAt,
      },
      to: material.descriptor,
      reason: options.reason,
      createdAt,
    }),
    signingPrivateKeyJwk: previous.signingPrivateKeyJwk,
    signedByEpochFingerprint: previous.fingerprint,
  });

  const payload = await postJson(
    options.fetchImpl ?? transportFetch,
    `${options.target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(
      options.target.workspaceId,
    )}/crypto/user-epochs`,
    {
      credential: options.target.credential,
      epoch: material.descriptor.epoch,
      encryption_public_key_jwk: material.descriptor.encryptionPublicKeyJwk,
      signing_public_key_jwk: material.descriptor.signingPublicKeyJwk,
      previous_epoch_fingerprint: previous.fingerprint,
      continuity: {
        payload: continuity.payload,
        signature: continuity.signature,
        signed_by_epoch_fingerprint: continuity.signedByEpochFingerprint,
      },
    },
    options.target,
  );
  const data = objectField(payload, 'data');

  return upsertLocalUserEpoch(
    {
      workspaceId: stringField(data, 'workspace_id'),
      userId: String(numberOrStringField(data, 'user_id')),
      platformEpochId: stringField(data, 'id'),
      epoch: numberField(data, 'epoch'),
      schema: 'viewport.user_crypto_epoch/v1',
      status: 'active',
      encryptionPublicKeyJwk: objectField(data, 'encryption_public_key_jwk') as JsonValue,
      encryptionPrivateKeyJwk: material.encryptionPrivateKeyJwk,
      signingPublicKeyJwk: objectField(data, 'signing_public_key_jwk') as JsonValue,
      signingPrivateKeyJwk: material.signingPrivateKeyJwk,
      fingerprint: stringField(data, 'fingerprint'),
      previousEpochFingerprint:
        typeof data.previous_epoch_fingerprint === 'string'
          ? data.previous_epoch_fingerprint
          : null,
    },
    options.home ?? configDir(),
  );
}

export async function ensureTeamCryptoEpoch(options: {
  target: CryptoEpochSyncTarget;
  teamId: string;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<LocalTeamCryptoEpoch> {
  const existing = await getActiveLocalTeamEpoch(
    options.target.workspaceId,
    options.teamId,
    options.home,
  );
  if (existing) return existing;

  const material = createLocalTeamEpochKeyMaterial({
    workspaceId: options.target.workspaceId,
    teamId: options.teamId,
    epoch: 1,
  });
  const payload = await postJson(
    options.fetchImpl ?? transportFetch,
    `${options.target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(
      options.target.workspaceId,
    )}/crypto/teams/${encodeURIComponent(options.teamId)}/epochs`,
    {
      credential: options.target.credential,
      epoch: 1,
      encryption_public_key_jwk: material.descriptor.encryptionPublicKeyJwk,
      signing_public_key_jwk: material.descriptor.signingPublicKeyJwk,
    },
    options.target,
  );
  const data = objectField(payload, 'data');

  return upsertLocalTeamEpoch(
    {
      workspaceId: stringField(data, 'workspace_id'),
      teamId: options.teamId,
      platformTeamId: String(numberOrStringField(data, 'team_id')),
      platformEpochId: stringField(data, 'id'),
      epoch: numberField(data, 'epoch'),
      schema: 'viewport.team_crypto_epoch/v1',
      status: 'active',
      encryptionPublicKeyJwk: objectField(data, 'encryption_public_key_jwk') as JsonValue,
      encryptionPrivateKeyJwk: material.encryptionPrivateKeyJwk,
      signingPublicKeyJwk: objectField(data, 'signing_public_key_jwk') as JsonValue,
      signingPrivateKeyJwk: material.signingPrivateKeyJwk,
      fingerprint: stringField(data, 'fingerprint'),
      previousEpochFingerprint:
        typeof data.previous_epoch_fingerprint === 'string'
          ? data.previous_epoch_fingerprint
          : null,
    },
    options.home ?? configDir(),
  );
}

export async function rotateTeamCryptoEpoch(options: {
  target: CryptoEpochSyncTarget;
  teamId: string;
  reason: EpochTransitionPayload['reason'];
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<LocalTeamCryptoEpoch> {
  const previous = await getActiveLocalTeamEpoch(
    options.target.workspaceId,
    options.teamId,
    options.home,
  );
  if (!previous) {
    throw new Error('Cannot rotate team crypto epoch before an active local team epoch exists.');
  }

  const material = createLocalTeamEpochKeyMaterial({
    workspaceId: options.target.workspaceId,
    teamId: previous.platformTeamId ?? previous.teamId,
    epoch: previous.epoch + 1,
    previousEpochFingerprint: previous.fingerprint,
  });
  const createdAt = new Date().toISOString();
  const continuity = signEpochTransition({
    payload: epochTransitionPayload({
      from: {
        schema: previous.schema,
        workspaceId: previous.workspaceId,
        subjectType: 'team',
        subjectId: previous.platformTeamId ?? previous.teamId,
        epoch: previous.epoch,
        encryptionPublicKeyJwk: previous.encryptionPublicKeyJwk,
        signingPublicKeyJwk: previous.signingPublicKeyJwk,
        previousEpochFingerprint: previous.previousEpochFingerprint ?? null,
        createdAt: previous.createdAt,
      },
      to: material.descriptor,
      reason: options.reason,
      createdAt,
    }),
    signingPrivateKeyJwk: previous.signingPrivateKeyJwk,
    signedByEpochFingerprint: previous.fingerprint,
  });

  const payload = await postJson(
    options.fetchImpl ?? transportFetch,
    `${options.target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(
      options.target.workspaceId,
    )}/crypto/teams/${encodeURIComponent(options.teamId)}/epochs`,
    {
      credential: options.target.credential,
      epoch: material.descriptor.epoch,
      encryption_public_key_jwk: material.descriptor.encryptionPublicKeyJwk,
      signing_public_key_jwk: material.descriptor.signingPublicKeyJwk,
      previous_epoch_fingerprint: previous.fingerprint,
      continuity: {
        payload: continuity.payload,
        signature: continuity.signature,
        signed_by_epoch_fingerprint: continuity.signedByEpochFingerprint,
      },
    },
    options.target,
  );
  const data = objectField(payload, 'data');

  return upsertLocalTeamEpoch(
    {
      workspaceId: stringField(data, 'workspace_id'),
      teamId: options.teamId,
      platformTeamId: String(numberOrStringField(data, 'team_id')),
      platformEpochId: stringField(data, 'id'),
      epoch: numberField(data, 'epoch'),
      schema: 'viewport.team_crypto_epoch/v1',
      status: 'active',
      encryptionPublicKeyJwk: objectField(data, 'encryption_public_key_jwk') as JsonValue,
      encryptionPrivateKeyJwk: material.encryptionPrivateKeyJwk,
      signingPublicKeyJwk: objectField(data, 'signing_public_key_jwk') as JsonValue,
      signingPrivateKeyJwk: material.signingPrivateKeyJwk,
      fingerprint: stringField(data, 'fingerprint'),
      previousEpochFingerprint:
        typeof data.previous_epoch_fingerprint === 'string'
          ? data.previous_epoch_fingerprint
          : null,
    },
    options.home ?? configDir(),
  );
}

export async function processPendingCryptoRotationRequests(options: {
  target: CryptoEpochSyncTarget;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<{
  processed: number;
  userRotations: number;
  teamRotations: number;
  teamMemberGrants: number;
  skipped: number;
}> {
  const fetchImpl = options.fetchImpl ?? transportFetch;
  const response = await getJson(
    fetchImpl,
    `${runtimeBaseUrl(options.target)}/crypto/rotation-requests`,
    options.target,
  );
  const requests = arrayField(response, 'data').map((item) => rotationRequestPayload(item));
  let userRotations = 0;
  let teamRotations = 0;
  let teamMemberGrants = 0;
  let skipped = 0;

  for (const request of requests) {
    if (request.subject_type === 'user') {
      await rotateUserCryptoEpoch({
        target: options.target,
        reason: rotationReason(request.reason),
        home: options.home,
        fetchImpl,
      });
      userRotations++;
      continue;
    }

    if (request.subject_type === 'team' && request.team_public_id) {
      const rotated = await rotateTeamCryptoEpoch({
        target: options.target,
        teamId: request.team_public_id,
        reason: rotationReason(request.reason),
        home: options.home,
        fetchImpl,
      });
      teamRotations++;
      if (!rotated.platformEpochId) {
        skipped++;
        continue;
      }
      for (const recipientEpochId of request.recipient_user_crypto_epoch_ids) {
        await grantTeamEpochToUserEpoch({
          target: options.target,
          teamCryptoEpochId: rotated.platformEpochId,
          recipientUserCryptoEpochId: recipientEpochId,
          home: options.home,
          fetchImpl,
        });
        teamMemberGrants++;
      }
      continue;
    }

    skipped++;
  }

  return {
    processed: userRotations + teamRotations,
    userRotations,
    teamRotations,
    teamMemberGrants,
    skipped,
  };
}

function runtimeBaseUrl(target: CryptoEpochSyncTarget): string {
  return `${target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(
    target.workspaceId,
  )}`;
}

async function getJson(
  fetchImpl: typeof transportFetch,
  url: string,
  transportOptions: CryptoEpochSyncTarget,
): Promise<unknown> {
  const requestUrl = new URL(url);
  requestUrl.searchParams.set('credential', transportOptions.credential);
  const response = await fetchImpl(requestUrl.toString(), {
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs: 5_000,
    tlsVerify: transportOptions.tlsVerify,
    caCertPath: transportOptions.caCertPath,
    tlsPins: transportOptions.tlsPins,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message?: unknown }).message)
        : `${response.status} ${response.statusText}`;
    throw new Error(`Crypto rotation sync failed: ${message}`);
  }
  return payload;
}

function rotationRequestPayload(value: unknown): {
  id: string;
  subject_type: 'user' | 'team';
  subject_id: string;
  team_public_id: string | null;
  reason: string;
  recipient_user_crypto_epoch_ids: string[];
} {
  const data = objectValue(value);
  const subjectType = stringField(data, 'subject_type');
  if (subjectType !== 'user' && subjectType !== 'team') {
    throw new Error(`Unsupported crypto rotation subject: ${subjectType}`);
  }
  const recipients = data.recipient_user_crypto_epoch_ids;
  return {
    id: stringField(data, 'id'),
    subject_type: subjectType,
    subject_id: stringField(data, 'subject_id'),
    team_public_id: typeof data.team_public_id === 'string' ? data.team_public_id : null,
    reason: stringField(data, 'reason'),
    recipient_user_crypto_epoch_ids: Array.isArray(recipients)
      ? recipients.map((item) => String(item))
      : [],
  };
}

function rotationReason(value: string): EpochTransitionPayload['reason'] {
  if (
    value === 'device_revoked' ||
    value === 'member_revoked' ||
    value === 'manual_rotation' ||
    value === 'recovery'
  ) {
    return value;
  }
  return 'manual_rotation';
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
    tlsVerify: transportOptions.tlsVerify,
    caCertPath: transportOptions.caCertPath,
    tlsPins: transportOptions.tlsPins,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message?: unknown }).message)
        : `${response.status} ${response.statusText}`;
    throw new Error(`Crypto epoch sync failed: ${message}`);
  }
  return payload;
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  const object = objectValue(value);
  const child = object[field];
  if (!child || typeof child !== 'object' || Array.isArray(child)) {
    throw new Error(`Crypto epoch response did not include ${field}`);
  }
  return child as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected response object.');
  }
  return value as Record<string, unknown>;
}

function arrayField(value: unknown, field: string): unknown[] {
  const object = objectValue(value);
  const child = object[field];
  if (!Array.isArray(child)) {
    throw new Error(`Crypto epoch response did not include ${field} array.`);
  }
  return child;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const child = value[field];
  if (typeof child !== 'string' || child.trim().length === 0) {
    throw new Error(`Crypto epoch response did not include ${field}`);
  }
  return child;
}

function numberField(value: Record<string, unknown>, field: string): number {
  const child = value[field];
  if (typeof child !== 'number') {
    throw new Error(`Crypto epoch response did not include numeric ${field}`);
  }
  return child;
}

function numberOrStringField(value: Record<string, unknown>, field: string): number | string {
  const child = value[field];
  if (typeof child !== 'number' && typeof child !== 'string') {
    throw new Error(`Crypto epoch response did not include ${field}`);
  }
  return child;
}
