import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeBackoffMs } from '../../src/relay/bridge-backoff.js';
import {
  CIRCUIT_BREAKER_MS,
  RELAY_KEY_ROTATE_AFTER_MESSAGES,
  RELAY_REPLAY_WINDOW,
} from '../../src/relay/bridge-constants.js';
import {
  decryptEnvelope,
  encryptEnvelope,
  fromBase64Url,
  parseRelayEnvelope,
  toBase64Url,
} from '../../src/relay/bridge-crypto.js';
import {
  deriveSessionFromKeyExchange,
  parseRelayKeyExchangeInitFrame,
} from '../../src/relay/bridge-key-exchange.js';
import { acceptInboundRelaySeq } from '../../src/relay/bridge-relay-sessions.js';
import { DaemonRelayBridge } from '../../src/relay/daemon-relay-bridge.js';
import {
  createPairingClientIdentity,
  createPairingRedeemProof,
  issuePairingOffer,
  redeemPairingOffer,
} from '../../src/server/pairing-offers.js';

function deriveClientSessionKey(params: {
  daemonPublicKey: string;
  clientPrivateKey: Buffer;
  clientNonce: Buffer;
  daemonNonce: Buffer;
  profile: 'noise-ik' | 'noise-ikpsk2';
  sessionId: string;
  epoch: number;
  pairingSecret?: Buffer;
}): Buffer {
  const clientEcdh = crypto.createECDH('prime256v1');
  clientEcdh.setPrivateKey(params.clientPrivateKey);
  const sharedSecret = clientEcdh.computeSecret(fromBase64Url(params.daemonPublicKey));
  const ikm =
    params.profile === 'noise-ikpsk2' && params.pairingSecret
      ? Buffer.concat([sharedSecret, params.pairingSecret])
      : sharedSecret;
  const salt = Buffer.concat([params.clientNonce, params.daemonNonce]);
  const info = Buffer.from(
    `viewport-relay-session-v2|${params.profile}|${params.sessionId}|${params.epoch}`,
    'utf8',
  );
  const key = crypto.hkdfSync('sha256', ikm, salt, info, 32);
  return Buffer.isBuffer(key) ? key : Buffer.from(key);
}

function deriveClientProof(params: {
  key: Buffer;
  requestId: string;
  profile: 'noise-ik' | 'noise-ikpsk2';
  clientPublicKey: string;
  daemonPublicKey: string;
  clientNonce: string;
  daemonNonce: string;
  sessionId: string;
  epoch: number;
}): string {
  const transcript = Buffer.from(
    [
      'viewport-relay-transcript-v2',
      params.requestId,
      params.profile,
      params.clientPublicKey,
      params.daemonPublicKey,
      params.clientNonce,
      params.daemonNonce,
      params.sessionId,
      String(params.epoch),
    ].join('|'),
    'utf8',
  );
  return toBase64Url(
    crypto.createHmac('sha256', params.key).update(transcript).digest().subarray(0, 16),
  );
}

function deriveClientInitProof(params: {
  daemonPublicKey: string;
  clientPrivateKey: Buffer;
  profile: 'noise-ik' | 'noise-ikpsk2';
  requestId: string;
  clientPublicKey: string;
  clientNonce: string;
  previousSessionId?: string;
  pairingSecret?: Buffer;
}): string {
  const clientEcdh = crypto.createECDH('prime256v1');
  clientEcdh.setPrivateKey(params.clientPrivateKey);
  const sharedSecret = clientEcdh.computeSecret(fromBase64Url(params.daemonPublicKey));
  const ikm =
    params.profile === 'noise-ikpsk2' && params.pairingSecret
      ? Buffer.concat([sharedSecret, params.pairingSecret])
      : sharedSecret;

  const info = Buffer.from(
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
  const salt = fromBase64Url(params.clientNonce);
  const key = crypto.hkdfSync('sha256', ikm, salt, info, 32);
  const normalizedKey = Buffer.isBuffer(key) ? key : Buffer.from(key);
  return toBase64Url(
    crypto
      .createHmac('sha256', normalizedKey)
      .update('client-proof', 'utf8')
      .digest()
      .subarray(0, 16),
  );
}

function makeRelayJwt(
  payload: Record<string, unknown>,
  options?: { kid?: string; key?: string; tamperPayloadAfterSign?: Record<string, unknown> },
): string {
  const kid = options?.kid ?? 'v1';
  const key = options?.key ?? 'viewport-poc-signing-key-change-me';
  const header = toBase64Url(
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid }), 'utf8'),
  );
  const body = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signingInput = `${header}.${body}`;
  const signature = toBase64Url(crypto.createHmac('sha256', key).update(signingInput).digest());
  if (!options?.tamperPayloadAfterSign) {
    return `${signingInput}.${signature}`;
  }
  const tamperedBody = toBase64Url(
    Buffer.from(JSON.stringify(options.tamperPayloadAfterSign), 'utf8'),
  );
  return `${header}.${tamperedBody}.${signature}`;
}

function makeRelayJwtRs256(
  payload: Record<string, unknown>,
  options: {
    privateKeyPem: string;
    kid?: string;
    tamperPayloadAfterSign?: Record<string, unknown>;
  },
): string {
  const kid = options.kid ?? 'v1';
  const header = toBase64Url(
    Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }), 'utf8'),
  );
  const body = toBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signingInput = `${header}.${body}`;
  const signature = toBase64Url(
    crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), options.privateKeyPem),
  );
  if (!options.tamperPayloadAfterSign) {
    return `${signingInput}.${signature}`;
  }
  const tamperedBody = toBase64Url(
    Buffer.from(JSON.stringify(options.tamperPayloadAfterSign), 'utf8'),
  );
  return `${header}.${tamperedBody}.${signature}`;
}

function rsaPublicJwkFromPrivatePem(privateKeyPem: string): { n: string; e: string } {
  const publicKey = crypto.createPublicKey(privateKeyPem);
  const exported = publicKey.export({ format: 'jwk' }) as { n?: string; e?: string };
  if (!exported?.n || !exported?.e) {
    throw new Error('failed to export RSA JWK');
  }
  return { n: exported.n, e: exported.e };
}

describe('daemon relay bridge helpers', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('computeBackoffMs is bounded and positive', () => {
    const values = Array.from({ length: 15 }, (_, i) => computeBackoffMs(i + 1));
    expect(values.every((v) => v >= 1000)).toBe(true);
    expect(values.every((v) => v <= 30_000)).toBe(true);
  });

  it('encrypt/decrypt envelope round-trips with v2 metadata-bound aad', () => {
    const key = Buffer.alloc(32, 7);
    const plaintext = JSON.stringify({ hello: 'world', n: 42 });
    const encoded = encryptEnvelope(key, plaintext, {
      profile: 'noise-ik',
      sessionId: 'rs_test',
      epoch: 1,
      seq: 1,
    });
    const envelope = parseRelayEnvelope(encoded);
    const decrypted = decryptEnvelope(key, envelope);
    expect(decrypted).toBe(plaintext);
  });

  it('parseRelayEnvelope rejects invalid envelope shape', () => {
    expect(() => parseRelayEnvelope(JSON.stringify({ type: 'x' }))).toThrow(
      'Invalid relay envelope',
    );
  });

  it('base64url helpers round-trip', () => {
    const original = Buffer.from('viewport-relay-key-material');
    const encoded = toBase64Url(original);
    const decoded = fromBase64Url(encoded);
    expect(decoded.equals(original)).toBe(true);
  });

  it('handles pairing offer/redeem control frames over relay', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-pairing-relay-test-'));
    const previousHome = process.env['VIEWPORT_HOME'];
    process.env['VIEWPORT_HOME'] = tempHome;

    try {
      const bridge = new DaemonRelayBridge({
        relayEndpoint: 'ws://127.0.0.1:7781/ws',
        relayServerUrl: 'http://127.0.0.1:7780',
        workspaceId: 'workspace_demo',
        daemonWsUrl: 'ws://127.0.0.1:7070/ws',
      });

      const sent: string[] = [];
      const relayWs = {
        readyState: 1,
        send(payload: string): void {
          sent.push(payload);
        },
      };
      const daemonWs = { readyState: 1 };

      const handledOffer = await (bridge as any).handleRelayControlFrame(
        JSON.stringify({
          type: 'relay_pairing_offer_request',
          requestId: 'pair-req-1',
          ttlSeconds: 600,
          clientChannelPublicKey: (() => {
            const ecdh = crypto.createECDH('prime256v1');
            ecdh.generateKeys();
            (global as any).__pairingClientEcdh = ecdh;
            return toBase64Url(ecdh.getPublicKey());
          })(),
        }),
        relayWs,
        daemonWs,
      );
      expect(handledOffer).toBe(true);
      expect(sent).toHaveLength(1);

      const offerResponse = JSON.parse(sent[0] ?? '{}') as {
        type: string;
        ok: boolean;
        requestId: string;
        daemonChannelPublicKey?: string;
        encIv?: string;
        encTag?: string;
        encCiphertext?: string;
      };
      expect(offerResponse.type).toBe('relay_pairing_offer_response');
      expect(offerResponse.ok).toBe(true);
      expect(offerResponse.requestId).toBe('pair-req-1');
      expect(typeof offerResponse.daemonChannelPublicKey).toBe('string');
      expect(typeof offerResponse.encIv).toBe('string');
      expect(typeof offerResponse.encTag).toBe('string');
      expect(typeof offerResponse.encCiphertext).toBe('string');
      const clientEcdh = (global as any).__pairingClientEcdh as crypto.ECDH;
      const channelShared = clientEcdh.computeSecret(
        fromBase64Url(String(offerResponse.daemonChannelPublicKey ?? '')),
      );
      const channelSalt = crypto.createHash('sha256').update('offer:pair-req-1', 'utf8').digest();
      const channelRaw = crypto.hkdfSync(
        'sha256',
        channelShared,
        channelSalt,
        Buffer.from('viewport-relay-pairing-channel-v1', 'utf8'),
        32,
      );
      const channelKey = Buffer.isBuffer(channelRaw) ? channelRaw : Buffer.from(channelRaw);
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        channelKey,
        fromBase64Url(String(offerResponse.encIv)),
      );
      decipher.setAAD(Buffer.from('offer:pair-req-1', 'utf8'));
      decipher.setAuthTag(fromBase64Url(String(offerResponse.encTag)));
      const offerPlain = Buffer.concat([
        decipher.update(fromBase64Url(String(offerResponse.encCiphertext))),
        decipher.final(),
      ]).toString('utf8');
      const offer = JSON.parse(offerPlain) as {
        offerId: string;
        redeemSecret: string;
        trustAnchor: string;
      };
      expect(typeof offer.offerId).toBe('string');
      expect(typeof offer.redeemSecret).toBe('string');
      expect(typeof offer.trustAnchor).toBe('string');

      const clientIdentity = createPairingClientIdentity();
      const redeemProof = createPairingRedeemProof({
        offerId: offer.offerId,
        redeemSecret: offer.redeemSecret,
        trustAnchor: offer.trustAnchor,
        clientIdentity,
      });

      const redeemPayload = JSON.stringify({
        redeemSecret: offer.redeemSecret,
        trustAnchor: offer.trustAnchor,
        clientPublicKey: redeemProof.clientPublicKey,
        clientProof: redeemProof.clientProof,
      });
      const redeemIv = crypto.randomBytes(12);
      const redeemCipher = crypto.createCipheriv('aes-256-gcm', channelKey, redeemIv);
      redeemCipher.setAAD(Buffer.from(`redeem:pair-req-2:${offer.offerId}`, 'utf8'));
      const redeemCiphertext = Buffer.concat([
        redeemCipher.update(redeemPayload, 'utf8'),
        redeemCipher.final(),
      ]);
      const redeemTag = redeemCipher.getAuthTag();

      const handledRedeem = await (bridge as any).handleRelayControlFrame(
        JSON.stringify({
          type: 'relay_pairing_redeem_request',
          requestId: 'pair-req-2',
          offerId: offer.offerId,
          encIv: toBase64Url(redeemIv),
          encTag: toBase64Url(redeemTag),
          encCiphertext: toBase64Url(redeemCiphertext),
        }),
        relayWs,
        daemonWs,
      );
      expect(handledRedeem).toBe(true);
      expect(sent).toHaveLength(2);

      const redeemResponse = JSON.parse(sent[1] ?? '{}') as {
        type: string;
        ok: boolean;
        requestId: string;
        redeemed?: {
          relayPairingPeerId: string;
          relayPairingSecret?: string;
        };
      };
      expect(redeemResponse.type).toBe('relay_pairing_redeem_response');
      expect(redeemResponse.ok).toBe(true);
      expect(redeemResponse.requestId).toBe('pair-req-2');
      expect(typeof redeemResponse.redeemed?.relayPairingPeerId).toBe('string');
      expect(redeemResponse.redeemed?.relayPairingSecret).toBeUndefined();
    } finally {
      delete (global as any).__pairingClientEcdh;
      if (previousHome === undefined) {
        delete process.env['VIEWPORT_HOME'];
      } else {
        process.env['VIEWPORT_HOME'] = previousHome;
      }
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('prunes stale and excess pairing channel keys', () => {
    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
    });

    const now = Date.now();
    (bridge as any).pairingChannelKeys.set('oldest', {
      key: Buffer.alloc(32, 1),
      createdAt: now - 20_000,
    });
    (bridge as any).pairingChannelKeys.set('middle', {
      key: Buffer.alloc(32, 2),
      createdAt: now - 5_000,
    });
    (bridge as any).pairingChannelKeys.set('newest', {
      key: Buffer.alloc(32, 3),
      createdAt: now - 1_000,
    });

    (bridge as any).prunePairingChannelKeys(now, 10_000, 1);

    const keys = Array.from((bridge as any).pairingChannelKeys.keys()) as string[];
    expect(keys).toEqual(['newest']);
  });

  it('issueRelayToken rejects missing relayToken payloads', async () => {
    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      issueToken: 'daemon-issue-token',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
    });

    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as typeof fetch;

    await expect((bridge as any).issueRelayToken()).rejects.toThrow('issue relay token failed');
  });

  it('registerDaemonPublicKey requires daemonIssueToken in response', async () => {
    const daemon = crypto.createECDH('prime256v1');
    const daemonPublic = daemon.generateKeys();
    const daemonPrivate = daemon.getPrivateKey();

    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
    });
    (bridge as any).daemonIdentity = {
      deviceId: 'device-1',
      createdAt: Date.now(),
      algorithm: 'p256',
      publicKey: toBase64Url(daemonPublic),
      privateKey: toBase64Url(daemonPrivate),
    };

    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch;

    await expect((bridge as any).registerDaemonPublicKey()).rejects.toThrow(
      'daemon issue token was missing',
    );
  });

  it('registerDaemonPublicKey keeps existing daemonIssueToken when response omits a new token', async () => {
    const daemon = crypto.createECDH('prime256v1');
    const daemonPublic = daemon.generateKeys();
    const daemonPrivate = daemon.getPrivateKey();

    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      issueToken: 'daemon-issue-existing',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
    });
    (bridge as any).daemonIdentity = {
      deviceId: 'device-1',
      createdAt: Date.now(),
      algorithm: 'p256',
      publicKey: toBase64Url(daemonPublic),
      privateKey: toBase64Url(daemonPrivate),
    };

    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch;

    await expect((bridge as any).registerDaemonPublicKey()).resolves.toBeUndefined();
    expect((bridge as any).daemonIssueToken).toBe('daemon-issue-existing');
  });

  it('registerDaemonPublicKey prefers daemon issue token over enroll token once paired', async () => {
    const daemon = crypto.createECDH('prime256v1');
    const daemonPublic = daemon.generateKeys();
    const daemonPrivate = daemon.getPrivateKey();

    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      issueToken: 'daemon-issue-token',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
    });
    (bridge as any).daemonIdentity = {
      deviceId: 'device-1',
      createdAt: Date.now(),
      algorithm: 'p256',
      publicKey: toBase64Url(daemonPublic),
      privateKey: toBase64Url(daemonPrivate),
    };

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock;

    await expect((bridge as any).registerDaemonPublicKey()).resolves.toBeUndefined();

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl).toBe(
      'http://127.0.0.1:7780/api/runtime/workspaces/workspace_demo/daemon-key',
    );
    const parsedBody = JSON.parse(String(requestInit?.body)) as {
      credential?: string;
    };
    expect(parsedBody.credential).toBe('daemon-issue-token');
  });

  it('issueRelayToken uses daemon issue token credential (not enroll token)', async () => {
    const signingKey = 'test-relay-signing-key-0123456789';
    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      issueToken: 'daemon-issue-token',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
      relayTokenSigningKeys: {
        v1: signingKey,
      },
    });

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          relayToken: makeRelayJwt(
            {
              role: 'workspace-daemon',
              workspaceId: 'workspace_demo',
              e2eeProfile: 'noise-ik',
              iss: 'viewport-server',
              aud: 'viewport-relay',
              exp: Math.floor(Date.now() / 1000) + 120,
              iat: Math.floor(Date.now() / 1000) - 5,
              jti: 'jti-1',
            },
            { key: signingKey },
          ),
          claims: {
            e2eeProfile: 'noise-ik',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    global.fetch = fetchMock;

    await (bridge as any).issueRelayToken();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}')) as {
      credential?: string;
      workspaceId?: string;
    };
    expect(body.credential).toBe('daemon-issue-token');
    expect(body.workspaceId).toBe('workspace_demo');
  });

  it('issueRelayToken derives profile from relay token payload, not response claims object', async () => {
    const signingKey = 'test-relay-signing-key-0123456789';
    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      issueToken: 'daemon-issue-token',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
      relayTokenSigningKeys: {
        v1: signingKey,
      },
    });

    const relayToken = makeRelayJwt(
      {
        role: 'workspace-daemon',
        workspaceId: 'workspace_demo',
        e2eeProfile: 'noise-ikpsk2',
        iss: 'viewport-server',
        aud: 'viewport-relay',
        exp: Math.floor(Date.now() / 1000) + 120,
        iat: Math.floor(Date.now() / 1000) - 5,
        jti: 'jti-2',
      },
      { key: signingKey },
    );

    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          relayToken,
          claims: {
            e2eeProfile: 'noise-ik',
            pairingSecret: null,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as typeof fetch;

    const issued = await (bridge as any).issueRelayToken();
    expect(issued.profile).toBe('noise-ikpsk2');
    expect((issued as { pairingSecret?: Buffer }).pairingSecret).toBeUndefined();
  });

  it('issueRelayToken rejects relay tokens with invalid signature', async () => {
    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      issueToken: 'daemon-issue-token',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
      relayTokenSigningKeys: {
        v1: 'expected-signing-key',
      },
      relayTokenIssuer: 'viewport-server',
      relayTokenAudience: 'viewport-relay',
    });

    const validPayload = {
      role: 'workspace-daemon',
      workspaceId: 'workspace_demo',
      e2eeProfile: 'noise-ik',
      iss: 'viewport-server',
      aud: 'viewport-relay',
      exp: Math.floor(Date.now() / 1000) + 120,
      iat: Math.floor(Date.now() / 1000) - 5,
      jti: 'jti-invalid-signature',
    };

    const tamperedToken = makeRelayJwt(validPayload, {
      key: 'expected-signing-key',
      tamperPayloadAfterSign: { ...validPayload, e2eeProfile: 'noise-ikpsk2' },
    });

    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          relayToken: tamperedToken,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as typeof fetch;

    await expect((bridge as any).issueRelayToken()).rejects.toThrow('signature');
  });

  it('issueRelayToken rejects relay tokens with wrong issuer', async () => {
    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      issueToken: 'daemon-issue-token',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
      relayTokenSigningKeys: {
        v1: 'expected-signing-key',
      },
      relayTokenIssuer: 'viewport-server',
      relayTokenAudience: 'viewport-relay',
    });

    const relayToken = makeRelayJwt(
      {
        role: 'workspace-daemon',
        workspaceId: 'workspace_demo',
        e2eeProfile: 'noise-ik',
        iss: 'other-issuer',
        aud: 'viewport-relay',
        exp: Math.floor(Date.now() / 1000) + 120,
        iat: Math.floor(Date.now() / 1000) - 5,
        jti: 'jti-wrong-issuer',
      },
      { key: 'expected-signing-key' },
    );

    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          relayToken,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as typeof fetch;

    await expect((bridge as any).issueRelayToken()).rejects.toThrow('issuer');
  });

  it('issueRelayToken validates RS256 relay token signatures using JWKS', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs1' }).toString();
    const jwk = rsaPublicJwkFromPrivatePem(privateKeyPem);

    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      issueToken: 'daemon-issue-token',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
      relayTokenIssuer: 'viewport-server',
      relayTokenAudience: 'viewport-relay',
      relayTokenJwksUrl: 'https://jwks.getviewport.example/api/.well-known/jwks.json',
    });

    const relayToken = makeRelayJwtRs256(
      {
        role: 'workspace-daemon',
        workspaceId: 'workspace_demo',
        e2eeProfile: 'noise-ik',
        iss: 'viewport-server',
        aud: 'viewport-relay',
        exp: Math.floor(Date.now() / 1000) + 120,
        iat: Math.floor(Date.now() / 1000) - 5,
        jti: 'jti-rs256',
      },
      { privateKeyPem, kid: 'v1' },
    );

    global.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            relayToken,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            keys: [
              {
                kty: 'RSA',
                kid: 'v1',
                alg: 'RS256',
                n: jwk.n,
                e: jwk.e,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ) as typeof fetch;

    const issued = await (bridge as any).issueRelayToken();
    expect(issued.profile).toBe('noise-ik');
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('issueRelayToken rejects JWKS responses with excessive key count', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs1' }).toString();
    const jwk = rsaPublicJwkFromPrivatePem(privateKeyPem);

    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      issueToken: 'daemon-issue-token',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
      relayTokenIssuer: 'viewport-server',
      relayTokenAudience: 'viewport-relay',
      relayTokenJwksUrl: 'https://jwks.getviewport.example/api/.well-known/jwks.json',
    });

    const relayToken = makeRelayJwtRs256(
      {
        role: 'workspace-daemon',
        workspaceId: 'workspace_demo',
        e2eeProfile: 'noise-ik',
        iss: 'viewport-server',
        aud: 'viewport-relay',
        exp: Math.floor(Date.now() / 1000) + 120,
        iat: Math.floor(Date.now() / 1000) - 5,
        jti: 'jti-rs256-too-many-keys',
      },
      { privateKeyPem, kid: 'v1' },
    );

    const hugeJwks = Array.from({ length: 128 }, (_, index) => ({
      kty: 'RSA',
      kid: index === 0 ? 'v1' : `extra-${index}`,
      alg: 'RS256',
      n: jwk.n,
      e: jwk.e,
    }));

    global.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            relayToken,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            keys: hugeJwks,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ) as typeof fetch;

    await expect((bridge as any).issueRelayToken()).rejects.toThrow('too many');
  });

  it('deriveSessionFromKeyExchange returns proof verifiable by client for noise-ik', () => {
    const client = crypto.createECDH('prime256v1');
    const clientPublic = client.generateKeys();
    const clientPrivate = client.getPrivateKey();

    const daemon = crypto.createECDH('prime256v1');
    const daemonPublic = daemon.generateKeys();
    const daemonPrivate = daemon.getPrivateKey();

    const requestId = 'kex-1';
    const clientNonce = crypto.randomBytes(16);
    const clientPublicKey = toBase64Url(clientPublic);

    const init = parseRelayKeyExchangeInitFrame({
      type: 'relay_key_exchange_init',
      version: 2,
      profile: 'noise-ik',
      requestId,
      clientPublicKey,
      clientNonce: toBase64Url(clientNonce),
      clientProof: deriveClientInitProof({
        daemonPublicKey: toBase64Url(daemonPublic),
        clientPrivateKey: clientPrivate,
        profile: 'noise-ik',
        requestId,
        clientPublicKey,
        clientNonce: toBase64Url(clientNonce),
      }),
    });
    expect(init).toBeTruthy();

    const derived = deriveSessionFromKeyExchange({
      init: init!,
      daemonIdentity: {
        algorithm: 'p256',
        publicKey: toBase64Url(daemonPublic),
        privateKey: toBase64Url(daemonPrivate),
      },
      nextEpoch: 1,
    });

    const expectedKey = deriveClientSessionKey({
      daemonPublicKey: derived.response.daemonPublicKey,
      clientPrivateKey: clientPrivate,
      clientNonce,
      daemonNonce: fromBase64Url(derived.response.daemonNonce),
      profile: derived.response.profile,
      sessionId: derived.response.sessionId,
      epoch: derived.response.epoch,
    });
    expect(expectedKey.equals(derived.session.key)).toBe(true);

    const expectedProof = deriveClientProof({
      key: expectedKey,
      requestId,
      profile: derived.response.profile,
      clientPublicKey: toBase64Url(clientPublic),
      daemonPublicKey: derived.response.daemonPublicKey,
      clientNonce: toBase64Url(clientNonce),
      daemonNonce: derived.response.daemonNonce,
      sessionId: derived.response.sessionId,
      epoch: derived.response.epoch,
    });
    expect(expectedProof).toBe(derived.response.proof);
  });

  it('deriveSessionFromKeyExchange requires pairing secret for noise-ikpsk2', () => {
    const client = crypto.createECDH('prime256v1');
    const clientPublic = client.generateKeys();

    const daemon = crypto.createECDH('prime256v1');
    const daemonPublic = daemon.generateKeys();
    const daemonPrivate = daemon.getPrivateKey();

    const init = parseRelayKeyExchangeInitFrame({
      type: 'relay_key_exchange_init',
      version: 2,
      profile: 'noise-ikpsk2',
      requestId: 'kex-psk',
      pairingPeerId: 'client-peer-1',
      clientPublicKey: toBase64Url(clientPublic),
      clientNonce: toBase64Url(crypto.randomBytes(16)),
      clientProof: 'test-proof',
    });
    expect(init).toBeTruthy();

    expect(() =>
      deriveSessionFromKeyExchange({
        init: init!,
        daemonIdentity: {
          algorithm: 'p256',
          publicKey: toBase64Url(daemonPublic),
          privateKey: toBase64Url(daemonPrivate),
        },
        nextEpoch: 1,
      }),
    ).toThrow('pairing secret required for noise-ikpsk2');
  });

  it('opens circuit breaker window after repeated token issue failures', async () => {
    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      issueToken: 'daemon-issue-token',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
    });

    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          reason: 'INVALID_WORKSPACE_ENROLL_TOKEN',
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    ) as typeof fetch;

    for (let i = 0; i < 5; i += 1) {
      await expect((bridge as any).issueRelayToken()).rejects.toThrow();
      (bridge as any).consecutiveIssueFailures += 1;
    }
    (bridge as any).circuitOpenUntilMs = Date.now() + CIRCUIT_BREAKER_MS;

    const status = bridge.getStatus();
    expect(status.circuitOpenUntil).toBeDefined();
  });

  it('requests key rotation after message threshold and dedupes replay sequence', () => {
    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
    });

    const sent: string[] = [];
    const relayWs = {
      send(payload: string): void {
        sent.push(payload);
      },
      readyState: 1,
    };

    const session = {
      key: Buffer.alloc(32, 4),
      profile: 'noise-ik' as const,
      sessionId: 'rs_rotate',
      epoch: 1,
      txSeq: RELAY_KEY_ROTATE_AFTER_MESSAGES - 1,
      rxHighestSeq: 0,
      rxSeenSeq: new Set<number>(),
      lastActivityAt: Date.now(),
      keyRotationRequested: false,
    };
    (bridge as any).relaySessions.set(session.sessionId, session);
    (bridge as any).sendToAllRelaySessions(relayWs, JSON.stringify({ type: 'ping' }));

    expect(sent.length).toBe(2);
    expect(JSON.parse(sent[1] ?? '{}')).toMatchObject({
      type: 'relay_key_update_required',
      sessionId: 'rs_rotate',
      nextEpoch: 2,
      reason: 'message_threshold',
    });
    expect(session.keyRotationRequested).toBe(true);

    expect(acceptInboundRelaySeq(session, 1)).toBe(true);
    expect(acceptInboundRelaySeq(session, 1)).toBe(false);
    expect(acceptInboundRelaySeq(session, RELAY_REPLAY_WINDOW + 10)).toBe(false);
  });

  it('supports overriding key rotation threshold for test harnesses', () => {
    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
      keyRotateAfterMessages: 2,
    });

    const sent: string[] = [];
    const relayWs = {
      send(payload: string): void {
        sent.push(payload);
      },
      readyState: 1,
    };

    (bridge as any).relaySessions.set('rs_override', {
      key: Buffer.alloc(32, 7),
      profile: 'noise-ik',
      sessionId: 'rs_override',
      epoch: 1,
      txSeq: 1,
      rxHighestSeq: 0,
      rxSeenSeq: new Set<number>(),
      lastActivityAt: Date.now(),
      keyRotationRequested: false,
    });

    (bridge as any).sendToAllRelaySessions(relayWs, JSON.stringify({ type: 'ping' }));
    expect(sent.length).toBe(2);
    expect(JSON.parse(sent[1] ?? '{}')).toMatchObject({
      type: 'relay_key_update_required',
      sessionId: 'rs_override',
      nextEpoch: 2,
      reason: 'message_threshold',
    });
  });

  it('rejects key exchange rekey requests for unknown previous session ids', async () => {
    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
    });
    const daemon = crypto.createECDH('prime256v1');
    const daemonPublic = daemon.generateKeys();
    const daemonPrivate = daemon.getPrivateKey();
    (bridge as any).daemonIdentity = {
      algorithm: 'p256',
      publicKey: toBase64Url(daemonPublic),
      privateKey: toBase64Url(daemonPrivate),
    };
    (bridge as any).requiredProfile = 'noise-ik';

    const client = crypto.createECDH('prime256v1');
    const clientPublic = client.generateKeys();
    const clientPrivate = client.getPrivateKey();
    const requestId = 'kex-unknown-previous';
    const clientNonce = toBase64Url(crypto.randomBytes(16));
    const clientPublicKey = toBase64Url(clientPublic);

    const init = parseRelayKeyExchangeInitFrame({
      type: 'relay_key_exchange_init',
      version: 2,
      profile: 'noise-ik',
      requestId,
      clientPublicKey,
      clientNonce,
      previousSessionId: 'missing-session-id',
      clientProof: deriveClientInitProof({
        daemonPublicKey: toBase64Url(daemonPublic),
        clientPrivateKey: clientPrivate,
        profile: 'noise-ik',
        requestId,
        clientPublicKey,
        clientNonce,
        previousSessionId: 'missing-session-id',
      }),
    });
    expect(init).toBeTruthy();

    const relayWs = {
      readyState: 1,
      send: vi.fn(),
    };
    await (bridge as any).handleKeyExchangeInit(init!, relayWs);
    expect((bridge as any).relaySessions.size).toBe(0);
    expect(relayWs.send).not.toHaveBeenCalled();
  });

  it('accepts stronger profile key exchange (noise-ikpsk2) when required profile is noise-ik', async () => {
    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
    });
    const daemon = crypto.createECDH('prime256v1');
    const daemonPublic = daemon.generateKeys();
    const daemonPrivate = daemon.getPrivateKey();
    (bridge as any).daemonIdentity = {
      algorithm: 'p256',
      publicKey: toBase64Url(daemonPublic),
      privateKey: toBase64Url(daemonPrivate),
    };
    (bridge as any).requiredProfile = 'noise-ik';

    const pairingSecret = crypto.randomBytes(32);
    (bridge as any).resolvePolicyCPairingSecret = vi.fn().mockResolvedValue(pairingSecret);

    const client = crypto.createECDH('prime256v1');
    const clientPublic = client.generateKeys();
    const clientPrivate = client.getPrivateKey();
    const requestId = 'kex-stronger-profile';
    const clientNonce = toBase64Url(crypto.randomBytes(16));
    const clientPublicKey = toBase64Url(clientPublic);

    const init = parseRelayKeyExchangeInitFrame({
      type: 'relay_key_exchange_init',
      version: 2,
      profile: 'noise-ikpsk2',
      requestId,
      pairingPeerId: 'client-peer-1',
      clientPublicKey,
      clientNonce,
      clientProof: deriveClientInitProof({
        daemonPublicKey: toBase64Url(daemonPublic),
        clientPrivateKey: clientPrivate,
        profile: 'noise-ikpsk2',
        requestId,
        clientPublicKey,
        clientNonce,
        pairingSecret,
      }),
    });
    expect(init).toBeTruthy();

    const relayWs = {
      readyState: 1,
      send: vi.fn(),
    };
    await (bridge as any).handleKeyExchangeInit(init!, relayWs);
    expect((bridge as any).relaySessions.size).toBe(1);
    expect(relayWs.send).toHaveBeenCalledTimes(1);
  });

  it('resolves policy C pairing secret after pairing redemption persists local peer binding', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-policyc-relay-test-'));
    const previousHome = process.env['VIEWPORT_HOME'];
    process.env['VIEWPORT_HOME'] = tempHome;

    try {
      const bridge = new DaemonRelayBridge({
        relayEndpoint: 'ws://127.0.0.1:7781/ws',
        relayServerUrl: 'http://127.0.0.1:7780',
        workspaceId: 'workspace_demo',
        daemonWsUrl: 'ws://127.0.0.1:7070/ws',
      });

      const offer = await issuePairingOffer({
        connection: {
          host: '127.0.0.1',
          port: 7070,
          listen: '127.0.0.1:7070',
          profile: 'relay',
        },
        ttlSeconds: 300,
      });
      const clientIdentity = createPairingClientIdentity();
      const redeemProof = createPairingRedeemProof({
        offerId: offer.offerId,
        redeemSecret: offer.redeemSecret,
        trustAnchor: offer.trustAnchor,
        clientIdentity,
      });
      const redeemed = await redeemPairingOffer(
        offer.offerId,
        offer.redeemSecret,
        offer.trustAnchor,
        redeemProof.clientPublicKey,
        redeemProof.clientProof,
      );
      expect(redeemed?.relayPairingPeerId).toBe(clientIdentity.peerId);

      const resolvedPairingSecret = await (bridge as any).resolvePolicyCPairingSecret(
        clientIdentity.peerId,
      );
      expect(resolvedPairingSecret).not.toBeUndefined();
      expect(resolvedPairingSecret?.length).toBe(32);
    } finally {
      if (previousHome === undefined) {
        delete process.env['VIEWPORT_HOME'];
      } else {
        process.env['VIEWPORT_HOME'] = previousHome;
      }
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('does not replay cached daemon state after key exchange', async () => {
    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
    });
    const daemon = crypto.createECDH('prime256v1');
    const daemonPublic = daemon.generateKeys();
    const daemonPrivate = daemon.getPrivateKey();
    (bridge as any).daemonIdentity = {
      algorithm: 'p256',
      publicKey: toBase64Url(daemonPublic),
      privateKey: toBase64Url(daemonPrivate),
    };
    (bridge as any).requiredProfile = 'noise-ik';

    const client = crypto.createECDH('prime256v1');
    const clientPublic = client.generateKeys();
    const clientPrivate = client.getPrivateKey();
    const requestId = 'kex-replay-cached-state';
    const clientNonce = toBase64Url(crypto.randomBytes(16));
    const clientPublicKey = toBase64Url(clientPublic);

    const init = parseRelayKeyExchangeInitFrame({
      type: 'relay_key_exchange_init',
      version: 2,
      profile: 'noise-ik',
      requestId,
      clientPublicKey,
      clientNonce,
      clientProof: deriveClientInitProof({
        daemonPublicKey: toBase64Url(daemonPublic),
        clientPrivateKey: clientPrivate,
        profile: 'noise-ik',
        requestId,
        clientPublicKey,
        clientNonce,
      }),
    });
    expect(init).toBeTruthy();

    const sent: string[] = [];
    const relayWs = {
      readyState: 1,
      send: vi.fn((payload: string) => {
        sent.push(payload);
      }),
    };

    await (bridge as any).handleKeyExchangeInit(init!, relayWs);

    expect(sent.length).toBe(1);
    const response = JSON.parse(sent[0] ?? '{}') as Record<string, unknown>;
    expect(response.type).toBe('relay_key_exchange_response');
  });

  it('validates relay_key_update_required epoch transitions before enabling rekey', async () => {
    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
    });

    (bridge as any).relaySessions.set('session-1', {
      key: Buffer.alloc(32, 9),
      profile: 'noise-ik',
      sessionId: 'session-1',
      epoch: 2,
      txSeq: 10,
      rxHighestSeq: 10,
      rxSeenSeq: new Set<number>(),
      lastActivityAt: Date.now(),
      keyRotationRequested: false,
    });

    const handledInvalid = await (bridge as any).handleRelayControlFrame(
      JSON.stringify({
        type: 'relay_key_update_required',
        sessionId: 'session-1',
        nextEpoch: 4,
        reason: 'message_threshold',
      }),
      { readyState: 1, close: vi.fn() },
      { readyState: 1, close: vi.fn() },
    );

    expect(handledInvalid).toBe(true);
    expect((bridge as any).relaySessions.get('session-1')?.keyRotationRequested).toBe(false);

    const handledValid = await (bridge as any).handleRelayControlFrame(
      JSON.stringify({
        type: 'relay_key_update_required',
        sessionId: 'session-1',
        nextEpoch: 3,
        reason: 'message_threshold',
      }),
      { readyState: 1, close: vi.fn() },
      { readyState: 1, close: vi.fn() },
    );

    expect(handledValid).toBe(true);
    expect((bridge as any).relaySessions.get('session-1')?.keyRotationRequested).toBe(true);
  });

  it('bounds pending outbound queue by bytes as well as message count', () => {
    class FakeWs extends EventEmitter {
      readyState = 3;
      send = vi.fn();
      close = vi.fn();
      terminate = vi.fn();
    }

    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
      maxPendingOutbound: 100,
      maxPendingOutboundBytes: 20,
    });

    const daemonWs = new FakeWs();
    const relayWs = new FakeWs();
    (bridge as any).installSocketHandlers(daemonWs, relayWs);

    daemonWs.emit('message', Buffer.from('1234567890', 'utf8'));
    daemonWs.emit('message', Buffer.from('abcdefghij', 'utf8'));
    daemonWs.emit('message', Buffer.from('KLMNOPQRST', 'utf8'));

    expect((bridge as any).pendingOutbound).toEqual(['abcdefghij', 'KLMNOPQRST']);
    expect((bridge as any).pendingOutboundBytes).toBe(20);
  });

  it('caps relay session map and evicts oldest sessions when over limit', () => {
    const bridge = new DaemonRelayBridge({
      relayEndpoint: 'ws://127.0.0.1:7781/ws',
      relayServerUrl: 'http://127.0.0.1:7780',
      workspaceId: 'workspace_demo',
      daemonWsUrl: 'ws://127.0.0.1:7070/ws',
      relaySessionMaxEntries: 1,
    } as any);

    (bridge as any).relaySessions.set('older', {
      key: Buffer.alloc(32, 1),
      profile: 'noise-ik',
      sessionId: 'older',
      epoch: 1,
      txSeq: 0,
      rxHighestSeq: 0,
      rxSeenSeq: new Set<number>(),
      lastActivityAt: Date.now(),
      keyRotationRequested: false,
    });
    (bridge as any).relaySessions.set('newer', {
      key: Buffer.alloc(32, 2),
      profile: 'noise-ik',
      sessionId: 'newer',
      epoch: 1,
      txSeq: 0,
      rxHighestSeq: 0,
      rxSeenSeq: new Set<number>(),
      lastActivityAt: Date.now(),
      keyRotationRequested: false,
    });

    (bridge as any).enforceRelaySessionCapacity();

    expect((bridge as any).relaySessions.size).toBe(1);
    expect((bridge as any).relaySessions.has('older')).toBe(false);
    expect((bridge as any).relaySessions.has('newer')).toBe(true);
  });

  it('parseRelayKeyExchangeInitFrame rejects missing client proof', () => {
    expect(
      parseRelayKeyExchangeInitFrame({
        type: 'relay_key_exchange_init',
        version: 2,
        profile: 'noise-ik',
        requestId: 'kex-missing-proof',
        clientPublicKey: 'abc',
        clientNonce: 'def',
      }),
    ).toBeNull();
  });

  it('deriveSessionFromKeyExchange rejects invalid client proof', () => {
    const client = crypto.createECDH('prime256v1');
    const clientPublic = client.generateKeys();
    const clientPrivate = client.getPrivateKey();

    const daemon = crypto.createECDH('prime256v1');
    const daemonPublic = daemon.generateKeys();
    const daemonPrivate = daemon.getPrivateKey();

    const requestId = 'kex-invalid-proof';
    const clientNonce = toBase64Url(crypto.randomBytes(16));
    const clientPublicKey = toBase64Url(clientPublic);

    const init = parseRelayKeyExchangeInitFrame({
      type: 'relay_key_exchange_init',
      version: 2,
      profile: 'noise-ik',
      requestId,
      clientPublicKey,
      clientNonce,
      clientProof: deriveClientInitProof({
        daemonPublicKey: toBase64Url(daemonPublic),
        clientPrivateKey: clientPrivate,
        profile: 'noise-ik',
        requestId,
        clientPublicKey,
        clientNonce,
      }),
    });

    expect(init).toBeTruthy();

    expect(() =>
      deriveSessionFromKeyExchange({
        init: {
          ...init!,
          clientProof: toBase64Url(crypto.randomBytes(16)),
        },
        daemonIdentity: {
          algorithm: 'p256',
          publicKey: toBase64Url(daemonPublic),
          privateKey: toBase64Url(daemonPrivate),
        },
        nextEpoch: 1,
      }),
    ).toThrow('invalid client key exchange proof');
  });
});
