import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { configDir } from '../core/config.js';
import { appendPairingAudit, daemonIdentityPath, trustAnchorPath } from './pairing-file-store.js';
import type {
  PairingDaemonIdentityPublic,
  PairingDaemonIdentityRecord,
  PairingTrustAnchorPublic,
  PairingTrustAnchorRecord,
} from './pairing-offer-types.js';

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
  await appendPairingAudit({
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

export async function readDaemonIdentity(): Promise<PairingDaemonIdentityRecord | null> {
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
  await appendPairingAudit({
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
