import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { configDir } from '../core/config.js';
import { logger } from '../core/logger.js';
import { appendPairingAudit, authTokenPath, pairingStorePath } from './pairing-file-store.js';
import {
  getOrCreateDaemonIdentity,
  getOrCreateTrustAnchor,
  readDaemonIdentity,
} from './pairing-identity-store.js';
import {
  deriveRelayPairingSecret,
  hashPairingSecret,
  peerIdFromPublicKey,
  upsertPeerBinding,
} from './pairing-peer-bindings.js';
import type {
  PairingClientIdentity,
  PairingOfferConnection,
  PairingOfferIssuedPayload,
  PairingOfferPublicPayload,
  PairingOfferRedeemedPayload,
  PairingOfferStore,
  PairingOfferStoreRecord,
  PairingRedeemProof,
} from './pairing-offer-types.js';

const log = logger.child({ module: 'pairing-offers' });

export type {
  PairingClientIdentity,
  PairingDaemonIdentityPublic,
  PairingOfferConnection,
  PairingOfferIssuedPayload,
  PairingOfferPublicPayload,
  PairingOfferRedeemedPayload,
  PairingRedeemProof,
  PairingTrustAnchorPublic,
} from './pairing-offer-types.js';

export { getOrCreateDaemonIdentity, getOrCreateTrustAnchor } from './pairing-identity-store.js';

const MAX_STORED_OFFERS = 200;
const MAX_FAILED_REDEEM_ATTEMPTS = 5;
let storeMutationLock: Promise<unknown> = Promise.resolve();

function withStoreMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = storeMutationLock.then(operation, operation);
  storeMutationLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readStore(): Promise<PairingOfferStore> {
  try {
    const raw = await fs.readFile(pairingStorePath(), 'utf-8');
    const parsed = JSON.parse(raw) as PairingOfferStore;
    if (!Array.isArray(parsed.offers)) {
      return { version: 1, offers: [] };
    }
    return {
      version: 1,
      offers: parsed.offers.filter((item) => item && typeof item.offerId === 'string'),
    };
  } catch {
    return { version: 1, offers: [] };
  }
}

async function writeStore(store: PairingOfferStore): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  const compacted = compactOffers(store.offers);
  const sanitized = compacted.map((offer) => {
    const { token: _legacyToken, ...rest } = offer as PairingOfferStoreRecord & {
      token?: string;
    };
    return rest;
  });
  await fs.writeFile(
    pairingStorePath(),
    JSON.stringify({ version: 1, offers: sanitized }, null, 2) + '\n',
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  );
}

function compactOffers(offers: PairingOfferStoreRecord[]): PairingOfferStoreRecord[] {
  const now = Date.now();
  const fresh = offers.filter((offer) => {
    if (!offer.expiresAt || offer.expiresAt <= now - 24 * 60 * 60 * 1000) {
      return false;
    }
    return true;
  });
  if (fresh.length <= MAX_STORED_OFFERS) return fresh;
  return fresh.slice(fresh.length - MAX_STORED_OFFERS);
}

function canonicalRedeemPayload(input: {
  offerId: string;
  redeemSecret: string;
  trustAnchor: string;
  clientPublicKey: string;
}): string {
  return [
    'viewport-pair-redeem-v1',
    input.offerId,
    input.redeemSecret,
    input.trustAnchor,
    input.clientPublicKey,
  ].join('\n');
}

export { resolveRelayPairingSecret } from './pairing-peer-bindings.js';

export function createPairingClientIdentity(): PairingClientIdentity {
  const keypair = crypto.generateKeyPairSync('ed25519');
  const publicKey = keypair.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
  const privateKey = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
  return {
    peerId: peerIdFromPublicKey(publicKey),
    publicKey,
    privateKey,
  };
}

export function createPairingRedeemProof(input: {
  offerId: string;
  redeemSecret: string;
  trustAnchor: string;
  clientIdentity: PairingClientIdentity;
}): PairingRedeemProof {
  const normalizedClientPublicKey = input.clientIdentity.publicKey.trim();
  const normalizedClientPrivateKey = input.clientIdentity.privateKey.trim();
  const payload = canonicalRedeemPayload({
    offerId: input.offerId,
    redeemSecret: input.redeemSecret,
    trustAnchor: input.trustAnchor,
    clientPublicKey: normalizedClientPublicKey,
  });
  const signature = crypto.sign(
    null,
    Buffer.from(payload, 'utf-8'),
    crypto.createPrivateKey(normalizedClientPrivateKey),
  );
  return {
    peerId: peerIdFromPublicKey(normalizedClientPublicKey),
    clientPublicKey: normalizedClientPublicKey,
    clientProof: signature.toString('base64url'),
  };
}

export async function readAuthToken(): Promise<string | null> {
  try {
    const token = (await fs.readFile(authTokenPath(), 'utf-8')).trim();
    return token || null;
  } catch {
    return null;
  }
}

export async function rotateAuthToken(): Promise<{ token: string; previousTokenExisted: boolean }> {
  const previous = await readAuthToken();
  const token = crypto.randomBytes(32).toString('hex');
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(authTokenPath(), `${token}\n`, { mode: 0o600 });
  await appendPairingAudit({ event: 'auth_token_rotated' });
  return { token, previousTokenExisted: previous !== null };
}

export async function issuePairingOffer(input: {
  connection: PairingOfferConnection;
  ttlSeconds: number;
}): Promise<PairingOfferIssuedPayload> {
  return await withStoreMutationLock(async () => {
    const ttlSeconds = Math.min(3600, Math.max(30, Math.floor(input.ttlSeconds)));
    const createdAt = Date.now();
    const expiresAt = createdAt + ttlSeconds * 1000;
    const offerId = crypto.randomUUID();
    const redeemSecret = crypto.randomBytes(16).toString('hex');
    const existingToken = await readAuthToken();
    if (!existingToken) {
      await rotateAuthToken();
    }
    const trustAnchor = await getOrCreateTrustAnchor();
    const daemonIdentity = await getOrCreateDaemonIdentity();

    const store = await readStore();
    store.offers.push({
      offerId,
      createdAt,
      expiresAt,
      redeemSecretHash: await hashPairingSecret(redeemSecret),
      trustAnchor: trustAnchor.fingerprint,
      daemonDeviceId: daemonIdentity.deviceId,
      daemonPublicKey: daemonIdentity.publicKey,
      connection: input.connection,
    });
    await writeStore(store);
    await appendPairingAudit({
      event: 'pair_offer_issued',
      offerId,
      createdAt,
      expiresAt,
      profile: input.connection.profile,
      listen: input.connection.listen,
      trustAnchor: trustAnchor.fingerprint,
      daemonDeviceId: daemonIdentity.deviceId,
    });

    return {
      offerId,
      createdAt,
      expiresAt,
      redeemSecret,
      trustAnchor: trustAnchor.fingerprint,
      daemonDeviceId: daemonIdentity.deviceId,
      daemonPublicKey: daemonIdentity.publicKey,
      ...input.connection,
    };
  });
}

export async function listPairingOffers(): Promise<
  Array<
    PairingOfferPublicPayload & {
      revokedAt?: number;
      redeemedAt?: number;
      active: boolean;
      expired: boolean;
    }
  >
> {
  return await withStoreMutationLock(async () => {
    const store = await readStore();
    const now = Date.now();
    return store.offers
      .map((offer) => {
        const expired = offer.expiresAt <= now;
        const active = !expired && !offer.revokedAt && !offer.redeemedAt;
        return {
          offerId: offer.offerId,
          createdAt: offer.createdAt,
          expiresAt: offer.expiresAt,
          trustAnchor: offer.trustAnchor,
          daemonDeviceId: offer.daemonDeviceId,
          host: offer.connection.host,
          port: offer.connection.port,
          listen: offer.connection.listen,
          socketPath: offer.connection.socketPath,
          profile: offer.connection.profile,
          revokedAt: offer.revokedAt,
          redeemedAt: offer.redeemedAt,
          active,
          expired,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  });
}

export async function revokePairingOffer(offerId: string): Promise<boolean> {
  return await withStoreMutationLock(async () => {
    const store = await readStore();
    const offer = store.offers.find((item) => item.offerId === offerId);
    if (!offer) return false;
    if (!offer.revokedAt) {
      offer.revokedAt = Date.now();
      await writeStore(store);
      await appendPairingAudit({ event: 'pair_offer_revoked', offerId: offer.offerId });
    }
    return true;
  });
}

export async function redeemPairingOffer(
  offerId: string,
  redeemSecret: string,
  expectedTrustAnchor?: string,
  clientPublicKey?: string,
  clientProof?: string,
): Promise<PairingOfferRedeemedPayload | null> {
  return await withStoreMutationLock(async () => {
    if (!redeemSecret || redeemSecret.trim().length === 0) {
      return null;
    }

    const store = await readStore();
    const offer = store.offers.find((item) => item.offerId === offerId);
    if (!offer) return null;

    const now = Date.now();
    const expired = offer.expiresAt <= now;
    if (expired || offer.revokedAt || offer.redeemedAt || offer.lockedAt) {
      return null;
    }
    if (!clientPublicKey || !clientProof) {
      await appendPairingAudit({
        event: 'pair_offer_redeem_failed',
        offerId: offer.offerId,
        reason: 'missing_client_identity_proof',
      });
      return null;
    }
    if (expectedTrustAnchor && offer.trustAnchor !== expectedTrustAnchor) {
      await appendPairingAudit({
        event: 'pair_offer_redeem_failed',
        offerId: offer.offerId,
        reason: 'trust_anchor_mismatch',
        expectedTrustAnchor,
        offeredTrustAnchor: offer.trustAnchor,
      });
      return null;
    }
    try {
      const payload = canonicalRedeemPayload({
        offerId: offer.offerId,
        redeemSecret,
        trustAnchor: offer.trustAnchor,
        clientPublicKey,
      });
      const verified = crypto.verify(
        null,
        Buffer.from(payload, 'utf-8'),
        crypto.createPublicKey(clientPublicKey),
        Buffer.from(clientProof, 'base64url'),
      );
      if (!verified) {
        await appendPairingAudit({
          event: 'pair_offer_redeem_failed',
          offerId: offer.offerId,
          reason: 'client_proof_invalid',
        });
        return null;
      }
    } catch {
      await appendPairingAudit({
        event: 'pair_offer_redeem_failed',
        offerId: offer.offerId,
        reason: 'client_proof_invalid',
      });
      return null;
    }
    if (typeof offer.redeemSecretHash !== 'string' || offer.redeemSecretHash.length === 0) {
      offer.lockedAt = now;
      await writeStore(store);
      await appendPairingAudit({
        event: 'pair_offer_redeem_failed',
        offerId: offer.offerId,
        reason: 'missing_redeem_secret_hash',
      });
      return null;
    }

    const proofValid = secureSecretCompare(
      offer.redeemSecretHash,
      await hashPairingSecret(redeemSecret),
    );
    if (!proofValid) {
      offer.failedRedeemAttempts = (offer.failedRedeemAttempts ?? 0) + 1;
      if (offer.failedRedeemAttempts >= MAX_FAILED_REDEEM_ATTEMPTS) {
        offer.lockedAt = now;
      }
      await writeStore(store);
      await appendPairingAudit({
        event: 'pair_offer_redeem_failed',
        offerId: offer.offerId,
        attempts: offer.failedRedeemAttempts,
        locked: !!offer.lockedAt,
      });
      return null;
    }

    offer.redeemedAt = now;
    await writeStore(store);
    const peerId = peerIdFromPublicKey(clientPublicKey);
    const relayPairingSecret = deriveRelayPairingSecret({
      offerId: offer.offerId,
      redeemSecret,
      trustAnchor: offer.trustAnchor,
      clientPublicKey,
      daemonPublicKey: offer.daemonPublicKey,
    });
    await upsertPeerBinding({
      peerId,
      publicKey: clientPublicKey,
      relayPairingSecret,
      offerId: offer.offerId,
      trustAnchor: offer.trustAnchor,
    });
    log.debug(
      {
        peerId,
        offerId: offer.offerId,
        viewportHome: configDir(),
      },
      'Stored relay pairing peer binding',
    );

    const daemonIdentity = await readDaemonIdentity();
    const daemonPrivateKey = daemonIdentity
      ? crypto.createPrivateKey(daemonIdentity.privateKey)
      : undefined;
    const redeemEnvelope = [
      'viewport-pair-redeem-response-v1',
      offer.offerId,
      peerId,
      offer.trustAnchor,
      String(offer.expiresAt),
    ].join('\n');
    const serverSignature = daemonPrivateKey
      ? crypto
          .sign(null, Buffer.from(redeemEnvelope, 'utf-8'), daemonPrivateKey)
          .toString('base64url')
      : '';

    await appendPairingAudit({
      event: 'pair_offer_redeemed',
      offerId: offer.offerId,
      peerId,
      daemonDeviceId: offer.daemonDeviceId,
    });

    return {
      offerId: offer.offerId,
      trustAnchor: offer.trustAnchor,
      daemonDeviceId: offer.daemonDeviceId,
      daemonPublicKey: offer.daemonPublicKey,
      peerId,
      relayPairingPeerId: peerId,
      serverSignature,
      connection: offer.connection,
      expiresAt: offer.expiresAt,
      createdAt: offer.createdAt,
    };
  });
}

function secureSecretCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf-8');
  const right = Buffer.from(b, 'utf-8');
  const compareLength = Math.max(left.length, right.length, 1);
  const paddedLeft = Buffer.alloc(compareLength);
  const paddedRight = Buffer.alloc(compareLength);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  const equal = crypto.timingSafeEqual(paddedLeft, paddedRight);
  return equal && left.length === right.length;
}
