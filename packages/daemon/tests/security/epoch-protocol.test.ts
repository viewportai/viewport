import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_ENROLLMENT_SCHEMA,
  TEAM_EPOCH_SCHEMA,
  USER_EPOCH_SCHEMA,
  assertNoPrivateKeyMaterial,
  canonicalJson,
  deviceEnrollmentFingerprint,
  epochFingerprint,
  epochTransitionPayload,
  signEpochTransition,
  unwrapJsonFromX25519Envelope,
  verifyEpochTransition,
  wrapJsonForX25519Recipient,
  type EpochDescriptor,
  type JsonValue,
} from '../../src/security/epoch-protocol.js';

describe('epoch protocol primitives', () => {
  it('canonicalizes JSON deterministically before hashing or signing', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(canonicalJson({ a: { c: 3, d: 4 }, b: 2 })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it('derives stable epoch fingerprints independent of object key insertion order', () => {
    const signing = ed25519Pair();
    const encryption = rsaPublicJwk('epoch-encryption');
    const epoch: EpochDescriptor = {
      schema: USER_EPOCH_SCHEMA,
      workspaceId: 'workspace-1',
      subjectType: 'user',
      subjectId: '42',
      epoch: 1,
      encryptionPublicKeyJwk: encryption,
      signingPublicKeyJwk: signing.publicJwk,
      previousEpochFingerprint: null,
      createdAt: '2026-05-13T00:00:00.000Z',
    };
    const reordered: EpochDescriptor = {
      ...epoch,
      signingPublicKeyJwk: { crv: 'Ed25519', x: signing.publicJwk.x, kty: 'OKP' },
      encryptionPublicKeyJwk: {
        e: (encryption as Record<string, JsonValue>).e,
        n: (encryption as Record<string, JsonValue>).n,
        kty: 'RSA',
      },
    };

    expect(epochFingerprint(epoch)).toBe(epochFingerprint(reordered));
    expect(epochFingerprint(epoch)).toMatch(/^sha256:[A-Za-z0-9_-]+$/);
  });

  it('signs epoch continuity and rejects substituted next epochs', () => {
    const epoch1Signing = ed25519Pair();
    const epoch2Signing = ed25519Pair();
    const from: EpochDescriptor = {
      schema: USER_EPOCH_SCHEMA,
      workspaceId: 'workspace-1',
      subjectType: 'user',
      subjectId: '42',
      epoch: 1,
      encryptionPublicKeyJwk: rsaPublicJwk('user-epoch-1'),
      signingPublicKeyJwk: epoch1Signing.publicJwk,
      previousEpochFingerprint: null,
      createdAt: '2026-05-13T00:00:00.000Z',
    };
    const to: EpochDescriptor = {
      schema: USER_EPOCH_SCHEMA,
      workspaceId: 'workspace-1',
      subjectType: 'user',
      subjectId: '42',
      epoch: 2,
      encryptionPublicKeyJwk: rsaPublicJwk('user-epoch-2'),
      signingPublicKeyJwk: epoch2Signing.publicJwk,
      previousEpochFingerprint: epochFingerprint(from),
      createdAt: '2026-05-13T00:10:00.000Z',
    };
    const payload = epochTransitionPayload({
      from,
      to,
      reason: 'device_revoked',
      createdAt: '2026-05-13T00:11:00.000Z',
    });
    const signed = signEpochTransition({
      payload,
      signingPrivateKeyJwk: epoch1Signing.privateJwk,
      signedByEpochFingerprint: epochFingerprint(from),
    });

    expect(
      verifyEpochTransition({
        signed,
        signingPublicKeyJwk: epoch1Signing.publicJwk,
        expectedFromEpochFingerprint: epochFingerprint(from),
        expectedToEpochFingerprint: epochFingerprint(to),
      }),
    ).toBe(true);

    const attackerEpoch: EpochDescriptor = {
      ...to,
      encryptionPublicKeyJwk: rsaPublicJwk('attacker-epoch-2'),
      signingPublicKeyJwk: ed25519Pair().publicJwk,
    };

    expect(
      verifyEpochTransition({
        signed,
        signingPublicKeyJwk: epoch1Signing.publicJwk,
        expectedFromEpochFingerprint: epochFingerprint(from),
        expectedToEpochFingerprint: epochFingerprint(attackerEpoch),
      }),
    ).toBe(false);
  });

  it('derives device enrollment commitments from public key material only', () => {
    const signing = ed25519Pair();
    const fingerprint = deviceEnrollmentFingerprint({
      schema: DEVICE_ENROLLMENT_SCHEMA,
      workspaceId: 'workspace-1',
      userId: '42',
      deviceId: 'vps-1',
      deviceLabel: 'prod-vps',
      encryptionPublicKeyJwk: rsaPublicJwk('vps-encryption'),
      signingPublicKeyJwk: signing.publicJwk,
      createdAt: '2026-05-13T00:00:00.000Z',
      nonce: 'nonce-1',
    });

    expect(fingerprint).toMatch(/^sha256:[A-Za-z0-9_-]+$/);
    expect(() =>
      assertNoPrivateKeyMaterial({
        public: signing.publicJwk,
        nested: { d: 'private-exponent' },
      }),
    ).toThrow('Private key material is not allowed');
  });

  it('supports team epoch descriptors as first-class signed subjects', () => {
    const teamSigning = ed25519Pair();
    const epoch: EpochDescriptor = {
      schema: TEAM_EPOCH_SCHEMA,
      workspaceId: 'workspace-1',
      subjectType: 'team',
      subjectId: 'team-7',
      epoch: 1,
      encryptionPublicKeyJwk: rsaPublicJwk('team-epoch-1'),
      signingPublicKeyJwk: teamSigning.publicJwk,
      previousEpochFingerprint: null,
      createdAt: '2026-05-13T00:00:00.000Z',
    };

    expect(epochFingerprint(epoch)).toMatch(/^sha256:[A-Za-z0-9_-]+$/);
  });

  it('wraps key material so only the recipient X25519 private key and matching AAD can unwrap it', () => {
    const recipient = x25519Pair();
    const other = x25519Pair();
    const aad = {
      schema: 'viewport.test_wrap_aad/v1',
      workspaceId: 'workspace-1',
      resourceId: 'vault-1',
      recipient: 'bob',
    };
    const payload = {
      schema: 'viewport.test_secret/v1',
      secret: 'repo-key-material',
    };

    const envelope = wrapJsonForX25519Recipient({
      recipientPublicKeyJwk: recipient.publicJwk,
      payload,
      aad,
      createdAt: '2026-05-13T00:00:00.000Z',
    });

    expect(JSON.stringify(envelope)).not.toContain('repo-key-material');
    expect(
      unwrapJsonFromX25519Envelope({
        recipientPrivateKeyJwk: recipient.privateJwk,
        envelope,
        aad,
      }),
    ).toEqual(payload);
    expect(() =>
      unwrapJsonFromX25519Envelope({
        recipientPrivateKeyJwk: recipient.privateJwk,
        envelope,
        aad: { ...aad, recipient: 'mallory' },
      }),
    ).toThrow(/AAD mismatch/);
    expect(() =>
      unwrapJsonFromX25519Envelope({
        recipientPrivateKeyJwk: other.privateJwk,
        envelope,
        aad,
      }),
    ).toThrow();
  });
});

function ed25519Pair(): { publicJwk: JsonValue; privateJwk: JsonValue } {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    publicJwk: pair.publicKey.export({ format: 'jwk' }) as JsonValue,
    privateJwk: pair.privateKey.export({ format: 'jwk' }) as JsonValue,
  };
}

function x25519Pair(): { publicJwk: JsonValue; privateJwk: JsonValue } {
  const pair = crypto.generateKeyPairSync('x25519');
  return {
    publicJwk: pair.publicKey.export({ format: 'jwk' }) as JsonValue,
    privateJwk: pair.privateKey.export({ format: 'jwk' }) as JsonValue,
  };
}

function rsaPublicJwk(label: string): JsonValue {
  return {
    kty: 'RSA',
    e: 'AQAB',
    n: Buffer.from(`${label}:`.repeat(32)).toString('base64url'),
  };
}
