import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { configDir } from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  pairingPeerBindingsMax,
  pairingSecretStoreKeyPath,
  peerBindingPath,
} from './pairing-file-store.js';
import type { PairingPeerBindingRecord, PairingPeerBindingStore } from './pairing-offer-types.js';

const log = logger.child({ module: 'pairing-peer-bindings' });

const RELAY_PAIRING_INFO_PREFIX = 'viewport-relay-policyc-pair-v1';
const PAIRING_SECRET_STORE_KEY_BYTES = 32;

let cachedSecretStoreKey: Buffer | null = null;
let cachedSecretStoreKeyPath: string | null = null;

export function peerIdFromPublicKey(publicKey: string): string {
  return crypto.createHash('sha256').update(publicKey).digest('hex');
}

export function deriveRelayPairingSecret(input: {
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

export async function hashPairingSecret(secret: string): Promise<string> {
  const key = await getOrCreateSecretStoreKey();
  return crypto.createHmac('sha256', key).update(secret, 'utf8').digest('hex');
}

export async function upsertPeerBinding(input: {
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
