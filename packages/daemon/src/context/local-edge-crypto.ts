import crypto from 'node:crypto';

const KDF = 'scrypt-n16384-r8-p1-sha256';
const CIPHER = 'aes-256-gcm';

export interface EncryptedPayload {
  cipher: typeof CIPHER;
  ciphertext: string;
  iv: string;
  tag: string;
}

export interface WrappedKey extends EncryptedPayload {
  kdf: typeof KDF;
  salt: string;
}

export function createResourceKey(): Buffer {
  return crypto.randomBytes(32);
}

export function digestText(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function digestJson(value: unknown): string {
  return digestText(stableJson(value));
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function wrapResourceKey(
  resourceKey: Buffer,
  credentials: { passphrase: string; recoveryCode: string },
): WrappedKey {
  const salt = crypto.randomBytes(16).toString('base64');
  const key = deriveKey({ ...credentials, salt });
  return {
    ...encryptBuffer(resourceKey, key),
    kdf: KDF,
    salt,
  };
}

export function unwrapResourceKey(
  wrappedKey: WrappedKey,
  credentials: { passphrase: string; recoveryCode: string },
): Buffer {
  if (wrappedKey.kdf !== KDF) {
    throw new Error(`Unsupported context key KDF: ${wrappedKey.kdf}`);
  }
  const key = deriveKey({ ...credentials, salt: wrappedKey.salt });
  return decryptBuffer(wrappedKey, key);
}

export function encryptText(plaintext: string, key: Buffer): EncryptedPayload {
  return encryptBuffer(Buffer.from(plaintext, 'utf8'), key);
}

export function decryptText(payload: EncryptedPayload, key: Buffer): string {
  return decryptBuffer(payload, key).toString('utf8');
}

function deriveKey({
  passphrase,
  recoveryCode,
  salt,
}: {
  passphrase: string;
  recoveryCode: string;
  salt: string;
}): Buffer {
  return crypto.scryptSync(`${passphrase}:${recoveryCode}`, Buffer.from(salt, 'base64'), 32, {
    N: 16384,
    r: 8,
    p: 1,
  });
}

function encryptBuffer(plaintext: Buffer, key: Buffer): EncryptedPayload {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    cipher: CIPHER,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptBuffer(payload: EncryptedPayload, key: Buffer): Buffer {
  if (payload.cipher !== CIPHER) {
    throw new Error(`Unsupported context cipher: ${payload.cipher}`);
  }
  const decipher = crypto.createDecipheriv(CIPHER, key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
