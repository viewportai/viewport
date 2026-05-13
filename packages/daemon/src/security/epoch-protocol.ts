import crypto from 'node:crypto';

export const USER_EPOCH_SCHEMA = 'viewport.user_crypto_epoch/v1';
export const TEAM_EPOCH_SCHEMA = 'viewport.team_crypto_epoch/v1';
export const DEVICE_ENROLLMENT_SCHEMA = 'viewport.device_enrollment/v1';
export const RESOURCE_GRANT_SCHEMA = 'viewport.resource_key_grant/v1';
export const WRAPPED_KEY_ENVELOPE_SCHEMA = 'viewport.wrapped_key_envelope/v1';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface EpochDescriptor {
  schema: typeof USER_EPOCH_SCHEMA | typeof TEAM_EPOCH_SCHEMA;
  workspaceId: string;
  subjectType: 'user' | 'team';
  subjectId: string;
  epoch: number;
  encryptionPublicKeyJwk: JsonValue;
  signingPublicKeyJwk: JsonValue;
  previousEpochFingerprint?: string | null;
  createdAt: string;
}

export interface DeviceEnrollmentRequest {
  schema: typeof DEVICE_ENROLLMENT_SCHEMA;
  workspaceId: string;
  userId: string;
  deviceId: string;
  deviceLabel: string;
  encryptionPublicKeyJwk: JsonValue;
  signingPublicKeyJwk: JsonValue;
  createdAt: string;
  nonce: string;
}

export interface SignedEpochTransition {
  payload: EpochTransitionPayload;
  signature: string;
  signedByEpochFingerprint: string;
}

export interface WrappedKeyEnvelope {
  schema: typeof WRAPPED_KEY_ENVELOPE_SCHEMA;
  alg: 'x25519-hkdf-sha256-aes-256-gcm';
  ephemeralPublicKeyJwk: JsonValue;
  iv: string;
  ciphertext: string;
  tag: string;
  aadDigest: string;
  createdAt: string;
}

export interface EpochTransitionPayload {
  schema: 'viewport.epoch_transition/v1';
  workspaceId: string;
  subjectType: 'user' | 'team';
  subjectId: string;
  fromEpoch: number;
  fromEpochFingerprint: string;
  toEpoch: number;
  toEpochFingerprint: string;
  reason: 'initial' | 'device_enrolled' | 'device_revoked' | 'member_revoked' | 'manual_rotation' | 'recovery';
  createdAt: string;
}

const PRIVATE_JWK_FIELDS = new Set([
  'd',
  'p',
  'q',
  'dp',
  'dq',
  'qi',
  'oth',
  'k',
  'x5c_private',
  'hpkePrivateKey',
  'privateKey',
  'secretKey',
]);

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Base64Url(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

export function fingerprintPayload(value: JsonValue): string {
  return `sha256:${sha256Base64Url(canonicalJson(value))}`;
}

export function epochFingerprint(epoch: EpochDescriptor): string {
  return fingerprintPayload({
    schema: epoch.schema,
    workspaceId: epoch.workspaceId,
    subjectType: epoch.subjectType,
    subjectId: epoch.subjectId,
    epoch: epoch.epoch,
    encryptionPublicKeyJwk: epoch.encryptionPublicKeyJwk,
    signingPublicKeyJwk: epoch.signingPublicKeyJwk,
    previousEpochFingerprint: epoch.previousEpochFingerprint ?? null,
  });
}

export function deviceEnrollmentFingerprint(request: DeviceEnrollmentRequest): string {
  assertNoPrivateKeyMaterial(request.encryptionPublicKeyJwk);
  assertNoPrivateKeyMaterial(request.signingPublicKeyJwk);
  return fingerprintPayload({
    schema: request.schema,
    workspaceId: request.workspaceId,
    userId: request.userId,
    deviceId: request.deviceId,
    deviceLabel: request.deviceLabel,
    encryptionPublicKeyJwk: request.encryptionPublicKeyJwk,
    signingPublicKeyJwk: request.signingPublicKeyJwk,
    nonce: request.nonce,
  });
}

export function epochTransitionPayload(input: {
  from: EpochDescriptor;
  to: EpochDescriptor;
  reason: EpochTransitionPayload['reason'];
  createdAt: string;
}): EpochTransitionPayload {
  if (input.from.workspaceId !== input.to.workspaceId) {
    throw new Error('Epoch transition workspace mismatch.');
  }
  if (input.from.subjectType !== input.to.subjectType || input.from.subjectId !== input.to.subjectId) {
    throw new Error('Epoch transition subject mismatch.');
  }
  if (input.to.epoch !== input.from.epoch + 1) {
    throw new Error('Epoch transition must advance by exactly one epoch.');
  }

  return {
    schema: 'viewport.epoch_transition/v1',
    workspaceId: input.from.workspaceId,
    subjectType: input.from.subjectType,
    subjectId: input.from.subjectId,
    fromEpoch: input.from.epoch,
    fromEpochFingerprint: epochFingerprint(input.from),
    toEpoch: input.to.epoch,
    toEpochFingerprint: epochFingerprint(input.to),
    reason: input.reason,
    createdAt: input.createdAt,
  };
}

export function signEpochTransition(input: {
  payload: EpochTransitionPayload;
  signingPrivateKeyJwk: JsonValue;
  signedByEpochFingerprint: string;
}): SignedEpochTransition {
  const key = crypto.createPrivateKey({
    key: input.signingPrivateKeyJwk as crypto.JsonWebKey,
    format: 'jwk',
  });
  const signature = crypto.sign(null, Buffer.from(canonicalJson(input.payload)), key).toString('base64url');
  return {
    payload: input.payload,
    signature,
    signedByEpochFingerprint: input.signedByEpochFingerprint,
  };
}

export function verifyEpochTransition(input: {
  signed: SignedEpochTransition;
  signingPublicKeyJwk: JsonValue;
  expectedFromEpochFingerprint: string;
  expectedToEpochFingerprint: string;
}): boolean {
  if (input.signed.signedByEpochFingerprint !== input.expectedFromEpochFingerprint) return false;
  if (input.signed.payload.fromEpochFingerprint !== input.expectedFromEpochFingerprint) return false;
  if (input.signed.payload.toEpochFingerprint !== input.expectedToEpochFingerprint) return false;
  const key = crypto.createPublicKey({
    key: input.signingPublicKeyJwk as crypto.JsonWebKey,
    format: 'jwk',
  });
  return crypto.verify(
    null,
    Buffer.from(canonicalJson(input.signed.payload)),
    key,
    Buffer.from(input.signed.signature, 'base64url'),
  );
}

export function wrapJsonForX25519Recipient(input: {
  recipientPublicKeyJwk: JsonValue;
  payload: JsonValue;
  aad: JsonValue;
  createdAt?: string;
}): WrappedKeyEnvelope {
  assertNoPrivateKeyMaterial(input.recipientPublicKeyJwk);
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const recipientPublicKey = crypto.createPublicKey({
    key: input.recipientPublicKeyJwk as crypto.JsonWebKey,
    format: 'jwk',
  });
  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientPublicKey,
  });
  const aad = Buffer.from(canonicalJson(input.aad));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveWrapKey(sharedSecret), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(canonicalJson(input.payload))),
    cipher.final(),
  ]);

  return {
    schema: WRAPPED_KEY_ENVELOPE_SCHEMA,
    alg: 'x25519-hkdf-sha256-aes-256-gcm',
    ephemeralPublicKeyJwk: ephemeral.publicKey.export({ format: 'jwk' }) as JsonValue,
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    aadDigest: fingerprintPayload(input.aad),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function unwrapJsonFromX25519Envelope(input: {
  recipientPrivateKeyJwk: JsonValue;
  envelope: WrappedKeyEnvelope;
  aad: JsonValue;
}): JsonValue {
  if (input.envelope.schema !== WRAPPED_KEY_ENVELOPE_SCHEMA) {
    throw new Error('Unsupported wrapped key envelope schema.');
  }
  if (input.envelope.alg !== 'x25519-hkdf-sha256-aes-256-gcm') {
    throw new Error('Unsupported wrapped key envelope algorithm.');
  }
  const expectedAadDigest = fingerprintPayload(input.aad);
  if (input.envelope.aadDigest !== expectedAadDigest) {
    throw new Error('Wrapped key envelope AAD mismatch.');
  }
  const recipientPrivateKey = crypto.createPrivateKey({
    key: input.recipientPrivateKeyJwk as crypto.JsonWebKey,
    format: 'jwk',
  });
  const ephemeralPublicKey = crypto.createPublicKey({
    key: input.envelope.ephemeralPublicKeyJwk as crypto.JsonWebKey,
    format: 'jwk',
  });
  const sharedSecret = crypto.diffieHellman({
    privateKey: recipientPrivateKey,
    publicKey: ephemeralPublicKey,
  });
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveWrapKey(sharedSecret),
    Buffer.from(input.envelope.iv, 'base64url'),
  );
  decipher.setAAD(Buffer.from(canonicalJson(input.aad)));
  decipher.setAuthTag(Buffer.from(input.envelope.tag, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(input.envelope.ciphertext, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as JsonValue;
}

export function assertNoPrivateKeyMaterial(value: JsonValue, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateKeyMaterial(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_JWK_FIELDS.has(key)) {
      throw new Error(`Private key material is not allowed at ${path}.${key}.`);
    }
    assertNoPrivateKeyMaterial(child, `${path}.${key}`);
  }
}

function deriveWrapKey(sharedSecret: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      sharedSecret,
      Buffer.from('viewport-wrapped-key-envelope-salt-v1'),
      Buffer.from('viewport-wrapped-key-envelope/v1'),
      32,
    ),
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!value || typeof value !== 'object') return value;

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) acc[key] = canonicalize(child);
      return acc;
    }, {});
}
