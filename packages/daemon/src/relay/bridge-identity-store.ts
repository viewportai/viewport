import * as crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../core/config.js';
import { fromBase64Url, normalizeP256PrivateKey, toBase64Url } from './bridge-crypto.js';

export interface DaemonRelayIdentity {
  deviceId: string;
  createdAt: number;
  publicKey: string;
  privateKey: string;
  algorithm: 'p256';
}

function globalIdentityFilePath(): string {
  return path.join(configDir(), 'relay-daemon-identity.json');
}

function scopedIdentityFilePath(scope: string): string {
  const safeScope = scope.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(configDir(), 'relay-identities', `${safeScope}.json`);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

async function readIdentityFile(filePath: string): Promise<DaemonRelayIdentity | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DaemonRelayIdentity>;
    if (
      parsed.algorithm === 'p256' &&
      typeof parsed.deviceId === 'string' &&
      parsed.deviceId.trim().length > 0 &&
      typeof parsed.publicKey === 'string' &&
      typeof parsed.privateKey === 'string'
    ) {
      const priv = normalizeP256PrivateKey(fromBase64Url(parsed.privateKey));
      const pub = fromBase64Url(parsed.publicKey);
      if (priv && pub.length === 65 && pub[0] === 0x04) {
        return {
          deviceId: parsed.deviceId,
          createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
          algorithm: 'p256',
          publicKey: parsed.publicKey,
          privateKey: toBase64Url(priv),
        };
      }
    }
  } catch {
    // handled by caller
  }
  return null;
}

async function writeIdentityFile(filePath: string, identity: DaemonRelayIdentity): Promise<void> {
  await writeJsonAtomic(filePath, identity);
}

async function createIdentity(): Promise<DaemonRelayIdentity> {
  const createdAt = Date.now();
  const deviceId = crypto.randomUUID();

  const ecdh = crypto.createECDH('prime256v1');
  const publicKey = ecdh.generateKeys();
  const privateKey = normalizeP256PrivateKey(ecdh.getPrivateKey());
  if (!privateKey) {
    throw new Error('failed to generate daemon relay identity');
  }

  return {
    deviceId,
    createdAt,
    algorithm: 'p256',
    publicKey: toBase64Url(publicKey),
    privateKey: toBase64Url(privateKey),
  };
}

export async function loadOrCreateIdentity(scope?: string): Promise<DaemonRelayIdentity> {
  const identityPath = scope ? scopedIdentityFilePath(scope) : globalIdentityFilePath();
  const existing = await readIdentityFile(identityPath);
  if (existing) {
    return existing;
  }

  const identity = await createIdentity();
  await writeIdentityFile(identityPath, identity);
  return identity;
}
