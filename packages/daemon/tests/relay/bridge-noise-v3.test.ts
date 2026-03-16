import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createNoiseV3Init,
  deriveNoiseV3SessionFromInit,
  finalizeNoiseV3Response,
  type NoiseV3HandshakeProfile,
} from '../../src/relay/bridge-noise-v3.js';
import { toBase64Url } from '../../src/relay/bridge-crypto.js';
import type { DaemonRelayIdentity } from '../../src/relay/bridge-key-exchange.js';

function makeIdentityFromSeed(seed: string): DaemonRelayIdentity {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(crypto.createHash('sha256').update(seed, 'utf8').digest());
  return {
    algorithm: 'p256',
    privateKey: toBase64Url(ecdh.getPrivateKey()),
    publicKey: toBase64Url(ecdh.getPublicKey()),
  };
}

describe('Noise v3 handshake', () => {
  const daemonIdentity = makeIdentityFromSeed('daemon-noise-v3-seed-001');

  for (const profile of ['noise-ik', 'noise-ikpsk2'] as const satisfies NoiseV3HandshakeProfile[]) {
    it(`establishes a matching session key for ${profile}`, () => {
      const pairingSecret = profile === 'noise-ikpsk2' ? crypto.randomBytes(32) : undefined;
      const init = createNoiseV3Init({
        profile,
        daemonPublicKey: daemonIdentity.publicKey,
        pairingSecret,
        requestId: 'kex-v3-test',
      });

      const derived = deriveNoiseV3SessionFromInit({
        init: init.frame,
        daemonIdentity,
        nextEpoch: 1,
        pairingSecret,
      });

      const client = finalizeNoiseV3Response({
        state: init.state,
        response: derived.response,
        pairingSecret,
      });

      expect(client.sessionId).toBe(derived.session.sessionId);
      expect(client.epoch).toBe(derived.session.epoch);
      expect(client.profile).toBe(profile);
      expect(client.key.equals(derived.session.key)).toBe(true);
    });
  }

  it('rejects tampered response proof', () => {
    const init = createNoiseV3Init({
      profile: 'noise-ik',
      daemonPublicKey: daemonIdentity.publicKey,
      requestId: 'kex-v3-proof-tamper',
    });

    const derived = deriveNoiseV3SessionFromInit({
      init: init.frame,
      daemonIdentity,
      nextEpoch: 1,
    });

    const timingSpy = vi.spyOn(crypto, 'timingSafeEqual');
    expect(() =>
      finalizeNoiseV3Response({
        state: init.state,
        response: {
          ...derived.response,
          proof: toBase64Url(crypto.randomBytes(32)),
        },
      }),
    ).toThrow('noise handshake proof mismatch');
    expect(timingSpy).toHaveBeenCalled();
    timingSpy.mockRestore();
  });
});
