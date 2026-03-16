import crypto from 'node:crypto';
import type { RelayHandshakeProfile } from './bridge-key-exchange.js';

export interface RelayEnvelopeV2 {
  type: 'e2ee';
  version: 2;
  profile: RelayHandshakeProfile;
  sessionId: string;
  epoch: number;
  seq: number;
  iv: string;
  tag: string;
  ciphertext: string;
}

function isRelayHandshakeProfile(value: unknown): value is RelayHandshakeProfile {
  return value === 'noise-ik' || value === 'noise-ikpsk2';
}

function toEnvelopeAad(
  envelope: Pick<RelayEnvelopeV2, 'profile' | 'sessionId' | 'epoch' | 'seq'>,
): Buffer {
  return Buffer.from(
    `viewport-relay-envelope-v2|${envelope.profile}|${envelope.sessionId}|${envelope.epoch}|${envelope.seq}`,
    'utf8',
  );
}

export function toBase64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function parseRelayEnvelope(raw: string): RelayEnvelopeV2 {
  const parsed = JSON.parse(raw) as Partial<RelayEnvelopeV2>;
  if (
    parsed.type !== 'e2ee' ||
    parsed.version !== 2 ||
    !isRelayHandshakeProfile(parsed.profile) ||
    typeof parsed.sessionId !== 'string' ||
    parsed.sessionId.trim().length === 0 ||
    typeof parsed.epoch !== 'number' ||
    !Number.isInteger(parsed.epoch) ||
    parsed.epoch < 1 ||
    typeof parsed.seq !== 'number' ||
    !Number.isInteger(parsed.seq) ||
    parsed.seq < 1 ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.tag !== 'string' ||
    typeof parsed.ciphertext !== 'string'
  ) {
    throw new Error('Invalid relay envelope');
  }

  return parsed as RelayEnvelopeV2;
}

export function encryptEnvelope(
  key: Buffer,
  plaintext: string,
  metadata: Pick<RelayEnvelopeV2, 'profile' | 'sessionId' | 'epoch' | 'seq'>,
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(toEnvelopeAad(metadata));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: RelayEnvelopeV2 = {
    type: 'e2ee',
    version: 2,
    profile: metadata.profile,
    sessionId: metadata.sessionId,
    epoch: metadata.epoch,
    seq: metadata.seq,
    iv: toBase64Url(iv),
    tag: toBase64Url(tag),
    ciphertext: toBase64Url(ciphertext),
  };
  return JSON.stringify(envelope);
}

export function decryptEnvelope(key: Buffer, envelope: RelayEnvelopeV2): string {
  const iv = fromBase64Url(envelope.iv);
  const tag = fromBase64Url(envelope.tag);
  const ciphertext = fromBase64Url(envelope.ciphertext);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(toEnvelopeAad(envelope));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
