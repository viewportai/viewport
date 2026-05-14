import type { LocalTeamCryptoEpoch } from './epoch-store.js';
import type { JsonValue, WrappedKeyEnvelope } from './epoch-protocol.js';

export interface PublicUserEpoch {
  id: string;
  workspace_id: string;
  user_id: number | string;
  epoch: number;
  fingerprint: string;
  encryption_public_key_jwk: JsonValue;
  signing_public_key_jwk: JsonValue;
  previous_epoch_fingerprint?: string | null;
  continuity_payload?: JsonValue | null;
  continuity_signature?: string | null;
  signed_by_epoch_fingerprint?: string | null;
}

export interface TeamMemberGrantPayload {
  id: string;
  team_crypto_epoch_id: string;
  recipient_user_crypto_epoch_id: string;
  aad: JsonValue;
  encrypted_payload: WrappedKeyEnvelope;
}

export function teamEpochMemberGrantAad(input: {
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

export function publicUserEpochPayload(value: unknown): PublicUserEpoch {
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
    continuity_payload:
      data.continuity_payload && typeof data.continuity_payload === 'object'
        ? (data.continuity_payload as JsonValue)
        : null,
    continuity_signature:
      typeof data.continuity_signature === 'string' ? data.continuity_signature : null,
    signed_by_epoch_fingerprint:
      typeof data.signed_by_epoch_fingerprint === 'string'
        ? data.signed_by_epoch_fingerprint
        : null,
  };
}

export function teamMemberGrantPayload(value: unknown): TeamMemberGrantPayload {
  const data = record(value, 'team member grant');
  return {
    id: stringField(data, 'id'),
    team_crypto_epoch_id: stringField(data, 'team_crypto_epoch_id'),
    recipient_user_crypto_epoch_id: stringField(data, 'recipient_user_crypto_epoch_id'),
    aad: objectField(data, 'aad') as JsonValue,
    encrypted_payload: objectField(data, 'encrypted_payload') as unknown as WrappedKeyEnvelope,
  };
}

export function teamMaterialPayload(value: JsonValue): {
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

export function arrayField(value: unknown, field: string): unknown[] {
  const data = record(value, 'response');
  const child = data[field];
  if (!Array.isArray(child)) throw new Error(`Response did not include ${field} array.`);
  return child;
}

export function objectField(value: unknown, field: string): Record<string, unknown> {
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
