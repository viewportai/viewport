import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../core/config.js';
import { logger } from '../core/logger.js';
import type {
  PairingClientIdentity,
  PairingDaemonIdentityPublic,
  PairingDaemonIdentityRecord,
  PairingOfferConnection,
  PairingOfferIssuedPayload,
  PairingOfferPublicPayload,
  PairingOfferRedeemedPayload,
  PairingOfferStore,
  PairingOfferStoreRecord,
  PairingPeerBindingRecord,
  PairingPeerBindingStore,
  PairingRedeemProof,
  PairingTrustAnchorPublic,
  PairingTrustAnchorRecord,
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

const MAX_STORED_OFFERS = 200;
const MAX_FAILED_REDEEM_ATTEMPTS = 5;
const DEFAULT_MAX_PEER_BINDINGS = 2048;
const RELAY_PAIRING_INFO_PREFIX = 'viewport-relay-policyc-pair-v1';
const DEFAULT_PAIRING_AUDIT_MAX_BYTES = 1_048_576;
const PAIRING_SECRET_STORE_KEY_BYTES = 32;
let storeMutationLock: Promise<unknown> = Promise.resolve();
let auditMutationLock: Promise<unknown> = Promise.resolve();
let cachedSecretStoreKey: Buffer | null = null;
let cachedSecretStoreKeyPath: string | null = null;

function withStoreMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = storeMutationLock.then(operation, operation);
  storeMutationLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function withAuditMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = auditMutationLock.then(operation, operation);
  auditMutationLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function pairingAuditMaxBytes(): number {
  return parsePositiveInt(
    process.env['VIEWPORT_PAIRING_AUDIT_MAX_BYTES'],
    DEFAULT_PAIRING_AUDIT_MAX_BYTES,
  );
}

function pairingPeerBindingsMax(): number {
  return parsePositiveInt(
    process.env['VIEWPORT_PAIRING_PEER_BINDINGS_MAX'],
    DEFAULT_MAX_PEER_BINDINGS,
  );
}

function pairingStorePath(): string {
  return path.join(configDir(), 'pairing-offers.json');
}

function pairingAuditPath(): string {
  return path.join(configDir(), 'pairing-audit.jsonl');
}

function authTokenPath(): string {
  return path.join(configDir(), 'auth-token');
}

function trustAnchorPath(): string {
  return path.join(configDir(), 'pairing-trust-anchor.json');
}

function daemonIdentityPath(): string {
  return path.join(configDir(), 'pairing-device-identity.json');
}

function peerBindingPath(): string {
  return path.join(configDir(), 'pairing-peers.json');
}

function pairingSecretStoreKeyPath(): string {
  return path.join(configDir(), 'pairing-secret-store.key');
}

async function getOrCreateSecretStoreKey(): Promise<Buffer> {
  const keyPath = pairingSecretStoreKeyPath();
  if (
    cachedSecretStoreKey &&
    cachedSecretStoreKey.length === PAIRING_SECRET_STORE_KEY_BYTES &&
    cachedSecretStoreKeyPath === keyPath
  ) {
    return cachedSecretStoreKey;
  }
  try {
    const existing = (await fs.readFile(keyPath, 'utf-8')).trim();
    const decoded = Buffer.from(existing, 'base64url');
    if (decoded.length === PAIRING_SECRET_STORE_KEY_BYTES) {
      cachedSecretStoreKey = decoded;
      cachedSecretStoreKeyPath = keyPath;
      return decoded;
    }
  } catch {
    // fall through to create
  }

  const created = crypto.randomBytes(PAIRING_SECRET_STORE_KEY_BYTES);
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(keyPath, created.toString('base64url') + '\n', {
    mode: 0o600,
  });
  cachedSecretStoreKey = created;
  cachedSecretStoreKeyPath = keyPath;
  return created;
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

async function appendAudit(event: Record<string, unknown>): Promise<void> {
  return await withAuditMutationLock(async () => {
    await fs.mkdir(configDir(), { recursive: true });
    const auditPath = pairingAuditPath();
    const maxBytes = pairingAuditMaxBytes();
    try {
      const stat = await fs.stat(auditPath);
      if (stat.size >= maxBytes) {
        const rotated = `${auditPath}.1`;
        await fs.rm(rotated, { force: true });
        await fs.rename(auditPath, rotated);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const line = JSON.stringify({ timestamp: Date.now(), ...event });
    await fs.appendFile(auditPath, `${line}\n`, { encoding: 'utf-8', mode: 0o600 });
  });
}

function trustAnchorFingerprint(secret: string): string {
  const digest = crypto.createHash('sha256').update(secret).digest('hex');
  return digest.match(/.{1,4}/g)?.join(':') ?? digest;
}

function keyFingerprint(publicKey: string): string {
  const digest = crypto.createHash('sha256').update(publicKey).digest('hex');
  return digest.match(/.{1,4}/g)?.join(':') ?? digest;
}

async function readTrustAnchorRecord(): Promise<PairingTrustAnchorRecord | null> {
  try {
    const raw = await fs.readFile(trustAnchorPath(), 'utf-8');
    const parsed = JSON.parse(raw) as PairingTrustAnchorRecord;
    if (
      parsed &&
      parsed.version === 1 &&
      typeof parsed.id === 'string' &&
      typeof parsed.createdAt === 'number' &&
      typeof parsed.secret === 'string' &&
      parsed.secret.length > 0
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeTrustAnchorRecord(record: PairingTrustAnchorRecord): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(trustAnchorPath(), JSON.stringify(record, null, 2) + '\n', {
    mode: 0o600,
  });
}

export async function getOrCreateTrustAnchor(): Promise<PairingTrustAnchorPublic> {
  const existing = await readTrustAnchorRecord();
  if (existing) {
    return {
      id: existing.id,
      createdAt: existing.createdAt,
      fingerprint: trustAnchorFingerprint(existing.secret),
    };
  }
  const created: PairingTrustAnchorRecord = {
    version: 1,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    secret: crypto.randomBytes(32).toString('hex'),
  };
  await writeTrustAnchorRecord(created);
  await appendAudit({
    event: 'pair_trust_anchor_created',
    trustAnchorId: created.id,
    trustAnchor: trustAnchorFingerprint(created.secret),
  });
  return {
    id: created.id,
    createdAt: created.createdAt,
    fingerprint: trustAnchorFingerprint(created.secret),
  };
}

async function readDaemonIdentity(): Promise<PairingDaemonIdentityRecord | null> {
  try {
    const raw = await fs.readFile(daemonIdentityPath(), 'utf-8');
    const parsed = JSON.parse(raw) as PairingDaemonIdentityRecord;
    if (
      parsed &&
      parsed.version === 1 &&
      typeof parsed.deviceId === 'string' &&
      typeof parsed.createdAt === 'number' &&
      typeof parsed.publicKey === 'string' &&
      typeof parsed.privateKey === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeDaemonIdentity(identity: PairingDaemonIdentityRecord): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(daemonIdentityPath(), JSON.stringify(identity, null, 2) + '\n', {
    mode: 0o600,
  });
}

export async function getOrCreateDaemonIdentity(): Promise<PairingDaemonIdentityPublic> {
  const existing = await readDaemonIdentity();
  if (existing) {
    return {
      deviceId: existing.deviceId,
      createdAt: existing.createdAt,
      fingerprint: keyFingerprint(existing.publicKey),
      publicKey: existing.publicKey,
    };
  }
  const keypair = crypto.generateKeyPairSync('ed25519');
  const publicKey = keypair.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
  const privateKey = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
  const created: PairingDaemonIdentityRecord = {
    version: 1,
    deviceId: crypto.randomUUID(),
    createdAt: Date.now(),
    publicKey,
    privateKey,
  };
  await writeDaemonIdentity(created);
  await appendAudit({
    event: 'pair_device_identity_created',
    deviceId: created.deviceId,
    fingerprint: keyFingerprint(created.publicKey),
  });
  return {
    deviceId: created.deviceId,
    createdAt: created.createdAt,
    fingerprint: keyFingerprint(created.publicKey),
    publicKey: created.publicKey,
  };
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

function peerIdFromPublicKey(publicKey: string): string {
  return crypto.createHash('sha256').update(publicKey).digest('hex');
}

async function readPeerBindings(): Promise<PairingPeerBindingStore> {
  try {
    const raw = await fs.readFile(peerBindingPath(), 'utf-8');
    const parsed = JSON.parse(raw) as PairingPeerBindingStore;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.peers)) {
      return { version: 1, peers: [] };
    }
    return { version: 1, peers: compactPeerBindings(parsed.peers) };
  } catch {
    return { version: 1, peers: [] };
  }
}

async function writePeerBindings(store: PairingPeerBindingStore): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  const compacted: PairingPeerBindingStore = {
    version: 1,
    peers: compactPeerBindings(store.peers),
  };
  await fs.writeFile(peerBindingPath(), JSON.stringify(compacted, null, 2) + '\n', {
    mode: 0o600,
  });
}

async function upsertPeerBinding(input: {
  peerId: string;
  publicKey: string;
  relayPairingSecret: string;
  offerId: string;
  trustAnchor: string;
}): Promise<void> {
  const store = await readPeerBindings();
  const now = Date.now();
  const encryptedSecret = await encryptRelayPairingSecret(input.relayPairingSecret);
  const existing = store.peers.find((peer) => peer.peerId === input.peerId);
  if (existing) {
    existing.publicKey = input.publicKey;
    existing.relayPairingSecretCiphertext = encryptedSecret.ciphertext;
    existing.relayPairingSecretIv = encryptedSecret.iv;
    existing.relayPairingSecretTag = encryptedSecret.tag;
    existing.lastPairedAt = now;
    existing.lastOfferId = input.offerId;
    existing.trustAnchor = input.trustAnchor;
  } else {
    store.peers.push({
      peerId: input.peerId,
      publicKey: input.publicKey,
      relayPairingSecretCiphertext: encryptedSecret.ciphertext,
      relayPairingSecretIv: encryptedSecret.iv,
      relayPairingSecretTag: encryptedSecret.tag,
      firstPairedAt: now,
      lastPairedAt: now,
      lastOfferId: input.offerId,
      trustAnchor: input.trustAnchor,
    });
  }
  await writePeerBindings(store);
}

function compactPeerBindings(peers: PairingPeerBindingRecord[]): PairingPeerBindingRecord[] {
  const deduped = new Map<string, PairingPeerBindingRecord>();
  for (const item of peers) {
    if (
      !item ||
      typeof item.peerId !== 'string' ||
      item.peerId.trim().length === 0 ||
      typeof item.publicKey !== 'string' ||
      item.publicKey.trim().length === 0 ||
      typeof item.firstPairedAt !== 'number'
    ) {
      continue;
    }
    const existing = deduped.get(item.peerId);
    if (!existing || (item.lastPairedAt ?? 0) >= (existing.lastPairedAt ?? 0)) {
      deduped.set(item.peerId, {
        ...item,
        peerId: item.peerId.trim(),
        publicKey: item.publicKey.trim(),
      });
    }
  }
  const sorted = Array.from(deduped.values()).sort(
    (a, b) => (a.lastPairedAt ?? a.firstPairedAt) - (b.lastPairedAt ?? b.firstPairedAt),
  );
  const maxEntries = pairingPeerBindingsMax();
  if (sorted.length <= maxEntries) return sorted;
  return sorted.slice(sorted.length - maxEntries);
}

function deriveRelayPairingSecret(input: {
  offerId: string;
  redeemSecret: string;
  trustAnchor: string;
  clientPublicKey: string;
  daemonPublicKey: string;
}): string {
  const salt = crypto
    .createHash('sha256')
    .update(
      [
        RELAY_PAIRING_INFO_PREFIX,
        input.offerId,
        input.trustAnchor,
        input.clientPublicKey.trim(),
        input.daemonPublicKey.trim(),
      ].join('\n'),
      'utf8',
    )
    .digest();
  const ikm = Buffer.from(input.redeemSecret, 'utf8');
  const derived = crypto.hkdfSync(
    'sha256',
    ikm,
    salt,
    Buffer.from(RELAY_PAIRING_INFO_PREFIX, 'utf8'),
    32,
  );
  const bytes = Buffer.isBuffer(derived) ? derived : Buffer.from(derived);
  return bytes.toString('base64url');
}

async function encryptRelayPairingSecret(secret: string): Promise<{
  ciphertext: string;
  iv: string;
  tag: string;
}> {
  const key = await getOrCreateSecretStoreKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
  };
}

async function decryptRelayPairingSecret(
  encrypted: Pick<
    PairingPeerBindingRecord,
    'relayPairingSecretCiphertext' | 'relayPairingSecretIv' | 'relayPairingSecretTag'
  >,
): Promise<Buffer | null> {
  if (
    typeof encrypted.relayPairingSecretCiphertext !== 'string' ||
    typeof encrypted.relayPairingSecretIv !== 'string' ||
    typeof encrypted.relayPairingSecretTag !== 'string'
  ) {
    return null;
  }
  try {
    const key = await getOrCreateSecretStoreKey();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(encrypted.relayPairingSecretIv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(encrypted.relayPairingSecretTag, 'base64url'));
    const decryptedText = Buffer.concat([
      decipher.update(Buffer.from(encrypted.relayPairingSecretCiphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const decoded = Buffer.from(decryptedText, 'base64url');
    if (decoded.length !== 32) return null;
    return decoded;
  } catch {
    return null;
  }
}

export async function resolveRelayPairingSecret(peerId: string): Promise<Buffer | null> {
  if (!peerId || peerId.trim().length === 0) return null;
  const store = await readPeerBindings();
  const binding = store.peers.find((peer) => peer.peerId === peerId);
  if (!binding) {
    log.warn(
      {
        peerId,
        knownPeerIds: store.peers.map((peer) => peer.peerId),
        viewportHome: configDir(),
      },
      'Relay pairing peer binding not found',
    );
    return null;
  }

  const decrypted = await decryptRelayPairingSecret(binding);
  if (decrypted) {
    log.debug(
      {
        peerId,
        viewportHome: configDir(),
      },
      'Resolved relay pairing secret',
    );
    return decrypted;
  }

  return null;
}

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
  await appendAudit({ event: 'auth_token_rotated' });
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
      redeemSecretHash: await hashSecret(redeemSecret),
      trustAnchor: trustAnchor.fingerprint,
      daemonDeviceId: daemonIdentity.deviceId,
      daemonPublicKey: daemonIdentity.publicKey,
      connection: input.connection,
    });
    await writeStore(store);
    await appendAudit({
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
      await appendAudit({ event: 'pair_offer_revoked', offerId: offer.offerId });
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
      await appendAudit({
        event: 'pair_offer_redeem_failed',
        offerId: offer.offerId,
        reason: 'missing_client_identity_proof',
      });
      return null;
    }
    if (expectedTrustAnchor && offer.trustAnchor !== expectedTrustAnchor) {
      await appendAudit({
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
        await appendAudit({
          event: 'pair_offer_redeem_failed',
          offerId: offer.offerId,
          reason: 'client_proof_invalid',
        });
        return null;
      }
    } catch {
      await appendAudit({
        event: 'pair_offer_redeem_failed',
        offerId: offer.offerId,
        reason: 'client_proof_invalid',
      });
      return null;
    }
    if (typeof offer.redeemSecretHash !== 'string' || offer.redeemSecretHash.length === 0) {
      offer.lockedAt = now;
      await writeStore(store);
      await appendAudit({
        event: 'pair_offer_redeem_failed',
        offerId: offer.offerId,
        reason: 'missing_redeem_secret_hash',
      });
      return null;
    }

    const proofValid = secureSecretCompare(offer.redeemSecretHash, await hashSecret(redeemSecret));
    if (!proofValid) {
      offer.failedRedeemAttempts = (offer.failedRedeemAttempts ?? 0) + 1;
      if (offer.failedRedeemAttempts >= MAX_FAILED_REDEEM_ATTEMPTS) {
        offer.lockedAt = now;
      }
      await writeStore(store);
      await appendAudit({
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

    await appendAudit({
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

async function hashSecret(secret: string): Promise<string> {
  const key = await getOrCreateSecretStoreKey();
  return crypto.createHmac('sha256', key).update(secret, 'utf8').digest('hex');
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
