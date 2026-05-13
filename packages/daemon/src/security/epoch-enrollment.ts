import { transportFetch, type TlsVerifyMode } from '../cli/network.js';
import { configDir } from '../core/config.js';
import {
  createLocalDeviceEnrollmentKeyMaterial,
  getActiveLocalUserEpoch,
  getLocalDeviceEnrollment,
  upsertLocalDeviceEnrollment,
  upsertLocalUserEpoch,
  type LocalDeviceEnrollment,
  type LocalUserCryptoEpoch,
} from './epoch-store.js';
import {
  unwrapJsonFromX25519Envelope,
  wrapJsonForX25519Recipient,
  type JsonValue,
  type WrappedKeyEnvelope,
} from './epoch-protocol.js';
import type { CryptoEpochSyncTarget } from './epoch-sync.js';

interface DeviceGrantPayload {
  id: string;
  user_crypto_epoch_id: string;
  recipient_fingerprint: string;
  aad: JsonValue;
  encrypted_payload: WrappedKeyEnvelope;
}

interface DeviceEnrollmentPayload {
  id: string;
  workspace_id: string;
  user_id: number | string;
  device_id: string;
  device_label: string;
  encryption_public_key_jwk: JsonValue;
  signing_public_key_jwk: JsonValue;
  fingerprint: string;
  nonce: string;
  status: 'pending' | 'approved' | 'accepted' | 'revoked';
  grants?: DeviceGrantPayload[];
}

export async function requestDeviceEpochEnrollment(options: {
  target: CryptoEpochSyncTarget;
  deviceId: string;
  deviceLabel: string;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<LocalDeviceEnrollment> {
  const material = createLocalDeviceEnrollmentKeyMaterial({
    workspaceId: options.target.workspaceId,
    deviceId: options.deviceId,
    deviceLabel: options.deviceLabel,
  });
  const payload = await postJson(
    options.fetchImpl ?? transportFetch,
    `${runtimeBaseUrl(options.target)}/crypto/device-enrollments`,
    {
      credential: options.target.credential,
      device_id: options.deviceId,
      device_label: options.deviceLabel,
      encryption_public_key_jwk: material.enrollment.encryptionPublicKeyJwk,
      signing_public_key_jwk: material.enrollment.signingPublicKeyJwk,
      nonce: material.enrollment.nonce,
    },
    options.target,
  );
  const data = enrollmentPayload(payload);

  return upsertLocalDeviceEnrollment(
    {
      workspaceId: data.workspace_id,
      enrollmentId: data.id,
      userId: String(data.user_id),
      deviceId: data.device_id,
      deviceLabel: data.device_label,
      status: data.status,
      encryptionPublicKeyJwk: data.encryption_public_key_jwk,
      encryptionPrivateKeyJwk: material.enrollment.encryptionPrivateKeyJwk,
      signingPublicKeyJwk: data.signing_public_key_jwk,
      signingPrivateKeyJwk: material.enrollment.signingPrivateKeyJwk,
      fingerprint: data.fingerprint,
      nonce: data.nonce,
    },
    options.home ?? configDir(),
  );
}

export async function approveDeviceEpochEnrollment(options: {
  target: CryptoEpochSyncTarget;
  enrollmentId: string;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<DeviceEnrollmentPayload> {
  const epoch = await getActiveLocalUserEpoch(options.target.workspaceId, options.home);
  if (!epoch?.platformEpochId) {
    throw new Error(
      'Active local user epoch with platform id is required before approving a device.',
    );
  }
  const enrollment = await fetchEnrollment(options);
  const aad = userEpochDeviceGrantAad({ epoch, enrollment });
  const encryptedPayload = wrapJsonForX25519Recipient({
    recipientPublicKeyJwk: enrollment.encryption_public_key_jwk,
    aad,
    payload: {
      schema: 'viewport.user_epoch_device_material/v1',
      workspaceId: epoch.workspaceId,
      userId: epoch.userId,
      platformEpochId: epoch.platformEpochId,
      epoch: epoch.epoch,
      fingerprint: epoch.fingerprint,
      encryptionPublicKeyJwk: epoch.encryptionPublicKeyJwk,
      encryptionPrivateKeyJwk: epoch.encryptionPrivateKeyJwk,
      signingPublicKeyJwk: epoch.signingPublicKeyJwk,
      signingPrivateKeyJwk: epoch.signingPrivateKeyJwk,
      previousEpochFingerprint: epoch.previousEpochFingerprint ?? null,
    },
  });

  const response = await postJson(
    options.fetchImpl ?? transportFetch,
    `${runtimeBaseUrl(options.target)}/crypto/device-enrollments/${encodeURIComponent(
      options.enrollmentId,
    )}/approve`,
    {
      credential: options.target.credential,
      user_crypto_epoch_id: epoch.platformEpochId,
      aad,
      encrypted_payload: encryptedPayload,
    },
    options.target,
  );
  return enrollmentPayload(response);
}

export async function acceptDeviceEpochEnrollment(options: {
  target: CryptoEpochSyncTarget;
  enrollmentId: string;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<LocalUserCryptoEpoch> {
  const enrollment = await fetchEnrollment(options);
  const localEnrollment = await getLocalDeviceEnrollment(
    options.target.workspaceId,
    enrollment.id,
    options.home,
  );
  if (!localEnrollment) {
    throw new Error('Local pending device enrollment key material was not found.');
  }
  const grant = (enrollment.grants ?? []).find(
    (item) => item.recipient_fingerprint === localEnrollment.fingerprint,
  );
  if (!grant) {
    throw new Error('No encrypted user epoch grant is available for this device enrollment.');
  }
  const payload = unwrapJsonFromX25519Envelope({
    recipientPrivateKeyJwk: localEnrollment.encryptionPrivateKeyJwk,
    envelope: grant.encrypted_payload,
    aad: grant.aad,
  });
  const material = materialPayload(payload);
  const epoch = await upsertLocalUserEpoch(
    {
      workspaceId: material.workspaceId,
      userId: material.userId,
      platformEpochId: material.platformEpochId,
      epoch: material.epoch,
      schema: 'viewport.user_crypto_epoch/v1',
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
  await upsertLocalDeviceEnrollment(
    {
      ...localEnrollment,
      status: 'accepted',
    },
    options.home ?? configDir(),
  );
  await postJson(
    options.fetchImpl ?? transportFetch,
    `${runtimeBaseUrl(options.target)}/crypto/device-enrollments/${encodeURIComponent(
      enrollment.id,
    )}/materialized`,
    {
      credential: options.target.credential,
      grant_id: grant.id,
    },
    options.target,
  );
  return epoch;
}

function userEpochDeviceGrantAad(input: {
  epoch: LocalUserCryptoEpoch;
  enrollment: DeviceEnrollmentPayload;
}): JsonValue {
  return {
    schema: 'viewport.user_epoch_device_grant_aad/v1',
    workspaceId: input.epoch.workspaceId,
    userId: input.epoch.userId,
    platformEpochId: input.epoch.platformEpochId ?? null,
    epochFingerprint: input.epoch.fingerprint,
    enrollmentId: input.enrollment.id,
    recipientFingerprint: input.enrollment.fingerprint,
  };
}

async function fetchEnrollment(options: {
  target: CryptoEpochSyncTarget;
  enrollmentId: string;
  fetchImpl?: typeof transportFetch;
}): Promise<DeviceEnrollmentPayload> {
  const payload = await getJson(
    options.fetchImpl ?? transportFetch,
    `${runtimeBaseUrl(options.target)}/crypto/device-enrollments/${encodeURIComponent(
      options.enrollmentId,
    )}`,
    options.target,
  );
  return enrollmentPayload(payload);
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
  return `Device enrollment sync failed: ${message}`;
}

function enrollmentPayload(payload: unknown): DeviceEnrollmentPayload {
  const data = objectField(payload, 'data');
  return {
    id: stringField(data, 'id'),
    workspace_id: stringField(data, 'workspace_id'),
    user_id: numberOrStringField(data, 'user_id'),
    device_id: stringField(data, 'device_id'),
    device_label: stringField(data, 'device_label'),
    encryption_public_key_jwk: objectField(data, 'encryption_public_key_jwk') as JsonValue,
    signing_public_key_jwk: objectField(data, 'signing_public_key_jwk') as JsonValue,
    fingerprint: stringField(data, 'fingerprint'),
    nonce: stringField(data, 'nonce'),
    status: statusField(data, 'status'),
    grants: Array.isArray(data.grants) ? data.grants.map((item) => deviceGrantPayload(item)) : [],
  };
}

function deviceGrantPayload(value: unknown): DeviceGrantPayload {
  const data = record(value, 'grant');
  return {
    id: stringField(data, 'id'),
    user_crypto_epoch_id: stringField(data, 'user_crypto_epoch_id'),
    recipient_fingerprint: stringField(data, 'recipient_fingerprint'),
    aad: objectField(data, 'aad') as JsonValue,
    encrypted_payload: objectField(data, 'encrypted_payload') as unknown as WrappedKeyEnvelope,
  };
}

function materialPayload(value: JsonValue): {
  workspaceId: string;
  userId: string;
  platformEpochId: string;
  epoch: number;
  fingerprint: string;
  encryptionPublicKeyJwk: JsonValue;
  encryptionPrivateKeyJwk: JsonValue;
  signingPublicKeyJwk: JsonValue;
  signingPrivateKeyJwk: JsonValue;
  previousEpochFingerprint: string | null;
} {
  const data = record(value, 'material');
  return {
    workspaceId: stringField(data, 'workspaceId'),
    userId: stringField(data, 'userId'),
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

function objectField(value: unknown, field: string): Record<string, unknown> {
  const data = record(value, 'response');
  const child = data[field];
  if (!child || typeof child !== 'object' || Array.isArray(child)) {
    throw new Error(`Device enrollment response did not include ${field}`);
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
    throw new Error(`Device enrollment response did not include ${field}`);
  }
  return child;
}

function numberField(value: Record<string, unknown>, field: string): number {
  const child = value[field];
  if (typeof child !== 'number') {
    throw new Error(`Device enrollment response did not include numeric ${field}`);
  }
  return child;
}

function numberOrStringField(value: Record<string, unknown>, field: string): number | string {
  const child = value[field];
  if (typeof child !== 'number' && typeof child !== 'string') {
    throw new Error(`Device enrollment response did not include ${field}`);
  }
  return child;
}

function statusField(
  value: Record<string, unknown>,
  field: string,
): DeviceEnrollmentPayload['status'] {
  const child = stringField(value, field);
  if (child !== 'pending' && child !== 'approved' && child !== 'accepted' && child !== 'revoked') {
    throw new Error(`Unsupported device enrollment status: ${child}`);
  }
  return child;
}
