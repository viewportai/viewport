import crypto from 'node:crypto';
import { transportFetch } from '../cli/network.js';
import { configDir } from '../core/config.js';
import {
  getActiveLocalUserEpoch,
  upsertLocalUserEpoch,
  type LocalUserCryptoEpoch,
} from './epoch-store.js';
import {
  canonicalJson,
  fingerprintPayload,
  TRUSTED_EDGE_CRYPTO_PROTOCOL_HEADER,
  TRUSTED_EDGE_CRYPTO_PROTOCOL_VERSION,
  type JsonValue,
} from './epoch-protocol.js';
import { rotateUserCryptoEpoch, type CryptoEpochSyncTarget } from './epoch-sync.js';

export const USER_EPOCH_RECOVERY_BACKUP_SCHEMA = 'viewport.user_epoch_recovery_backup/v1';
const USER_EPOCH_RECOVERY_PAYLOAD_SCHEMA = 'viewport.user_epoch_recovery_payload/v1';
const USER_EPOCH_RECOVERY_ENVELOPE_SCHEMA = 'viewport.user_epoch_recovery_envelope/v1';
const RECOVERY_KDF = 'scrypt-sha256/v1';

interface RecoveryBackupPayload {
  schema: typeof USER_EPOCH_RECOVERY_PAYLOAD_SCHEMA;
  workspaceId: string;
  userId: string;
  userCryptoEpochId: string;
  userEpochFingerprint: string;
  epoch: Omit<LocalUserCryptoEpoch, 'createdAt' | 'updatedAt'>;
}

interface UserKeyBackupResponse {
  id: string;
  workspace_id: string;
  user_id: number | string;
  user_crypto_epoch_id: string;
  schema: typeof USER_EPOCH_RECOVERY_BACKUP_SCHEMA;
  status: string;
  kdf: typeof RECOVERY_KDF;
  kdf_params: RecoveryKdfParams;
  encrypted_payload: RecoveryEnvelope;
  created_at?: string | null;
}

interface RecoveryKdfParams {
  salt: string;
  keyLength: number;
  N: number;
  r: number;
  p: number;
}

interface RecoveryEnvelope {
  schema: typeof USER_EPOCH_RECOVERY_ENVELOPE_SCHEMA;
  alg: 'aes-256-gcm';
  aad: JsonValue;
  iv: string;
  ciphertext: string;
  tag: string;
  aadDigest: string;
  createdAt: string;
}

export function generateUserEpochRecoveryKey(): string {
  return `vprk_${crypto.randomBytes(32).toString('base64url')}`;
}

export async function createUserEpochRecoveryBackup(options: {
  target: CryptoEpochSyncTarget;
  recoveryKey: string;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<UserKeyBackupResponse> {
  const epoch = await getActiveLocalUserEpoch(options.target.workspaceId, options.home);
  if (!epoch?.platformEpochId) {
    throw new Error('Active local user epoch with platform id is required before backup.');
  }

  const payload: RecoveryBackupPayload = {
    schema: USER_EPOCH_RECOVERY_PAYLOAD_SCHEMA,
    workspaceId: epoch.workspaceId,
    userId: epoch.userId,
    userCryptoEpochId: epoch.platformEpochId,
    userEpochFingerprint: epoch.fingerprint,
    epoch: {
      workspaceId: epoch.workspaceId,
      userId: epoch.userId,
      platformEpochId: epoch.platformEpochId,
      epoch: epoch.epoch,
      schema: epoch.schema,
      status: 'active',
      encryptionPublicKeyJwk: epoch.encryptionPublicKeyJwk,
      encryptionPrivateKeyJwk: epoch.encryptionPrivateKeyJwk,
      signingPublicKeyJwk: epoch.signingPublicKeyJwk,
      signingPrivateKeyJwk: epoch.signingPrivateKeyJwk,
      fingerprint: epoch.fingerprint,
      previousEpochFingerprint: epoch.previousEpochFingerprint ?? null,
    },
  };
  const kdfParams = recoveryKdfParams();
  const aad = recoveryAad(payload);
  const encryptedPayload = encryptRecoveryPayload({
    recoveryKey: options.recoveryKey,
    kdfParams,
    aad,
    payload,
  });
  const response = await postJson(
    options.fetchImpl ?? transportFetch,
    `${runtimeBaseUrl(options.target)}/crypto/user-key-backups`,
    {
      credential: options.target.credential,
      schema: USER_EPOCH_RECOVERY_BACKUP_SCHEMA,
      user_crypto_epoch_id: epoch.platformEpochId,
      kdf: RECOVERY_KDF,
      kdf_params: kdfParams,
      encrypted_payload: encryptedPayload,
    },
    options.target,
  );

  return userKeyBackupResponse(response);
}

export async function restoreUserEpochFromRecoveryBackup(options: {
  target: CryptoEpochSyncTarget;
  recoveryKey: string;
  home?: string;
  fetchImpl?: typeof transportFetch;
}): Promise<{
  backup: UserKeyBackupResponse;
  restoredEpoch: LocalUserCryptoEpoch;
  rotatedEpoch: LocalUserCryptoEpoch;
  rotatedBackup: UserKeyBackupResponse;
}> {
  const fetchImpl = options.fetchImpl ?? transportFetch;
  const backup = userKeyBackupResponse(
    await getJson(
      fetchImpl,
      `${runtimeBaseUrl(options.target)}/crypto/user-key-backups/latest`,
      options.target,
    ),
  );
  const payload = decryptRecoveryPayload({
    recoveryKey: options.recoveryKey,
    kdfParams: backup.kdf_params,
    envelope: backup.encrypted_payload,
  });
  if (
    payload.workspaceId !== options.target.workspaceId ||
    payload.userCryptoEpochId !== backup.user_crypto_epoch_id ||
    payload.userEpochFingerprint !== payload.epoch.fingerprint
  ) {
    throw new Error('Recovery backup payload does not match the backup metadata.');
  }

  const restoredEpoch = await upsertLocalUserEpoch(payload.epoch, options.home ?? configDir());
  const rotatedEpoch = await rotateUserCryptoEpoch({
    target: options.target,
    reason: 'recovery',
    home: options.home,
    fetchImpl,
  });
  const rotatedBackup = await createUserEpochRecoveryBackup({
    target: options.target,
    recoveryKey: options.recoveryKey,
    home: options.home,
    fetchImpl,
  });

  return { backup, restoredEpoch, rotatedEpoch, rotatedBackup };
}

function encryptRecoveryPayload(input: {
  recoveryKey: string;
  kdfParams: RecoveryKdfParams;
  aad: JsonValue;
  payload: RecoveryBackupPayload;
}): RecoveryEnvelope {
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(canonicalJson(input.aad));
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    deriveRecoveryKey(input.recoveryKey, input.kdfParams),
    iv,
  );
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(canonicalJson(input.payload))),
    cipher.final(),
  ]);

  return {
    schema: USER_EPOCH_RECOVERY_ENVELOPE_SCHEMA,
    alg: 'aes-256-gcm',
    aad: input.aad,
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    aadDigest: fingerprintPayload(input.aad),
    createdAt: new Date().toISOString(),
  };
}

function decryptRecoveryPayload(input: {
  recoveryKey: string;
  kdfParams: RecoveryKdfParams;
  envelope: RecoveryEnvelope;
}): RecoveryBackupPayload {
  if (input.envelope.schema !== USER_EPOCH_RECOVERY_ENVELOPE_SCHEMA) {
    throw new Error('Unsupported recovery envelope schema.');
  }
  if (input.envelope.alg !== 'aes-256-gcm') {
    throw new Error('Unsupported recovery envelope algorithm.');
  }
  const aad = input.envelope.aad;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveRecoveryKey(input.recoveryKey, input.kdfParams),
    Buffer.from(input.envelope.iv, 'base64url'),
  );
  decipher.setAAD(Buffer.from(canonicalJson(aad)));
  decipher.setAuthTag(Buffer.from(input.envelope.tag, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(input.envelope.ciphertext, 'base64url')),
    decipher.final(),
  ]);
  const payload = recoveryBackupPayload(JSON.parse(plaintext.toString('utf8')));
  const expectedAad = recoveryAad(payload);
  if (input.envelope.aadDigest !== fingerprintPayload(expectedAad)) {
    throw new Error('Recovery backup AAD mismatch.');
  }
  return payload;
}

function recoveryAad(payload: RecoveryBackupPayload): JsonValue {
  return {
    schema: USER_EPOCH_RECOVERY_BACKUP_SCHEMA,
    workspaceId: payload.workspaceId,
    userId: payload.userId,
    userCryptoEpochId: payload.userCryptoEpochId,
    userEpochFingerprint: payload.userEpochFingerprint,
  };
}

function recoveryKdfParams(): RecoveryKdfParams {
  return {
    salt: crypto.randomBytes(16).toString('base64url'),
    keyLength: 32,
    N: 32768,
    r: 8,
    p: 1,
  };
}

function deriveRecoveryKey(recoveryKey: string, params: RecoveryKdfParams): Buffer {
  return crypto.scryptSync(recoveryKey, Buffer.from(params.salt, 'base64url'), params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * 1024 * 1024,
  });
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
    headers: trustedEdgeCryptoHeaders(),
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
    throw new Error(`Recovery backup sync failed: ${message}`);
  }
  return payload;
}

async function postJson(
  fetchImpl: typeof transportFetch,
  url: string,
  body: Record<string, unknown>,
  transportOptions: CryptoEpochSyncTarget,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: trustedEdgeCryptoHeaders({ 'content-type': 'application/json' }),
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
    throw new Error(`Recovery backup sync failed: ${message}`);
  }
  return payload;
}

function trustedEdgeCryptoHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: 'application/json',
    [TRUSTED_EDGE_CRYPTO_PROTOCOL_HEADER]: TRUSTED_EDGE_CRYPTO_PROTOCOL_VERSION,
    ...extra,
  };
}

function userKeyBackupResponse(value: unknown): UserKeyBackupResponse {
  const data = objectField(value, 'data');
  const schema = stringField(data, 'schema');
  const kdf = stringField(data, 'kdf');
  if (schema !== USER_EPOCH_RECOVERY_BACKUP_SCHEMA) {
    throw new Error(`Unsupported recovery backup schema: ${schema}`);
  }
  if (kdf !== RECOVERY_KDF) {
    throw new Error(`Unsupported recovery backup KDF: ${kdf}`);
  }
  return {
    id: stringField(data, 'id'),
    workspace_id: stringField(data, 'workspace_id'),
    user_id: numberOrStringField(data, 'user_id'),
    user_crypto_epoch_id: stringField(data, 'user_crypto_epoch_id'),
    schema,
    status: stringField(data, 'status'),
    kdf,
    kdf_params: recoveryKdfParamsResponse(objectField(data, 'kdf_params')),
    encrypted_payload: recoveryEnvelope(objectField(data, 'encrypted_payload')),
    created_at: typeof data.created_at === 'string' ? data.created_at : null,
  };
}

function recoveryKdfParamsResponse(value: Record<string, unknown>): RecoveryKdfParams {
  return {
    salt: stringField(value, 'salt'),
    keyLength: numberField(value, 'keyLength'),
    N: numberField(value, 'N'),
    r: numberField(value, 'r'),
    p: numberField(value, 'p'),
  };
}

function recoveryEnvelope(value: Record<string, unknown>): RecoveryEnvelope {
  return {
    schema: expectLiteral(
      stringField(value, 'schema'),
      USER_EPOCH_RECOVERY_ENVELOPE_SCHEMA,
      'recovery envelope schema',
    ),
    alg: expectLiteral(stringField(value, 'alg'), 'aes-256-gcm', 'recovery envelope algorithm'),
    aad: (value.aad ?? null) as JsonValue,
    iv: stringField(value, 'iv'),
    ciphertext: stringField(value, 'ciphertext'),
    tag: stringField(value, 'tag'),
    aadDigest: stringField(value, 'aadDigest'),
    createdAt: stringField(value, 'createdAt'),
  };
}

function recoveryBackupPayload(value: unknown): RecoveryBackupPayload {
  const data = objectValue(value);
  return {
    schema: expectLiteral(
      stringField(data, 'schema'),
      USER_EPOCH_RECOVERY_PAYLOAD_SCHEMA,
      'recovery payload schema',
    ),
    workspaceId: stringField(data, 'workspaceId'),
    userId: stringField(data, 'userId'),
    userCryptoEpochId: stringField(data, 'userCryptoEpochId'),
    userEpochFingerprint: stringField(data, 'userEpochFingerprint'),
    epoch: localUserEpochPayload(objectField(data, 'epoch')),
  };
}

function localUserEpochPayload(
  data: Record<string, unknown>,
): Omit<LocalUserCryptoEpoch, 'createdAt' | 'updatedAt'> {
  return {
    workspaceId: stringField(data, 'workspaceId'),
    userId: stringField(data, 'userId'),
    platformEpochId: typeof data.platformEpochId === 'string' ? data.platformEpochId : null,
    epoch: numberField(data, 'epoch'),
    schema: 'viewport.user_crypto_epoch/v1',
    status: 'active',
    encryptionPublicKeyJwk: objectField(data, 'encryptionPublicKeyJwk') as JsonValue,
    encryptionPrivateKeyJwk: objectField(data, 'encryptionPrivateKeyJwk') as JsonValue,
    signingPublicKeyJwk: objectField(data, 'signingPublicKeyJwk') as JsonValue,
    signingPrivateKeyJwk: objectField(data, 'signingPrivateKeyJwk') as JsonValue,
    fingerprint: stringField(data, 'fingerprint'),
    previousEpochFingerprint:
      typeof data.previousEpochFingerprint === 'string' ? data.previousEpochFingerprint : null,
  };
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  const object = objectValue(value);
  const child = object[field];
  if (!child || typeof child !== 'object' || Array.isArray(child)) {
    throw new Error(`Recovery backup response did not include ${field}`);
  }
  return child as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected recovery backup object.');
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const child = value[field];
  if (typeof child !== 'string' || child.trim().length === 0) {
    throw new Error(`Recovery backup response did not include ${field}`);
  }
  return child;
}

function numberField(value: Record<string, unknown>, field: string): number {
  const child = value[field];
  if (typeof child !== 'number') {
    throw new Error(`Recovery backup response did not include numeric ${field}`);
  }
  return child;
}

function numberOrStringField(value: Record<string, unknown>, field: string): number | string {
  const child = value[field];
  if (typeof child !== 'number' && typeof child !== 'string') {
    throw new Error(`Recovery backup response did not include ${field}`);
  }
  return child;
}

function expectLiteral<const T extends string>(value: string, expected: T, label: string): T {
  if (value !== expected) throw new Error(`Unsupported ${label}: ${value}`);
  return expected;
}
