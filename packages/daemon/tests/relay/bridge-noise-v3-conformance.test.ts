import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from '../../src/relay/bridge-crypto.js';
import {
  createNoiseV3Init,
  deriveNoiseV3SessionFromInit,
  finalizeNoiseV3Response,
  type NoiseV3HandshakeProfile,
} from '../../src/relay/bridge-noise-v3.js';
import type { DaemonRelayIdentity } from '../../src/relay/bridge-key-exchange.js';

type VectorDoc = {
  daemonIdentity: { publicKey: string; privateKey: string };
  clientDeterministicKeys: { staticPrivateKey: string; ephemeralPrivateKey: string };
  daemonDeterministicEphemeralPrivateKey: string;
  vectors: Array<{
    id: string;
    profile: NoiseV3HandshakeProfile;
    requestId: string;
    pairingSecret?: string;
    sessionId: string;
    epoch: number;
    init: {
      clientEphemeralPublicKey: string;
      encryptedClientStatic: string;
    };
    response: {
      daemonEphemeralPublicKey: string;
      encryptedMetadata: string;
      proof: string;
    };
    sessionKey: string;
  }>;
};

const FIXTURE_PATH = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  'docs',
  'test-vectors',
  'relay-noise-v3.json',
);

function loadFixture(): VectorDoc {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  return JSON.parse(raw) as VectorDoc;
}

describe('Noise v3 conformance vectors', () => {
  it('matches deterministic IK/IKpsk2 vectors exactly', () => {
    const fixture = loadFixture();
    const daemonIdentity: DaemonRelayIdentity = {
      algorithm: 'p256',
      publicKey: fixture.daemonIdentity.publicKey,
      privateKey: fixture.daemonIdentity.privateKey,
    };

    for (const vector of fixture.vectors) {
      const pairingSecret = vector.pairingSecret ? fromBase64Url(vector.pairingSecret) : undefined;

      const init = createNoiseV3Init({
        profile: vector.profile,
        requestId: vector.requestId,
        daemonPublicKey: fixture.daemonIdentity.publicKey,
        pairingSecret,
        clientStaticPrivateKeyOverride: fromBase64Url(
          fixture.clientDeterministicKeys.staticPrivateKey,
        ),
        clientEphemeralPrivateKeyOverride: fromBase64Url(
          fixture.clientDeterministicKeys.ephemeralPrivateKey,
        ),
      });

      expect(init.frame.clientEphemeralPublicKey).toBe(vector.init.clientEphemeralPublicKey);
      expect(init.frame.encryptedClientStatic).toBe(vector.init.encryptedClientStatic);

      const derived = deriveNoiseV3SessionFromInit({
        init: init.frame,
        daemonIdentity,
        nextEpoch: vector.epoch,
        pairingSecret,
        daemonEphemeralPrivateKeyOverride: fromBase64Url(
          fixture.daemonDeterministicEphemeralPrivateKey,
        ),
        sessionIdOverride: vector.sessionId,
      });

      expect(derived.response.daemonEphemeralPublicKey).toBe(
        vector.response.daemonEphemeralPublicKey,
      );
      expect(derived.response.encryptedMetadata).toBe(vector.response.encryptedMetadata);
      expect(derived.response.proof).toBe(vector.response.proof);
      expect(toBase64Url(derived.session.key)).toBe(vector.sessionKey);

      const finalized = finalizeNoiseV3Response({
        state: init.state,
        response: derived.response,
        pairingSecret,
      });

      expect(finalized.sessionId).toBe(vector.sessionId);
      expect(finalized.epoch).toBe(vector.epoch);
      expect(finalized.profile).toBe(vector.profile);
      expect(finalized.key.equals(derived.session.key)).toBe(true);
    }
  });
});
