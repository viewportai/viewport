import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createPairingClientIdentity,
  createPairingRedeemProof,
  issuePairingOffer,
  listPairingOffers,
  resolveRelayPairingSecret,
  redeemPairingOffer,
  revokePairingOffer,
  rotateAuthToken,
} from '../../src/server/pairing-offers.js';

describe('pairing offers', () => {
  let tempHome = '';
  const originalHome = process.env['HOME'];
  const originalViewportHome = process.env['VIEWPORT_HOME'];
  const originalAuditMaxBytes = process.env['VIEWPORT_PAIRING_AUDIT_MAX_BYTES'];
  const originalPeerBindingsMax = process.env['VIEWPORT_PAIRING_PEER_BINDINGS_MAX'];

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-pairing-test-'));
    process.env['HOME'] = tempHome;
    process.env['VIEWPORT_HOME'] = path.join(tempHome, '.viewport');
    await rotateAuthToken();
  });

  afterEach(async () => {
    if (originalHome) process.env['HOME'] = originalHome;
    else delete process.env['HOME'];
    if (originalViewportHome) process.env['VIEWPORT_HOME'] = originalViewportHome;
    else delete process.env['VIEWPORT_HOME'];
    if (originalAuditMaxBytes) {
      process.env['VIEWPORT_PAIRING_AUDIT_MAX_BYTES'] = originalAuditMaxBytes;
    } else {
      delete process.env['VIEWPORT_PAIRING_AUDIT_MAX_BYTES'];
    }
    if (originalPeerBindingsMax) {
      process.env['VIEWPORT_PAIRING_PEER_BINDINGS_MAX'] = originalPeerBindingsMax;
    } else {
      delete process.env['VIEWPORT_PAIRING_PEER_BINDINGS_MAX'];
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('issues, lists, redeems, and invalidates a pairing offer', async () => {
    const offer = await issuePairingOffer({
      connection: {
        host: '127.0.0.1',
        port: 7070,
        listen: '127.0.0.1:7070',
        profile: 'local',
      },
      ttlSeconds: 300,
    });

    const listed = await listPairingOffers();
    expect(listed.some((item) => item.offerId === offer.offerId && item.active)).toBe(true);
    expect(offer.redeemSecret).toBeTruthy();
    expect(offer.trustAnchor).toBeTruthy();
    expect(offer.daemonDeviceId).toBeTruthy();
    expect(offer.daemonPublicKey).toContain('BEGIN PUBLIC KEY');

    const identity = createPairingClientIdentity();
    const redeemProof = createPairingRedeemProof({
      offerId: offer.offerId,
      redeemSecret: offer.redeemSecret,
      trustAnchor: offer.trustAnchor,
      clientIdentity: identity,
    });

    const firstRedeem = await redeemPairingOffer(
      offer.offerId,
      offer.redeemSecret,
      offer.trustAnchor,
      redeemProof.clientPublicKey,
      redeemProof.clientProof,
    );
    expect(firstRedeem?.offerId).toBe(offer.offerId);
    expect((firstRedeem as Record<string, unknown>)['token']).toBeUndefined();
    expect(firstRedeem?.trustAnchor).toBe(offer.trustAnchor);
    expect(firstRedeem?.daemonDeviceId).toBe(offer.daemonDeviceId);
    expect(firstRedeem?.daemonPublicKey).toBe(offer.daemonPublicKey);
    expect(firstRedeem?.peerId).toBe(identity.peerId);
    expect(firstRedeem?.serverSignature).toBeTruthy();

    const peersPath = path.join(process.env['VIEWPORT_HOME'] ?? '', 'pairing-peers.json');
    const peersRaw = await fs.readFile(peersPath, 'utf8');
    const peersParsed = JSON.parse(peersRaw) as { peers?: Array<Record<string, unknown>> };
    const peer = peersParsed.peers?.[0] ?? {};
    expect(peer['relayPairingSecret']).toBeUndefined();
    expect(typeof peer['relayPairingSecretCiphertext']).toBe('string');
    expect(typeof peer['relayPairingSecretIv']).toBe('string');
    expect(typeof peer['relayPairingSecretTag']).toBe('string');
    expect((firstRedeem as Record<string, unknown>)['relayPairingSecret']).toBeUndefined();
    const resolvedPeerSecret = await resolveRelayPairingSecret(identity.peerId);
    expect(resolvedPeerSecret).not.toBeNull();
    expect(resolvedPeerSecret?.length).toBe(32);

    const secondRedeem = await redeemPairingOffer(
      offer.offerId,
      offer.redeemSecret,
      offer.trustAnchor,
      redeemProof.clientPublicKey,
      redeemProof.clientProof,
    );
    expect(secondRedeem).toBeNull();
  });

  it('revokes an offer and prevents redemption', async () => {
    const offer = await issuePairingOffer({
      connection: {
        host: '127.0.0.1',
        port: 7070,
        listen: '127.0.0.1:7070',
        profile: 'local',
      },
      ttlSeconds: 300,
    });

    const revoked = await revokePairingOffer(offer.offerId);
    expect(revoked).toBe(true);

    const identity = createPairingClientIdentity();
    const redeemProof = createPairingRedeemProof({
      offerId: offer.offerId,
      redeemSecret: offer.redeemSecret,
      trustAnchor: offer.trustAnchor,
      clientIdentity: identity,
    });
    const redeemed = await redeemPairingOffer(
      offer.offerId,
      offer.redeemSecret,
      offer.trustAnchor,
      redeemProof.clientPublicKey,
      redeemProof.clientProof,
    );
    expect(redeemed).toBeNull();
  });

  it('locks a pairing offer after repeated invalid proof attempts', async () => {
    const offer = await issuePairingOffer({
      connection: {
        host: '127.0.0.1',
        port: 7070,
        listen: '127.0.0.1:7070',
        profile: 'local',
      },
      ttlSeconds: 300,
    });

    const identity = createPairingClientIdentity();

    for (let i = 0; i < 5; i += 1) {
      const wrongProof = createPairingRedeemProof({
        offerId: offer.offerId,
        redeemSecret: 'wrong-proof',
        trustAnchor: offer.trustAnchor,
        clientIdentity: identity,
      });
      const failed = await redeemPairingOffer(
        offer.offerId,
        'wrong-proof',
        offer.trustAnchor,
        wrongProof.clientPublicKey,
        wrongProof.clientProof,
      );
      expect(failed).toBeNull();
    }

    const redeemProof = createPairingRedeemProof({
      offerId: offer.offerId,
      redeemSecret: offer.redeemSecret,
      trustAnchor: offer.trustAnchor,
      clientIdentity: identity,
    });
    const lockedRedeem = await redeemPairingOffer(
      offer.offerId,
      offer.redeemSecret,
      offer.trustAnchor,
      redeemProof.clientPublicKey,
      redeemProof.clientProof,
    );
    expect(lockedRedeem).toBeNull();
  });

  it('rejects redemption when trust anchor does not match', async () => {
    const offer = await issuePairingOffer({
      connection: {
        host: '127.0.0.1',
        port: 7070,
        listen: '127.0.0.1:7070',
        profile: 'local',
      },
      ttlSeconds: 300,
    });

    const identity = createPairingClientIdentity();
    const redeemProof = createPairingRedeemProof({
      offerId: offer.offerId,
      redeemSecret: offer.redeemSecret,
      trustAnchor: offer.trustAnchor,
      clientIdentity: identity,
    });
    const redeemed = await redeemPairingOffer(
      offer.offerId,
      offer.redeemSecret,
      'dead:beef',
      redeemProof.clientPublicKey,
      redeemProof.clientProof,
    );
    expect(redeemed).toBeNull();
  });

  it('auto-creates auth token when issuing offer without existing token file', async () => {
    const tokenPath = path.join(process.env['VIEWPORT_HOME'] ?? '', 'auth-token');
    await fs.rm(tokenPath, { force: true });

    const offer = await issuePairingOffer({
      connection: {
        host: '127.0.0.1',
        port: 7070,
        listen: '127.0.0.1:7070',
        profile: 'local',
      },
      ttlSeconds: 300,
    });
    expect(offer.offerId).toBeTruthy();

    const tokenContents = await fs.readFile(tokenPath, 'utf8');
    expect(tokenContents.trim().length).toBeGreaterThan(10);
  });

  it('does not persist daemon auth token inside pairing offer records', async () => {
    await issuePairingOffer({
      connection: {
        host: '127.0.0.1',
        port: 7070,
        listen: '127.0.0.1:7070',
        profile: 'local',
      },
      ttlSeconds: 300,
    });

    const storePath = path.join(process.env['VIEWPORT_HOME'] ?? '', 'pairing-offers.json');
    const storeRaw = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(storeRaw) as { offers?: Array<Record<string, unknown>> };
    const first = parsed.offers?.[0] ?? {};
    expect(first['token']).toBeUndefined();
  });

  it('writes sensitive pairing files with restrictive permissions', async () => {
    const offer = await issuePairingOffer({
      connection: {
        host: '127.0.0.1',
        port: 7070,
        listen: '127.0.0.1:7070',
        profile: 'local',
      },
      ttlSeconds: 300,
    });

    const identity = createPairingClientIdentity();
    const redeemProof = createPairingRedeemProof({
      offerId: offer.offerId,
      redeemSecret: offer.redeemSecret,
      trustAnchor: offer.trustAnchor,
      clientIdentity: identity,
    });
    await redeemPairingOffer(
      offer.offerId,
      offer.redeemSecret,
      offer.trustAnchor,
      redeemProof.clientPublicKey,
      redeemProof.clientProof,
    );

    const viewportDir = process.env['VIEWPORT_HOME'] ?? '';
    const sensitiveFiles = [
      'pairing-offers.json',
      'pairing-audit.jsonl',
      'auth-token',
      'pairing-trust-anchor.json',
      'pairing-device-identity.json',
      'pairing-peers.json',
    ];
    for (const file of sensitiveFiles) {
      const stat = await fs.stat(path.join(viewportDir, file));
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('rotates pairing audit log when max size is exceeded', async () => {
    process.env['VIEWPORT_PAIRING_AUDIT_MAX_BYTES'] = '256';

    for (let i = 0; i < 20; i += 1) {
      await issuePairingOffer({
        connection: {
          host: '127.0.0.1',
          port: 7070,
          listen: `127.0.0.1:7070#${i}`,
          profile: 'local',
        },
        ttlSeconds: 300,
      });
    }

    const viewportDir = process.env['VIEWPORT_HOME'] ?? '';
    const currentAudit = path.join(viewportDir, 'pairing-audit.jsonl');
    const rotatedAudit = path.join(viewportDir, 'pairing-audit.jsonl.1');
    const currentStat = await fs.stat(currentAudit);
    const rotatedStat = await fs.stat(rotatedAudit);
    expect(currentStat.size).toBeGreaterThan(0);
    expect(rotatedStat.size).toBeGreaterThan(0);
  });

  it('caps stored peer bindings and evicts oldest records', async () => {
    process.env['VIEWPORT_PAIRING_PEER_BINDINGS_MAX'] = '3';

    const pairedPeerIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const offer = await issuePairingOffer({
        connection: {
          host: '127.0.0.1',
          port: 7070,
          listen: `127.0.0.1:7070#peer-${i}`,
          profile: 'local',
        },
        ttlSeconds: 300,
      });
      const identity = createPairingClientIdentity();
      const redeemProof = createPairingRedeemProof({
        offerId: offer.offerId,
        redeemSecret: offer.redeemSecret,
        trustAnchor: offer.trustAnchor,
        clientIdentity: identity,
      });
      const redeemed = await redeemPairingOffer(
        offer.offerId,
        offer.redeemSecret,
        offer.trustAnchor,
        redeemProof.clientPublicKey,
        redeemProof.clientProof,
      );
      expect(redeemed).not.toBeNull();
      pairedPeerIds.push(identity.peerId);
    }

    const peersPath = path.join(process.env['VIEWPORT_HOME'] ?? '', 'pairing-peers.json');
    const peersRaw = JSON.parse(await fs.readFile(peersPath, 'utf8')) as {
      peers?: Array<{ peerId?: string }>;
    };
    const storedPeerIds = (peersRaw.peers ?? [])
      .map((peer) => peer.peerId)
      .filter((peerId): peerId is string => typeof peerId === 'string');
    expect(storedPeerIds.length).toBe(3);
    expect(storedPeerIds).toEqual(pairedPeerIds.slice(-3));
  });

  it('auto-migrates legacy plaintext relay pairing secret to encrypted fields on read', async () => {
    const legacySecretBytes = Buffer.alloc(32, 7);
    const legacySecret = legacySecretBytes.toString('base64url');
    const peersPath = path.join(process.env['VIEWPORT_HOME'] ?? '', 'pairing-peers.json');
    const legacyStore = {
      version: 1,
      peers: [
        {
          peerId: 'peer_legacy',
          publicKey: 'legacy_public_key',
          relayPairingSecret: legacySecret,
          firstPairedAt: Date.now(),
          lastPairedAt: Date.now(),
          lastOfferId: 'offer_legacy',
          trustAnchor: 'trust_anchor_legacy',
        },
      ],
    };
    await fs.writeFile(peersPath, JSON.stringify(legacyStore, null, 2), { mode: 0o600 });

    const resolved = await resolveRelayPairingSecret('peer_legacy');
    expect(resolved?.toString('base64url')).toBe(legacySecret);

    const migrated = JSON.parse(await fs.readFile(peersPath, 'utf8')) as {
      peers?: Array<Record<string, unknown>>;
    };
    const peer = migrated.peers?.[0] ?? {};
    expect(peer['relayPairingSecret']).toBeUndefined();
    expect(typeof peer['relayPairingSecretCiphertext']).toBe('string');
    expect(typeof peer['relayPairingSecretIv']).toBe('string');
    expect(typeof peer['relayPairingSecretTag']).toBe('string');
  });
});
