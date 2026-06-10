import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  deriveSessionFromKeyExchange,
  parseRelayKeyExchangeInitFrame,
  type RelayHandshakeProfile,
} from '../../src/relay/bridge-key-exchange.js';
import { fromBase64Url, toBase64Url } from '../../src/relay/bridge-crypto.js';

interface RelayConformanceVector {
  id: string;
  profile: RelayHandshakeProfile;
  requestId: string;
  clientPrivateKey: string;
  clientPublicKey: string;
  daemonPrivateKey: string;
  daemonPublicKey: string;
  pairingSecret?: string;
  clientNonce: string;
  daemonNonce: string;
  sessionId: string;
  previousSessionId?: string;
  epoch: number;
  expectedClientProof: string;
  expectedSessionKey: string;
  expectedDaemonProof: string;
}

interface RelayConformanceDoc {
  schemaVersion: number;
  vectors: RelayConformanceVector[];
}

const FIXTURE_PATH = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  'docs',
  'test-vectors',
  'relay-noise-v2.json',
);

function loadVectors(): RelayConformanceVector[] {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as RelayConformanceDoc;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.vectors)) {
    throw new Error('invalid relay conformance fixture');
  }
  return parsed.vectors;
}

function toInitInfo(params: {
  requestId: string;
  profile: RelayHandshakeProfile;
  clientPublicKey: string;
  daemonPublicKey: string;
  clientNonce: string;
  previousSessionId?: string;
}): Buffer {
  return Buffer.from(
    [
      'viewport-relay-kex-init-v1',
      params.requestId,
      params.profile,
      params.clientPublicKey,
      params.daemonPublicKey,
      params.clientNonce,
      params.previousSessionId ?? '',
    ].join('|'),
    'utf8',
  );
}

function computeInitProof(vector: RelayConformanceVector): string {
  const clientPrivate = fromBase64Url(vector.clientPrivateKey);
  const daemonPublic = fromBase64Url(vector.daemonPublicKey);
  const clientNonce = fromBase64Url(vector.clientNonce);

  const client = crypto.createECDH('prime256v1');
  client.setPrivateKey(clientPrivate);
  const sharedSecret = client.computeSecret(daemonPublic);

  const ikm =
    vector.profile === 'noise-ikpsk2' && vector.pairingSecret
      ? Buffer.concat([sharedSecret, fromBase64Url(vector.pairingSecret)])
      : sharedSecret;

  const initKey = crypto.hkdfSync(
    'sha256',
    ikm,
    clientNonce,
    toInitInfo({
      requestId: vector.requestId,
      profile: vector.profile,
      clientPublicKey: vector.clientPublicKey,
      daemonPublicKey: vector.daemonPublicKey,
      clientNonce: vector.clientNonce,
      previousSessionId: vector.previousSessionId,
    }),
    32,
  );

  const normalized = Buffer.isBuffer(initKey) ? initKey : Buffer.from(initKey);
  return toBase64Url(
    crypto.createHmac('sha256', normalized).update('client-proof', 'utf8').digest().subarray(0, 16),
  );
}

describe('relay key exchange conformance vectors', () => {
  const vectors = loadVectors();

  it('matches deterministic vectors for noise-ik and noise-ikpsk2', () => {
    for (const vector of vectors) {
      const computedInitProof = computeInitProof(vector);
      expect(computedInitProof).toBe(vector.expectedClientProof);

      const init = parseRelayKeyExchangeInitFrame({
        type: 'relay_key_exchange_init',
        version: 2,
        profile: vector.profile,
        requestId: vector.requestId,
        pairingPeerId: vector.profile === 'noise-ikpsk2' ? `peer-${vector.id}` : undefined,
        clientPublicKey: vector.clientPublicKey,
        clientNonce: vector.clientNonce,
        clientProof: computedInitProof,
        previousSessionId: vector.previousSessionId,
      });
      expect(init).toBeTruthy();

      const derived = deriveSessionFromKeyExchange({
        init: init!,
        daemonIdentity: {
          algorithm: 'p256',
          publicKey: vector.daemonPublicKey,
          privateKey: vector.daemonPrivateKey,
        },
        nextEpoch: vector.epoch,
        pairingSecret: vector.pairingSecret ? fromBase64Url(vector.pairingSecret) : undefined,
        daemonNonceOverride: fromBase64Url(vector.daemonNonce),
        sessionIdOverride: vector.sessionId,
      });

      expect(derived.response.profile).toBe(vector.profile);
      expect(derived.response.requestId).toBe(vector.requestId);
      expect(derived.response.daemonPublicKey).toBe(vector.daemonPublicKey);
      expect(derived.response.daemonNonce).toBe(vector.daemonNonce);
      expect(derived.response.sessionId).toBe(vector.sessionId);
      expect(derived.response.epoch).toBe(vector.epoch);
      expect(derived.response.proof).toBe(vector.expectedDaemonProof);
      expect(toBase64Url(derived.session.key)).toBe(vector.expectedSessionKey);
      expect(derived.session.profile).toBe(vector.profile);
      expect(derived.session.sessionId).toBe(vector.sessionId);
      expect(derived.session.epoch).toBe(vector.epoch);
    }
  });

  it('rejects tampered client proof from conformance vectors', () => {
    const vector = vectors[0]!;
    const validProof = computeInitProof(vector);
    const tamperedProof = toBase64Url(
      fromBase64Url(validProof).map((byte, idx) => (idx === 0 ? byte ^ 1 : byte)),
    );

    const init = parseRelayKeyExchangeInitFrame({
      type: 'relay_key_exchange_init',
      version: 2,
      profile: vector.profile,
      requestId: vector.requestId,
      pairingPeerId: vector.profile === 'noise-ikpsk2' ? `peer-${vector.id}` : undefined,
      clientPublicKey: vector.clientPublicKey,
      clientNonce: vector.clientNonce,
      clientProof: tamperedProof,
      previousSessionId: vector.previousSessionId,
    });
    expect(init).toBeTruthy();

    expect(() =>
      deriveSessionFromKeyExchange({
        init: init!,
        daemonIdentity: {
          algorithm: 'p256',
          publicKey: vector.daemonPublicKey,
          privateKey: vector.daemonPrivateKey,
        },
        nextEpoch: vector.epoch,
        pairingSecret: vector.pairingSecret ? fromBase64Url(vector.pairingSecret) : undefined,
        daemonNonceOverride: fromBase64Url(vector.daemonNonce),
        sessionIdOverride: vector.sessionId,
      }),
    ).toThrow('invalid client key exchange proof');
  });
});
