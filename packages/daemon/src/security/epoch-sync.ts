import { transportFetch, type TlsVerifyMode } from '../cli/network.js';
import { configDir } from '../core/config.js';
import {
  createLocalUserEpochKeyMaterial,
  getActiveLocalUserEpoch,
  upsertLocalUserEpoch,
  type LocalUserCryptoEpoch,
} from './epoch-store.js';
import type { JsonValue } from './epoch-protocol.js';

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
      epoch: numberField(data, 'epoch'),
      schema: 'viewport.user_crypto_epoch/v1',
      status: 'active',
      encryptionPublicKeyJwk: objectField(data, 'encryption_public_key_jwk') as JsonValue,
      encryptionPrivateKeyJwk: material.encryptionPrivateKeyJwk,
      signingPublicKeyJwk: objectField(data, 'signing_public_key_jwk') as JsonValue,
      signingPrivateKeyJwk: material.signingPrivateKeyJwk,
      fingerprint: stringField(data, 'fingerprint'),
      previousEpochFingerprint:
        typeof data.previous_epoch_fingerprint === 'string' ? data.previous_epoch_fingerprint : null,
    },
    options.home ?? configDir(),
  );
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected response object while reading ${field}`);
  }
  const child = (value as Record<string, unknown>)[field];
  if (!child || typeof child !== 'object' || Array.isArray(child)) {
    throw new Error(`Crypto epoch response did not include ${field}`);
  }
  return child as Record<string, unknown>;
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
