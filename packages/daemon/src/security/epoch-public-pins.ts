import { configDir } from '../core/config.js';
import {
  epochFingerprint,
  verifyEpochTransition,
  type EpochDescriptor,
  type EpochTransitionPayload,
  type JsonValue,
  type SignedEpochTransition,
} from './epoch-protocol.js';
import {
  getLocalPublicEpochPin,
  upsertLocalPublicEpochPin,
  type LocalPublicEpochPin,
} from './epoch-store.js';

export interface PublicEpochForPinning {
  platformEpochId: string;
  workspaceId: string;
  subjectType: 'user' | 'team';
  subjectId: string;
  epoch: number;
  schema: 'viewport.user_crypto_epoch/v1' | 'viewport.team_crypto_epoch/v1';
  fingerprint: string;
  encryptionPublicKeyJwk: JsonValue;
  signingPublicKeyJwk: JsonValue;
  previousEpochFingerprint?: string | null;
  continuityPayload?: JsonValue | null;
  continuitySignature?: string | null;
  signedByEpochFingerprint?: string | null;
}

export async function validateAndPinPublicEpoch(
  epoch: PublicEpochForPinning,
  home = configDir(),
): Promise<LocalPublicEpochPin> {
  const descriptor = publicEpochDescriptor(epoch);
  const computedFingerprint = epochFingerprint(descriptor);
  if (computedFingerprint !== epoch.fingerprint) {
    throw new Error(
      `Fetched ${epoch.subjectType} epoch fingerprint mismatch for ${epoch.subjectId}.`,
    );
  }

  const previous = await getLocalPublicEpochPin(
    {
      workspaceId: epoch.workspaceId,
      subjectType: epoch.subjectType,
      subjectId: epoch.subjectId,
    },
    home,
  );

  if (previous) {
    if (epoch.epoch < previous.epoch) {
      throw new Error(
        `Fetched ${epoch.subjectType} epoch rollback for ${epoch.subjectId}: ${epoch.epoch} < ${previous.epoch}.`,
      );
    }
    if (epoch.epoch === previous.epoch && epoch.fingerprint !== previous.fingerprint) {
      throw new Error(
        `Fetched ${epoch.subjectType} epoch replacement for ${epoch.subjectId} requires signed continuity.`,
      );
    }
    if (epoch.epoch > previous.epoch) {
      assertSignedContinuity({ previous, next: epoch });
    }
  }

  return upsertLocalPublicEpochPin(
    {
      workspaceId: epoch.workspaceId,
      subjectType: epoch.subjectType,
      subjectId: epoch.subjectId,
      platformEpochId: epoch.platformEpochId,
      epoch: epoch.epoch,
      schema: epoch.schema,
      fingerprint: epoch.fingerprint,
      encryptionPublicKeyJwk: epoch.encryptionPublicKeyJwk,
      signingPublicKeyJwk: epoch.signingPublicKeyJwk,
      previousEpochFingerprint: epoch.previousEpochFingerprint ?? null,
      continuityPayload: epoch.continuityPayload ?? null,
      continuitySignature: epoch.continuitySignature ?? null,
      signedByEpochFingerprint: epoch.signedByEpochFingerprint ?? null,
    },
    home,
  );
}

function assertSignedContinuity(input: {
  previous: LocalPublicEpochPin;
  next: PublicEpochForPinning;
}): void {
  if (input.next.previousEpochFingerprint !== input.previous.fingerprint) {
    throw new Error(
      `Fetched ${input.next.subjectType} epoch ${input.next.epoch} does not continue from pinned epoch ${input.previous.epoch}.`,
    );
  }
  if (!input.next.continuityPayload || !input.next.continuitySignature) {
    throw new Error(
      `Fetched ${input.next.subjectType} epoch ${input.next.epoch} is missing signed continuity.`,
    );
  }

  const signed: SignedEpochTransition = {
    payload: epochTransitionPayload(input.next.continuityPayload),
    signature: input.next.continuitySignature,
    signedByEpochFingerprint:
      input.next.signedByEpochFingerprint ?? input.next.previousEpochFingerprint ?? '',
  };
  const ok = verifyEpochTransition({
    signed,
    signingPublicKeyJwk: input.previous.signingPublicKeyJwk,
    expectedFromEpochFingerprint: input.previous.fingerprint,
    expectedToEpochFingerprint: input.next.fingerprint,
  });
  if (!ok) {
    throw new Error(
      `Fetched ${input.next.subjectType} epoch ${input.next.epoch} continuity signature is invalid.`,
    );
  }
}

function publicEpochDescriptor(epoch: PublicEpochForPinning): EpochDescriptor {
  return {
    schema: epoch.schema,
    workspaceId: epoch.workspaceId,
    subjectType: epoch.subjectType,
    subjectId: epoch.subjectId,
    epoch: epoch.epoch,
    encryptionPublicKeyJwk: epoch.encryptionPublicKeyJwk,
    signingPublicKeyJwk: epoch.signingPublicKeyJwk,
    previousEpochFingerprint: epoch.previousEpochFingerprint ?? null,
    createdAt: 'pinning-fingerprint-input',
  };
}

function epochTransitionPayload(value: JsonValue): EpochTransitionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Epoch continuity payload must be an object.');
  }
  const data = value as Record<string, JsonValue>;
  return {
    schema: 'viewport.epoch_transition/v1',
    workspaceId: stringField(data, 'workspaceId'),
    subjectType: subjectTypeField(data, 'subjectType'),
    subjectId: stringField(data, 'subjectId'),
    fromEpoch: numberField(data, 'fromEpoch'),
    fromEpochFingerprint: stringField(data, 'fromEpochFingerprint'),
    toEpoch: numberField(data, 'toEpoch'),
    toEpochFingerprint: stringField(data, 'toEpochFingerprint'),
    reason: reasonField(data, 'reason'),
    createdAt: stringField(data, 'createdAt'),
  };
}

function stringField(value: Record<string, JsonValue>, field: string): string {
  const child = value[field];
  if (typeof child !== 'string' || child.trim() === '') {
    throw new Error(`Epoch continuity payload missing ${field}.`);
  }
  return child;
}

function numberField(value: Record<string, JsonValue>, field: string): number {
  const child = value[field];
  if (typeof child !== 'number') {
    throw new Error(`Epoch continuity payload missing numeric ${field}.`);
  }
  return child;
}

function subjectTypeField(value: Record<string, JsonValue>, field: string): 'user' | 'team' {
  const child = stringField(value, field);
  if (child !== 'user' && child !== 'team') {
    throw new Error(`Epoch continuity payload has unsupported ${field}.`);
  }
  return child;
}

function reasonField(
  value: Record<string, JsonValue>,
  field: string,
): EpochTransitionPayload['reason'] {
  const child = stringField(value, field);
  if (
    child === 'initial' ||
    child === 'device_enrolled' ||
    child === 'device_revoked' ||
    child === 'member_revoked' ||
    child === 'manual_rotation' ||
    child === 'recovery'
  ) {
    return child;
  }
  throw new Error(`Epoch continuity payload has unsupported ${field}.`);
}
