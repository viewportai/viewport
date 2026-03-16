import crypto from 'node:crypto';
import { fromBase64Url, toBase64Url } from './bridge-crypto.js';
import type { DaemonRelayIdentity } from './bridge-key-exchange.js';

export type NoiseV3HandshakeProfile = 'noise-ik' | 'noise-ikpsk2';

export interface RelayKeyExchangeInitFrameV3 {
  type: 'relay_key_exchange_init';
  version: 3;
  profile: NoiseV3HandshakeProfile;
  requestId: string;
  clientEphemeralPublicKey: string;
  encryptedClientStatic: string;
  pairingPeerId?: string;
  previousSessionId?: string;
}

export interface RelayKeyExchangeResponseFrameV3 {
  type: 'relay_key_exchange_response';
  version: 3;
  profile: NoiseV3HandshakeProfile;
  requestId: string;
  daemonPublicKey: string;
  daemonEphemeralPublicKey: string;
  encryptedMetadata: string;
  sessionId: string;
  epoch: number;
  proof: string;
}

export interface NoiseV3InitState {
  profile: NoiseV3HandshakeProfile;
  requestId: string;
  daemonPublicKey: string;
  clientStaticPrivateKey: Buffer;
  clientEphemeralPrivateKey: Buffer;
  pairingPeerId?: string;
  ck: Buffer;
  h: Buffer;
  k: Buffer | null;
  nonce: bigint;
}

export interface NoiseV3DerivedSession {
  key: Buffer;
  profile: NoiseV3HandshakeProfile;
  sessionId: string;
  epoch: number;
}

interface NoiseSymmetricState {
  ck: Buffer;
  h: Buffer;
  k: Buffer | null;
  nonce: bigint;
}

const HASH_LEN = 32;
const EMPTY = Buffer.alloc(0);
const PROLOGUE = Buffer.from('viewport-relay-noise-v3', 'utf8');
const SESSION_INFO_PREFIX = 'viewport-relay-session-v3';
const MAX_NONCE = (1n << 64n) - 1n;

function protocolNameFor(profile: NoiseV3HandshakeProfile): string {
  return profile === 'noise-ikpsk2'
    ? 'Noise_IKpsk2_P256_AESGCM_SHA256'
    : 'Noise_IK_P256_AESGCM_SHA256';
}

function hash(data: Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function hkdfOutputs(chainingKey: Buffer, inputKeyMaterial: Buffer, count: 2): [Buffer, Buffer];
function hkdfOutputs(
  chainingKey: Buffer,
  inputKeyMaterial: Buffer,
  count: 3,
): [Buffer, Buffer, Buffer];
function hkdfOutputs(chainingKey: Buffer, inputKeyMaterial: Buffer, count: 2 | 3): Buffer[] {
  const tempKey = hmac(chainingKey, inputKeyMaterial);
  const out1 = hmac(tempKey, Buffer.from([1]));
  const out2 = hmac(tempKey, Buffer.concat([out1, Buffer.from([2])]));
  if (count === 2) return [out1, out2];
  const out3 = hmac(tempKey, Buffer.concat([out2, Buffer.from([3])]));
  return [out1, out2, out3];
}

function initializeSymmetric(profile: NoiseV3HandshakeProfile): NoiseSymmetricState {
  const protocolName = Buffer.from(protocolNameFor(profile), 'utf8');
  const h =
    protocolName.length <= HASH_LEN
      ? Buffer.concat([protocolName, Buffer.alloc(HASH_LEN - protocolName.length)])
      : hash(protocolName);
  return {
    ck: Buffer.from(h),
    h,
    k: null,
    nonce: 0n,
  };
}

function mixHash(state: NoiseSymmetricState, data: Buffer): void {
  state.h = hash(Buffer.concat([state.h, data]));
}

function mixKey(state: NoiseSymmetricState, inputKeyMaterial: Buffer): void {
  const [ck, key] = hkdfOutputs(state.ck, inputKeyMaterial, 2);
  state.ck = ck;
  state.k = key;
  state.nonce = 0n;
}

function mixKeyAndHash(state: NoiseSymmetricState, inputKeyMaterial: Buffer): void {
  const [ck, tempHash, key] = hkdfOutputs(state.ck, inputKeyMaterial, 3);
  state.ck = ck;
  mixHash(state, tempHash);
  state.k = key;
  state.nonce = 0n;
}

function nonceToIv(nonce: bigint): Buffer {
  if (nonce < 0 || nonce > MAX_NONCE) {
    throw new Error('noise nonce out of range');
  }
  const iv = Buffer.alloc(12);
  iv.writeUInt32LE(0, 0);
  iv.writeBigUInt64LE(nonce, 4);
  return iv;
}

function encryptWithAd(key: Buffer, nonce: bigint, ad: Buffer, plaintext: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonceToIv(nonce), {
    authTagLength: 16,
  });
  cipher.setAAD(ad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([body, tag]);
}

function decryptWithAd(key: Buffer, nonce: bigint, ad: Buffer, ciphertext: Buffer): Buffer {
  if (ciphertext.length < 16) {
    throw new Error('noise ciphertext too short');
  }
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonceToIv(nonce), {
    authTagLength: 16,
  });
  decipher.setAAD(ad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

function encryptAndHash(state: NoiseSymmetricState, plaintext: Buffer): Buffer {
  if (!state.k) {
    mixHash(state, plaintext);
    return plaintext;
  }
  const ciphertext = encryptWithAd(state.k, state.nonce, state.h, plaintext);
  mixHash(state, ciphertext);
  state.nonce += 1n;
  return ciphertext;
}

function decryptAndHash(state: NoiseSymmetricState, ciphertext: Buffer): Buffer {
  if (!state.k) {
    mixHash(state, ciphertext);
    return ciphertext;
  }
  const plaintext = decryptWithAd(state.k, state.nonce, state.h, ciphertext);
  mixHash(state, ciphertext);
  state.nonce += 1n;
  return plaintext;
}

function timingSafeEqualBase64Url(left: string, right: string): boolean {
  const leftBytes = fromBase64Url(left);
  const rightBytes = fromBase64Url(right);
  const compareLength = Math.max(leftBytes.length, rightBytes.length, 1);
  const paddedLeft = Buffer.alloc(compareLength);
  const paddedRight = Buffer.alloc(compareLength);
  leftBytes.copy(paddedLeft);
  rightBytes.copy(paddedRight);
  const equal = crypto.timingSafeEqual(paddedLeft, paddedRight);
  return equal && leftBytes.length === rightBytes.length;
}

function split(state: NoiseSymmetricState): [Buffer, Buffer] {
  const [k1, k2] = hkdfOutputs(state.ck, EMPTY, 2);
  return [k1, k2];
}

function deriveSessionKey(params: {
  k1: Buffer;
  k2: Buffer;
  h: Buffer;
  profile: NoiseV3HandshakeProfile;
  sessionId: string;
  epoch: number;
}): Buffer {
  const info = Buffer.from(
    `${SESSION_INFO_PREFIX}|${params.profile}|${params.sessionId}|${params.epoch}`,
    'utf8',
  );
  const ikm = Buffer.concat([params.k1, params.k2]);
  const derived = crypto.hkdfSync('sha256', ikm, params.h, info, 32);
  return Buffer.isBuffer(derived) ? derived : Buffer.from(derived);
}

function validatePublicKey(raw: Buffer, label: string): void {
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error(`invalid ${label} public key`);
  }
}

function ecdhSecret(privateKey: Buffer, publicKey: Buffer): Buffer {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey);
  return ecdh.computeSecret(publicKey);
}

function generateP256Keypair(): { privateKey: Buffer; publicKey: Buffer } {
  const ecdh = crypto.createECDH('prime256v1');
  const publicKey = ecdh.generateKeys();
  const privateKey = ecdh.getPrivateKey();
  return { privateKey, publicKey };
}

function cloneSymmetricState(state: NoiseSymmetricState): NoiseSymmetricState {
  return {
    ck: Buffer.from(state.ck),
    h: Buffer.from(state.h),
    k: state.k ? Buffer.from(state.k) : null,
    nonce: state.nonce,
  };
}

function initializeHandshakeState(
  profile: NoiseV3HandshakeProfile,
  daemonPublicKeyRaw: Buffer,
): NoiseSymmetricState {
  const state = initializeSymmetric(profile);
  mixHash(state, PROLOGUE);
  mixHash(state, daemonPublicKeyRaw);
  return state;
}

function parseMetadata(value: Buffer): { sessionId: string; epoch: number } {
  const parsed = JSON.parse(value.toString('utf8')) as {
    sessionId?: unknown;
    epoch?: unknown;
  };
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.sessionId !== 'string' ||
    !Number.isInteger(parsed.epoch) ||
    (parsed.epoch as number) < 1
  ) {
    throw new Error('invalid noise metadata payload');
  }
  return {
    sessionId: parsed.sessionId,
    epoch: parsed.epoch as number,
  };
}

export function parseRelayKeyExchangeInitFrameV3(
  value: unknown,
): RelayKeyExchangeInitFrameV3 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (
    frame['type'] !== 'relay_key_exchange_init' ||
    frame['version'] !== 3 ||
    (frame['profile'] !== 'noise-ik' && frame['profile'] !== 'noise-ikpsk2') ||
    typeof frame['requestId'] !== 'string' ||
    typeof frame['clientEphemeralPublicKey'] !== 'string' ||
    typeof frame['encryptedClientStatic'] !== 'string'
  ) {
    return null;
  }

  const previousSessionId =
    typeof frame['previousSessionId'] === 'string' ? frame['previousSessionId'] : undefined;
  const pairingPeerId =
    typeof frame['pairingPeerId'] === 'string' ? frame['pairingPeerId'] : undefined;
  if (
    frame['profile'] === 'noise-ikpsk2' &&
    (!pairingPeerId || pairingPeerId.trim().length === 0)
  ) {
    return null;
  }

  return {
    type: 'relay_key_exchange_init',
    version: 3,
    profile: frame['profile'],
    requestId: frame['requestId'],
    clientEphemeralPublicKey: frame['clientEphemeralPublicKey'],
    encryptedClientStatic: frame['encryptedClientStatic'],
    pairingPeerId,
    previousSessionId,
  };
}

export function isRelayKeyExchangeResponseFrameV3(
  value: unknown,
): value is RelayKeyExchangeResponseFrameV3 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return (
    frame['type'] === 'relay_key_exchange_response' &&
    frame['version'] === 3 &&
    (frame['profile'] === 'noise-ik' || frame['profile'] === 'noise-ikpsk2') &&
    typeof frame['requestId'] === 'string' &&
    typeof frame['daemonPublicKey'] === 'string' &&
    typeof frame['daemonEphemeralPublicKey'] === 'string' &&
    typeof frame['encryptedMetadata'] === 'string' &&
    typeof frame['sessionId'] === 'string' &&
    typeof frame['epoch'] === 'number' &&
    Number.isInteger(frame['epoch']) &&
    (frame['epoch'] as number) >= 1 &&
    typeof frame['proof'] === 'string'
  );
}

export function createNoiseV3Init(params: {
  profile: NoiseV3HandshakeProfile;
  daemonPublicKey: string;
  pairingPeerId?: string;
  requestId?: string;
  previousSessionId?: string;
  pairingSecret?: Buffer;
  clientStaticPrivateKeyOverride?: Buffer;
  clientEphemeralPrivateKeyOverride?: Buffer;
}): { frame: RelayKeyExchangeInitFrameV3; state: NoiseV3InitState } {
  if (params.profile === 'noise-ikpsk2' && !params.pairingSecret) {
    throw new Error('pairing secret required for noise-ikpsk2');
  }
  const daemonPublicKeyRaw = fromBase64Url(params.daemonPublicKey);
  validatePublicKey(daemonPublicKeyRaw, 'daemon');

  const staticKeys = params.clientStaticPrivateKeyOverride
    ? (() => {
        const ecdh = crypto.createECDH('prime256v1');
        ecdh.setPrivateKey(params.clientStaticPrivateKeyOverride);
        return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey() };
      })()
    : generateP256Keypair();

  const ephemeralKeys = params.clientEphemeralPrivateKeyOverride
    ? (() => {
        const ecdh = crypto.createECDH('prime256v1');
        ecdh.setPrivateKey(params.clientEphemeralPrivateKeyOverride);
        return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey() };
      })()
    : generateP256Keypair();

  validatePublicKey(staticKeys.publicKey, 'client static');
  validatePublicKey(ephemeralKeys.publicKey, 'client ephemeral');

  const state = initializeHandshakeState(params.profile, daemonPublicKeyRaw);

  mixHash(state, ephemeralKeys.publicKey);
  mixKey(state, ecdhSecret(ephemeralKeys.privateKey, daemonPublicKeyRaw));

  const encryptedClientStatic = encryptAndHash(state, staticKeys.publicKey);
  mixKey(state, ecdhSecret(staticKeys.privateKey, daemonPublicKeyRaw));

  if (params.profile === 'noise-ikpsk2' && params.pairingSecret) {
    if (params.pairingSecret.length !== 32) {
      throw new Error('pairing secret must be 32 bytes');
    }
  }

  const requestId = params.requestId ?? `kex-${crypto.randomBytes(8).toString('hex')}`;

  return {
    frame: {
      type: 'relay_key_exchange_init',
      version: 3,
      profile: params.profile,
      requestId,
      clientEphemeralPublicKey: toBase64Url(ephemeralKeys.publicKey),
      encryptedClientStatic: toBase64Url(encryptedClientStatic),
      pairingPeerId: params.pairingPeerId,
      previousSessionId: params.previousSessionId,
    },
    state: {
      profile: params.profile,
      requestId,
      daemonPublicKey: params.daemonPublicKey,
      clientStaticPrivateKey: staticKeys.privateKey,
      clientEphemeralPrivateKey: ephemeralKeys.privateKey,
      pairingPeerId: params.pairingPeerId,
      ck: Buffer.from(state.ck),
      h: Buffer.from(state.h),
      k: state.k ? Buffer.from(state.k) : null,
      nonce: state.nonce,
    },
  };
}

export function deriveNoiseV3SessionFromInit(params: {
  init: RelayKeyExchangeInitFrameV3;
  daemonIdentity: DaemonRelayIdentity;
  nextEpoch: number;
  pairingSecret?: Buffer;
  daemonEphemeralPrivateKeyOverride?: Buffer;
  sessionIdOverride?: string;
}): { session: NoiseV3DerivedSession; response: RelayKeyExchangeResponseFrameV3 } {
  const daemonPublicKeyRaw = fromBase64Url(params.daemonIdentity.publicKey);
  validatePublicKey(daemonPublicKeyRaw, 'daemon static');
  const daemonPrivateKeyRaw = fromBase64Url(params.daemonIdentity.privateKey);
  if (daemonPrivateKeyRaw.length !== 32) {
    throw new Error('invalid daemon private key');
  }

  if (params.init.profile === 'noise-ikpsk2') {
    if (!params.pairingSecret || params.pairingSecret.length !== 32) {
      throw new Error('pairing secret required for noise-ikpsk2');
    }
  }

  const clientEphemeralPublicKeyRaw = fromBase64Url(params.init.clientEphemeralPublicKey);
  validatePublicKey(clientEphemeralPublicKeyRaw, 'client ephemeral');
  const encryptedClientStaticRaw = fromBase64Url(params.init.encryptedClientStatic);

  const state = initializeHandshakeState(params.init.profile, daemonPublicKeyRaw);

  mixHash(state, clientEphemeralPublicKeyRaw);
  mixKey(state, ecdhSecret(daemonPrivateKeyRaw, clientEphemeralPublicKeyRaw));

  const clientStaticPublicKeyRaw = decryptAndHash(state, encryptedClientStaticRaw);
  validatePublicKey(clientStaticPublicKeyRaw, 'client static');

  mixKey(state, ecdhSecret(daemonPrivateKeyRaw, clientStaticPublicKeyRaw));

  const responderEphemeral = params.daemonEphemeralPrivateKeyOverride
    ? (() => {
        const ecdh = crypto.createECDH('prime256v1');
        ecdh.setPrivateKey(params.daemonEphemeralPrivateKeyOverride);
        return { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey() };
      })()
    : generateP256Keypair();

  validatePublicKey(responderEphemeral.publicKey, 'daemon ephemeral');

  mixHash(state, responderEphemeral.publicKey);
  mixKey(state, ecdhSecret(responderEphemeral.privateKey, clientEphemeralPublicKeyRaw));
  mixKey(state, ecdhSecret(responderEphemeral.privateKey, clientStaticPublicKeyRaw));

  if (params.init.profile === 'noise-ikpsk2' && params.pairingSecret) {
    mixKeyAndHash(state, params.pairingSecret);
  }

  const sessionId = params.sessionIdOverride ?? `rs_${crypto.randomBytes(12).toString('hex')}`;
  const epoch = Math.max(1, params.nextEpoch);
  const metadata = Buffer.from(JSON.stringify({ sessionId, epoch }), 'utf8');
  const encryptedMetadata = encryptAndHash(state, metadata);

  const [k1, k2] = split(state);
  const sessionKey = deriveSessionKey({
    k1,
    k2,
    h: state.h,
    profile: params.init.profile,
    sessionId,
    epoch,
  });

  return {
    session: {
      key: sessionKey,
      profile: params.init.profile,
      sessionId,
      epoch,
    },
    response: {
      type: 'relay_key_exchange_response',
      version: 3,
      profile: params.init.profile,
      requestId: params.init.requestId,
      daemonPublicKey: params.daemonIdentity.publicKey,
      daemonEphemeralPublicKey: toBase64Url(responderEphemeral.publicKey),
      encryptedMetadata: toBase64Url(encryptedMetadata),
      sessionId,
      epoch,
      proof: toBase64Url(state.h),
    },
  };
}

export function finalizeNoiseV3Response(params: {
  state: NoiseV3InitState;
  response: RelayKeyExchangeResponseFrameV3;
  pairingSecret?: Buffer;
}): NoiseV3DerivedSession {
  if (params.response.version !== 3) {
    throw new Error('unsupported relay key exchange response version');
  }
  if (params.response.requestId !== params.state.requestId) {
    throw new Error('key exchange response requestId mismatch');
  }
  if (params.response.profile !== params.state.profile) {
    throw new Error('key exchange response profile mismatch');
  }

  if (params.state.profile === 'noise-ikpsk2') {
    if (!params.pairingSecret || params.pairingSecret.length !== 32) {
      throw new Error('pairing secret required for noise-ikpsk2');
    }
  }

  const daemonPublicKeyRaw = fromBase64Url(params.state.daemonPublicKey);
  validatePublicKey(daemonPublicKeyRaw, 'daemon static');
  const daemonEphemeralPublicKeyRaw = fromBase64Url(params.response.daemonEphemeralPublicKey);
  validatePublicKey(daemonEphemeralPublicKeyRaw, 'daemon ephemeral');
  const encryptedMetadataRaw = fromBase64Url(params.response.encryptedMetadata);

  const state: NoiseSymmetricState = cloneSymmetricState({
    ck: params.state.ck,
    h: params.state.h,
    k: params.state.k,
    nonce: params.state.nonce,
  });

  mixHash(state, daemonEphemeralPublicKeyRaw);
  mixKey(state, ecdhSecret(params.state.clientEphemeralPrivateKey, daemonEphemeralPublicKeyRaw));
  mixKey(state, ecdhSecret(params.state.clientStaticPrivateKey, daemonEphemeralPublicKeyRaw));

  if (params.state.profile === 'noise-ikpsk2' && params.pairingSecret) {
    mixKeyAndHash(state, params.pairingSecret);
  }

  const metadataRaw = decryptAndHash(state, encryptedMetadataRaw);
  const metadata = parseMetadata(metadataRaw);

  if (
    metadata.sessionId !== params.response.sessionId ||
    metadata.epoch !== params.response.epoch
  ) {
    throw new Error('relay metadata mismatch');
  }

  const expectedProof = toBase64Url(state.h);
  if (!timingSafeEqualBase64Url(expectedProof, params.response.proof)) {
    throw new Error('noise handshake proof mismatch');
  }

  const [k1, k2] = split(state);
  const sessionKey = deriveSessionKey({
    k1,
    k2,
    h: state.h,
    profile: params.response.profile,
    sessionId: params.response.sessionId,
    epoch: params.response.epoch,
  });

  return {
    key: sessionKey,
    profile: params.response.profile,
    sessionId: params.response.sessionId,
    epoch: params.response.epoch,
  };
}
