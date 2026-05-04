import crypto from 'node:crypto';
import { fromBase64Url, toBase64Url } from './bridge-crypto.js';

export function derivePairingChannelKey(sharedSecret: Buffer, saltLabel: string): Buffer {
  const salt = crypto.createHash('sha256').update(saltLabel, 'utf8').digest();
  const raw = crypto.hkdfSync(
    'sha256',
    sharedSecret,
    salt,
    Buffer.from('viewport-relay-pairing-channel-v1', 'utf8'),
    32,
  );
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
}

export function encryptPairingPayload(
  key: Buffer,
  plaintext: string,
  aadLabel: string,
): { encIv: string; encTag: string; encCiphertext: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aadLabel, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encIv: toBase64Url(iv),
    encTag: toBase64Url(tag),
    encCiphertext: toBase64Url(ciphertext),
  };
}

export function decryptPairingPayload(
  key: Buffer,
  encrypted: { encIv: string; encTag: string; encCiphertext: string },
  aadLabel: string,
): string {
  const iv = fromBase64Url(encrypted.encIv);
  const tag = fromBase64Url(encrypted.encTag);
  const ciphertext = fromBase64Url(encrypted.encCiphertext);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aadLabel, 'utf8'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
