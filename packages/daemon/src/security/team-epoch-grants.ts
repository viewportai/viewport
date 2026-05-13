import { transportFetch, type TlsVerifyMode } from '../cli/network.js';
import { configDir } from '../core/config.js';
import {
  getLocalTeamEpochByPlatformId,
  getLocalUserEpochByPlatformId,
  upsertLocalTeamEpoch,
  type LocalTeamCryptoEpoch,
} from './epoch-store.js';
import {
  unwrapJsonFromX25519Envelope,
  wrapJsonForX25519Recipient,
  type JsonValue,
  type WrappedKeyEnvelope,
} from './epoch-protocol.js';
import type { CryptoEpochSyncTarget } from './epoch-sync.js';

interface PublicUserEpoch {
  id: string;
  workspace_id: string;
  user_id: number | string;
  epoch: number;
  fingerprint: string;
  encryption_public_key_jwk: JsonValue;
  signing_public_key_jwk: JsonValue;
  previous_epoch_fingerprint?: string | null;
}

interface TeamMemberGrantPayload {
  id: string;
  team_crypto_epoch_id: string;
  recipient_user_crypto_epoch_id: string;
  aad: JsonValue;
  encrypted_payload: WrappedKeyEnvelope;
}

export async function grantTeamEpochToUserEpoch(options: {
  target: CryptoEpochSyncTarget;
  teamCryptoEpochId: string;
  recipientUserCryptoEpochId: string;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<TeamMemberGrantPayload> {
  const teamEpoch = await getLocalTeamEpochByPlatformId(
    options.target.workspaceId,
    options.teamCryptoEpochId,
    options.home,
  );
  if (!teamEpoch?.platformEpochId) {
    throw new Error('Active local team epoch with platform id is required before granting it.');
  }
  const recipient = await fetchPublicUserEpoch(options);
  const aad = teamEpochMemberGrantAad({ teamEpoch, recipient });
  const encryptedPayload = wrapJsonForX25519Recipient({
    recipientPublicKeyJwk: recipient.encryption_public_key_jwk,
    aad,
    payload: {
      schema: 'viewport.team_epoch_member_material/v1',
      workspaceId: teamEpoch.workspaceId,
      teamId: teamEpoch.teamId,
      platformTeamId: teamEpoch.platformTeamId ?? null,
      platformEpochId: teamEpoch.platformEpochId,
      epoch: teamEpoch.epoch,
      fingerprint: teamEpoch.fingerprint,
      encryptionPublicKeyJwk: teamEpoch.encryptionPublicKeyJwk,
      encryptionPrivateKeyJwk: teamEpoch.encryptionPrivateKeyJwk,
      signingPublicKeyJwk: teamEpoch.signingPublicKeyJwk,
      signingPrivateKeyJwk: teamEpoch.signingPrivateKeyJwk,
      previousEpochFingerprint: teamEpoch.previousEpochFingerprint ?? null,
    },
  });

  const response = await postJson(
    options.fetchImpl ?? transportFetch,
    `${runtimeBaseUrl(options.target)}/crypto/team-epochs/${encodeURIComponent(
      options.teamCryptoEpochId,
    )}/member-grants`,
    {
      credential: options.target.credential,
      recipient_user_crypto_epoch_id: options.recipientUserCryptoEpochId,
      aad,
      encrypted_payload: encryptedPayload,
    },
    options.target,
  );
  return teamMemberGrantPayload(objectField(response, 'data'));
}

export async function acceptTeamEpochMemberGrants(options: {
  target: CryptoEpochSyncTarget;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<{ accepted: number; teamEpochs: LocalTeamCryptoEpoch[] }> {
  const response = await getJson(
    options.fetchImpl ?? transportFetch,
    `${runtimeBaseUrl(options.target)}/crypto/team-epoch-member-grants`,
    options.target,
  );
  const grants = arrayField(response, 'data').map((item) => teamMemberGrantPayload(item));
  const teamEpochs: LocalTeamCryptoEpoch[] = [];
  for (const grant of grants) {
    const localUserEpoch = await getLocalUserEpochByPlatformId(
      options.target.workspaceId,
      grant.recipient_user_crypto_epoch_id,
      options.home,
    );
    if (!localUserEpoch) continue;
    const payload = unwrapJsonFromX25519Envelope({
      recipientPrivateKeyJwk: localUserEpoch.encryptionPrivateKeyJwk,
      envelope: grant.encrypted_payload,
      aad: grant.aad,
    });
    const material = teamMaterialPayload(payload);
    const teamEpoch = await upsertLocalTeamEpoch(
      {
        workspaceId: material.workspaceId,
        teamId: material.teamId,
        platformTeamId: material.platformTeamId,
        platformEpochId: material.platformEpochId,
        epoch: material.epoch,
        schema: 'viewport.team_crypto_epoch/v1',
        status: 'active',
        encryptionPublicKeyJwk: material.encryptionPublicKeyJwk,
        encryptionPrivateKeyJwk: material.encryptionPrivateKeyJwk,
        signingPublicKeyJwk: material.signingPublicKeyJwk,
        signingPrivateKeyJwk: material.signingPrivateKeyJwk,
        fingerprint: material.fingerprint,
        previousEpochFingerprint: material.previousEpochFingerprint,
      },
      options.home ?? configDir(),
    );
    await postJson(
      options.fetchImpl ?? transportFetch,
      `${runtimeBaseUrl(options.target)}/crypto/team-epoch-member-grants/${encodeURIComponent(
        grant.id,
      )}/materialized`,
      { credential: options.target.credential },
      options.target,
    );
    teamEpochs.push(teamEpoch);
  }
  return { accepted: teamEpochs.length, teamEpochs };
}

function teamEpochMemberGrantAad(input: {
  teamEpoch: LocalTeamCryptoEpoch;
  recipient: PublicUserEpoch;
}): JsonValue {
  return {
    schema: 'viewport.team_epoch_member_grant_aad/v1',
    workspaceId: input.teamEpoch.workspaceId,
    platformTeamId: input.teamEpoch.platformTeamId ?? null,
    teamEpochId: input.teamEpoch.platformEpochId ?? null,
    teamEpochFingerprint: input.teamEpoch.fingerprint,
    recipientUserEpochId: input.recipient.id,
    recipientUserEpochFingerprint: input.recipient.fingerprint,
  };
}

async function fetchPublicUserEpoch(options: {
  target: CryptoEpochSyncTarget;
  recipientUserCryptoEpochId: string;
  fetchImpl?: typeof transportFetch;
}): Promise<PublicUserEpoch> {
  const response = await getJson(
    options.fetchImpl ?? transportFetch,
    `${runtimeBaseUrl(options.target)}/crypto/epochs`,
    options.target,
  );
  const userEpochs = arrayField(objectField(response, 'data'), 'user_epochs').map((item) =>
    publicUserEpochPayload(item),
  );
  const epoch = userEpochs.find((item) => item.id === options.recipientUserCryptoEpochId);
  if (!epoch) throw new Error('Recipient user epoch not found in workspace epoch feed.');
  return epoch;
}

function runtimeBaseUrl(target: CryptoEpochSyncTarget): string {
  return `${target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(
    target.workspaceId,
  )}`;
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
  if (!response.ok) throw new Error(responseError(payload, response));
  return payload;
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
  if (!response.ok) throw new Error(responseError(payload, response));
  return payload;
}

function responseError(payload: unknown, response: Response): string {
  const message =
    payload && typeof payload === 'object' && 'message' in payload
      ? String((payload as { message?: unknown }).message)
      : `${response.status} ${response.statusText}`;
  return `Team epoch grant sync failed: ${message}`;
}

function publicUserEpochPayload(value: unknown): PublicUserEpoch {
  const data = record(value, 'user epoch');
  return {
    id: stringField(data, 'id'),
    workspace_id: stringField(data, 'workspace_id'),
    user_id: numberOrStringField(data, 'user_id'),
    epoch: numberField(data, 'epoch'),
    fingerprint: stringField(data, 'fingerprint'),
    encryption_public_key_jwk: objectField(data, 'encryption_public_key_jwk') as JsonValue,
    signing_public_key_jwk: objectField(data, 'signing_public_key_jwk') as JsonValue,
    previous_epoch_fingerprint:
      typeof data.previous_epoch_fingerprint === 'string' ? data.previous_epoch_fingerprint : null,
  };
}

function teamMemberGrantPayload(value: unknown): TeamMemberGrantPayload {
  const data = record(value, 'team member grant');
  return {
    id: stringField(data, 'id'),
    team_crypto_epoch_id: stringField(data, 'team_crypto_epoch_id'),
    recipient_user_crypto_epoch_id: stringField(data, 'recipient_user_crypto_epoch_id'),
    aad: objectField(data, 'aad') as JsonValue,
    encrypted_payload: objectField(data, 'encrypted_payload') as unknown as WrappedKeyEnvelope,
  };
}

function teamMaterialPayload(value: JsonValue): {
  workspaceId: string;
  teamId: string;
  platformTeamId: string | null;
  platformEpochId: string;
  epoch: number;
  fingerprint: string;
  encryptionPublicKeyJwk: JsonValue;
  encryptionPrivateKeyJwk: JsonValue;
  signingPublicKeyJwk: JsonValue;
  signingPrivateKeyJwk: JsonValue;
  previousEpochFingerprint: string | null;
} {
  const data = record(value, 'team material');
  return {
    workspaceId: stringField(data, 'workspaceId'),
    teamId: stringField(data, 'teamId'),
    platformTeamId: typeof data.platformTeamId === 'string' ? data.platformTeamId : null,
    platformEpochId: stringField(data, 'platformEpochId'),
    epoch: numberField(data, 'epoch'),
    fingerprint: stringField(data, 'fingerprint'),
    encryptionPublicKeyJwk: objectField(data, 'encryptionPublicKeyJwk') as JsonValue,
    encryptionPrivateKeyJwk: objectField(data, 'encryptionPrivateKeyJwk') as JsonValue,
    signingPublicKeyJwk: objectField(data, 'signingPublicKeyJwk') as JsonValue,
    signingPrivateKeyJwk: objectField(data, 'signingPrivateKeyJwk') as JsonValue,
    previousEpochFingerprint:
      typeof data.previousEpochFingerprint === 'string' ? data.previousEpochFingerprint : null,
  };
}

function arrayField(value: unknown, field: string): unknown[] {
  const data = record(value, 'response');
  const child = data[field];
  if (!Array.isArray(child)) throw new Error(`Response did not include ${field} array.`);
  return child;
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  const data = record(value, 'response');
  const child = data[field];
  if (!child || typeof child !== 'object' || Array.isArray(child)) {
    throw new Error(`Response did not include ${field} object.`);
  }
  return child as Record<string, unknown>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${label} object.`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const child = value[field];
  if (typeof child !== 'string' || child.trim().length === 0) {
    throw new Error(`Response did not include ${field}.`);
  }
  return child;
}

function numberField(value: Record<string, unknown>, field: string): number {
  const child = value[field];
  if (typeof child !== 'number') {
    throw new Error(`Response did not include numeric ${field}.`);
  }
  return child;
}

function numberOrStringField(value: Record<string, unknown>, field: string): number | string {
  const child = value[field];
  if (typeof child !== 'number' && typeof child !== 'string') {
    throw new Error(`Response did not include ${field}.`);
  }
  return child;
}
