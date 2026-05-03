import crypto from 'node:crypto';
import { fromBase64Url, normalizeP256PrivateKey, toBase64Url } from './bridge-crypto.js';
import { type DaemonRelayIdentity } from './bridge-identity-store.js';

export type { DaemonRelayIdentity } from './bridge-identity-store.js';
export { loadOrCreateIdentity } from './bridge-identity-store.js';

export type RelayHandshakeProfile = 'noise-ik' | 'noise-ikpsk2';

export interface RelayKeyExchangeInitFrame {
  type: 'relay_key_exchange_init';
  version: 2;
  profile: RelayHandshakeProfile;
  requestId: string;
  clientPublicKey: string;
  clientNonce: string;
  clientProof: string;
  pairingPeerId?: string;
  previousSessionId?: string;
}

export interface RelayKeyExchangeResponseFrame {
  type: 'relay_key_exchange_response';
  version: 2;
  profile: RelayHandshakeProfile;
  requestId: string;
  daemonPublicKey: string;
  daemonNonce: string;
  sessionId: string;
  epoch: number;
  proof: string;
}

export interface DerivedRelaySession {
  key: Buffer;
  profile: RelayHandshakeProfile;
  sessionId: string;
  epoch: number;
}

const SESSION_INFO_PREFIX = 'viewport-relay-session-v2';
const TRANSCRIPT_PREFIX = 'viewport-relay-transcript-v2';
const INIT_INFO_PREFIX = 'viewport-relay-kex-init-v1';

function toSessionInfo(profile: RelayHandshakeProfile, sessionId: string, epoch: number): Buffer {
  return Buffer.from(`${SESSION_INFO_PREFIX}|${profile}|${sessionId}|${epoch}`, 'utf8');
}

function toTranscript(params: {
  requestId: string;
  profile: RelayHandshakeProfile;
  clientPublicKey: string;
  daemonPublicKey: string;
  clientNonce: string;
  daemonNonce: string;
  sessionId: string;
  epoch: number;
}): Buffer {
  return Buffer.from(
    [
      TRANSCRIPT_PREFIX,
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
}

function deriveSessionKey(params: {
  sharedSecret: Buffer;
  clientNonce: Buffer;
  daemonNonce: Buffer;
  profile: RelayHandshakeProfile;
  sessionId: string;
  epoch: number;
  pairingSecret?: Buffer;
}): Buffer {
  const ikm =
    params.profile === 'noise-ikpsk2' && params.pairingSecret
      ? Buffer.concat([params.sharedSecret, params.pairingSecret])
      : params.sharedSecret;
  const salt = Buffer.concat([params.clientNonce, params.daemonNonce]);
  const derived = crypto.hkdfSync(
    'sha256',
    ikm,
    salt,
    toSessionInfo(params.profile, params.sessionId, params.epoch),
    32,
  );
  return Buffer.isBuffer(derived) ? derived : Buffer.from(derived);
}

function computeProof(sessionKey: Buffer, transcript: Buffer): Buffer {
  return crypto.createHmac('sha256', sessionKey).update(transcript).digest().subarray(0, 16);
}

function toInitInfo(params: {
  requestId: string;
  profile: RelayHandshakeProfile;
  clientPublicKey: string;
  daemonPublicKey: string;
  clientNonce: string;
  previousSessionId?: string;
}): Buffer {
  return Buffer.from(
    [
      INIT_INFO_PREFIX,
      params.requestId,
      params.profile,
      params.clientPublicKey,
      params.daemonPublicKey,
      params.clientNonce,
      params.previousSessionId ?? '',
    ].join('|'),
    'utf8',
  );
}

function computeClientInitProof(params: {
  sharedSecret: Buffer;
  clientNonce: Buffer;
  profile: RelayHandshakeProfile;
  requestId: string;
  clientPublicKey: string;
  daemonPublicKey: string;
  clientNonceEncoded: string;
  previousSessionId?: string;
  pairingSecret?: Buffer;
}): Buffer {
  const ikm =
    params.profile === 'noise-ikpsk2' && params.pairingSecret
      ? Buffer.concat([params.sharedSecret, params.pairingSecret])
      : params.sharedSecret;

  const initKey = crypto.hkdfSync(
    'sha256',
    ikm,
    params.clientNonce,
    toInitInfo({
      requestId: params.requestId,
      profile: params.profile,
      clientPublicKey: params.clientPublicKey,
      daemonPublicKey: params.daemonPublicKey,
      clientNonce: params.clientNonceEncoded,
      previousSessionId: params.previousSessionId,
    }),
    32,
  );
  const normalized = Buffer.isBuffer(initKey) ? initKey : Buffer.from(initKey);
  return crypto
    .createHmac('sha256', normalized)
    .update('client-proof', 'utf8')
    .digest()
    .subarray(0, 16);
}

export function parseRelayHandshakeProfile(value: unknown): RelayHandshakeProfile | null {
  if (value === 'noise-ik' || value === 'noise-ikpsk2') return value;
  return null;
}

export function parseRelayKeyExchangeInitFrame(value: unknown): RelayKeyExchangeInitFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  const profile = parseRelayHandshakeProfile(frame['profile']);
  if (!profile) return null;
  if (
    frame['type'] !== 'relay_key_exchange_init' ||
    frame['version'] !== 2 ||
    typeof frame['requestId'] !== 'string' ||
    typeof frame['clientPublicKey'] !== 'string' ||
    typeof frame['clientNonce'] !== 'string' ||
    typeof frame['clientProof'] !== 'string'
  ) {
    return null;
  }
  const previousSessionId =
    typeof frame['previousSessionId'] === 'string' ? frame['previousSessionId'] : undefined;
  const pairingPeerId =
    typeof frame['pairingPeerId'] === 'string' ? frame['pairingPeerId'] : undefined;
  if (profile === 'noise-ikpsk2' && (!pairingPeerId || pairingPeerId.trim().length === 0)) {
    return null;
  }
  return {
    type: 'relay_key_exchange_init',
    version: 2,
    profile,
    requestId: frame['requestId'],
    clientPublicKey: frame['clientPublicKey'],
    clientNonce: frame['clientNonce'],
    clientProof: frame['clientProof'],
    pairingPeerId,
    previousSessionId,
  };
}

export function deriveSessionFromKeyExchange(params: {
  init: RelayKeyExchangeInitFrame;
  daemonIdentity: DaemonRelayIdentity;
  nextEpoch: number;
  pairingSecret?: Buffer;
  daemonNonceOverride?: Buffer;
  sessionIdOverride?: string;
}): { session: DerivedRelaySession; response: RelayKeyExchangeResponseFrame } {
  const clientPublic = fromBase64Url(params.init.clientPublicKey);
  if (clientPublic.length !== 65 || clientPublic[0] !== 0x04) {
    throw new Error('invalid client public key');
  }
  const clientNonce = fromBase64Url(params.init.clientNonce);
  if (clientNonce.length < 12 || clientNonce.length > 32) {
    throw new Error('invalid client nonce');
  }

  const daemonPrivate = normalizeP256PrivateKey(fromBase64Url(params.daemonIdentity.privateKey));
  if (!daemonPrivate) {
    throw new Error('invalid daemon private key');
  }
  if (params.init.profile === 'noise-ikpsk2' && !params.pairingSecret) {
    throw new Error('pairing secret required for noise-ikpsk2');
  }

  const daemonNonce = params.daemonNonceOverride ?? crypto.randomBytes(16);
  if (daemonNonce.length !== 16) {
    throw new Error('invalid daemon nonce override');
  }
  const sessionId = params.sessionIdOverride ?? `rs_${crypto.randomBytes(12).toString('hex')}`;
  if (sessionId.trim().length === 0) {
    throw new Error('invalid session id override');
  }
  const epoch = Math.max(1, params.nextEpoch);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(daemonPrivate);
  const sharedSecret = ecdh.computeSecret(clientPublic);
  const expectedClientProof = computeClientInitProof({
    sharedSecret,
    clientNonce,
    profile: params.init.profile,
    requestId: params.init.requestId,
    clientPublicKey: params.init.clientPublicKey,
    daemonPublicKey: params.daemonIdentity.publicKey,
    clientNonceEncoded: params.init.clientNonce,
    previousSessionId: params.init.previousSessionId,
    pairingSecret: params.pairingSecret,
  });
  const providedClientProof = fromBase64Url(params.init.clientProof);
  if (
    providedClientProof.length !== expectedClientProof.length ||
    !crypto.timingSafeEqual(providedClientProof, expectedClientProof)
  ) {
    throw new Error('invalid client key exchange proof');
  }

  const sessionKey = deriveSessionKey({
    sharedSecret,
    clientNonce,
    daemonNonce,
    profile: params.init.profile,
    sessionId,
    epoch,
    pairingSecret: params.pairingSecret,
  });

  const daemonNonceEncoded = toBase64Url(daemonNonce);
  const transcript = toTranscript({
    requestId: params.init.requestId,
    profile: params.init.profile,
    clientPublicKey: params.init.clientPublicKey,
    daemonPublicKey: params.daemonIdentity.publicKey,
    clientNonce: params.init.clientNonce,
    daemonNonce: daemonNonceEncoded,
    sessionId,
    epoch,
  });
  const proof = computeProof(sessionKey, transcript);

  return {
    session: {
      key: sessionKey,
      profile: params.init.profile,
      sessionId,
      epoch,
    },
    response: {
      type: 'relay_key_exchange_response',
      version: 2,
      profile: params.init.profile,
      requestId: params.init.requestId,
      daemonPublicKey: params.daemonIdentity.publicKey,
      daemonNonce: daemonNonceEncoded,
      sessionId,
      epoch,
      proof: toBase64Url(proof),
    },
  };
}
