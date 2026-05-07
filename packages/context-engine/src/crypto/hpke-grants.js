const crypto = require('node:crypto');

const HPKE_KEY_GRANT_VERSION = 'viewport.context_key_grant/hpke-draft-01';
const HPKE_SUITE = Object.freeze({
  kem: 'DHKEM_X25519_HKDF_SHA256',
  kdf: 'HKDF_SHA256',
  aead: 'AES_256_GCM',
});

let cachedSuite;

function toBase64(value) {
  return Buffer.from(value).toString('base64');
}

function fromBase64(value) {
  return Buffer.from(value, 'base64');
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

async function loadSuite() {
  if (cachedSuite) {
    return cachedSuite;
  }

  const { Aes256Gcm, CipherSuite, HkdfSha256 } = await import('@hpke/core');
  const { DhkemX25519HkdfSha256 } = await import('@hpke/dhkem-x25519');

  cachedSuite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });

  return cachedSuite;
}

function grantInfo({ recipientName, repoId = 'unknown-repo', keyEpoch = 1 }) {
  return Buffer.from(stableJson({
    purpose: 'viewport-context-repo-key-grant',
    version: HPKE_KEY_GRANT_VERSION,
    recipientName,
    repoId,
    keyEpoch,
    suite: HPKE_SUITE,
  }), 'utf8');
}

function grantAad({ recipientName, repoId = 'unknown-repo', keyEpoch = 1 }) {
  return Buffer.from(stableJson({
    version: HPKE_KEY_GRANT_VERSION,
    recipientName,
    repoId,
    keyEpoch,
  }), 'utf8');
}

function genericAad({ purpose, recipientName, context = {} }) {
  return Buffer.from(stableJson({
    purpose,
    recipientName,
    context,
  }), 'utf8');
}

function assertSupportedSuite(grant) {
  if (stableJson(grant.suite) !== stableJson(HPKE_SUITE)) {
    throw new Error(`Unsupported HPKE suite: ${stableJson(grant.suite)}`);
  }
}

async function createHpkeIdentity(name) {
  const suite = await loadSuite();
  const keyPair = await suite.kem.generateKeyPair();

  return {
    name,
    hpkePublicKey: toBase64(await suite.kem.serializePublicKey(keyPair.publicKey)),
    hpkePrivateKey: toBase64(await suite.kem.serializePrivateKey(keyPair.privateKey)),
  };
}

async function wrapRepoKeyWithHpke(repoKey, recipient, options = {}) {
  if (!Buffer.isBuffer(repoKey) || repoKey.byteLength !== 32) {
    throw new Error('HPKE repo key grants require a 32-byte repo key');
  }

  if (!recipient.hpkePublicKey) {
    throw new Error(`Missing HPKE public key for ${recipient.name}`);
  }

  const suite = await loadSuite();
  const recipientPublicKey = await suite.kem.deserializePublicKey(fromBase64(recipient.hpkePublicKey));
  const recipientName = recipient.name;
  const repoId = options.repoId ?? 'unknown-repo';
  const keyEpoch = options.keyEpoch ?? 1;
  const info = grantInfo({ recipientName, repoId, keyEpoch });
  const aad = grantAad({ recipientName, repoId, keyEpoch });
  const sender = await suite.createSenderContext({ recipientPublicKey, info });
  const ciphertext = await sender.seal(Buffer.from(repoKey), aad);

  return {
    version: HPKE_KEY_GRANT_VERSION,
    recipientName,
    repoId,
    keyEpoch,
    suite: HPKE_SUITE,
    enc: toBase64(sender.enc),
    ciphertext: toBase64(ciphertext),
    aadDigest: `sha256:${crypto.createHash('sha256').update(aad).digest('hex')}`,
  };
}

async function sealBytesWithHpke(plaintext, recipient, options = {}) {
  if (!Buffer.isBuffer(plaintext)) {
    throw new Error('HPKE byte sealing requires a Buffer plaintext');
  }

  if (!recipient.hpkePublicKey) {
    throw new Error(`Missing HPKE public key for ${recipient.name}`);
  }

  const suite = await loadSuite();
  const recipientPublicKey = await suite.kem.deserializePublicKey(fromBase64(recipient.hpkePublicKey));
  const recipientName = recipient.name;
  const purpose = options.purpose ?? 'viewport-context-sealed-bytes';
  const context = options.context ?? {};
  const info = Buffer.from(stableJson({
    purpose,
    version: 'viewport.hpke_sealed_bytes/draft-01',
    recipientName,
    suite: HPKE_SUITE,
  }), 'utf8');
  const aad = genericAad({ purpose, recipientName, context });
  const sender = await suite.createSenderContext({ recipientPublicKey, info });
  const ciphertext = await sender.seal(plaintext, aad);

  return {
    version: 'viewport.hpke_sealed_bytes/draft-01',
    recipientName,
    purpose,
    context,
    suite: HPKE_SUITE,
    enc: toBase64(sender.enc),
    ciphertext: toBase64(ciphertext),
    aadDigest: `sha256:${crypto.createHash('sha256').update(aad).digest('hex')}`,
  };
}

async function unwrapRepoKeyWithHpke(grant, recipient, options = {}) {
  if (!recipient.hpkePrivateKey) {
    throw new Error(`Missing HPKE private key for ${recipient.name}`);
  }

  if (grant.version !== HPKE_KEY_GRANT_VERSION) {
    throw new Error(`Unsupported HPKE key grant version: ${grant.version}`);
  }

  if (grant.recipientName !== recipient.name) {
    throw new Error(`HPKE key grant belongs to ${grant.recipientName}, not ${recipient.name}`);
  }

  if (options.expectedRepoId && grant.repoId !== options.expectedRepoId) {
    throw new Error(`HPKE key grant belongs to repo ${grant.repoId}, not ${options.expectedRepoId}`);
  }

  if (options.expectedKeyEpoch && grant.keyEpoch !== options.expectedKeyEpoch) {
    throw new Error(`HPKE key grant belongs to epoch ${grant.keyEpoch}, not ${options.expectedKeyEpoch}`);
  }

  assertSupportedSuite(grant);

  const suite = await loadSuite();
  const recipientPrivateKey = await suite.kem.deserializePrivateKey(fromBase64(recipient.hpkePrivateKey));
  const info = grantInfo({
    recipientName: grant.recipientName,
    repoId: grant.repoId,
    keyEpoch: grant.keyEpoch,
  });
  const aad = grantAad({
    recipientName: grant.recipientName,
    repoId: grant.repoId,
    keyEpoch: grant.keyEpoch,
  });
  const expectedAadDigest = `sha256:${crypto.createHash('sha256').update(aad).digest('hex')}`;
  if (grant.aadDigest !== expectedAadDigest) {
    throw new Error('HPKE key grant AAD digest mismatch');
  }
  const recipientContext = await suite.createRecipientContext({
    recipientKey: recipientPrivateKey,
    enc: fromBase64(grant.enc),
    info,
  });

  return Buffer.from(await recipientContext.open(fromBase64(grant.ciphertext), aad));
}

async function openBytesWithHpke(envelope, recipient, options = {}) {
  if (!recipient.hpkePrivateKey) {
    throw new Error(`Missing HPKE private key for ${recipient.name}`);
  }

  if (envelope.version !== 'viewport.hpke_sealed_bytes/draft-01') {
    throw new Error(`Unsupported HPKE sealed bytes version: ${envelope.version}`);
  }

  if (envelope.recipientName !== recipient.name) {
    throw new Error(`HPKE sealed bytes belong to ${envelope.recipientName}, not ${recipient.name}`);
  }

  if (options.expectedPurpose && envelope.purpose !== options.expectedPurpose) {
    throw new Error(`HPKE sealed bytes purpose is ${envelope.purpose}, not ${options.expectedPurpose}`);
  }

  assertSupportedSuite(envelope);

  const suite = await loadSuite();
  const recipientPrivateKey = await suite.kem.deserializePrivateKey(fromBase64(recipient.hpkePrivateKey));
  const purpose = envelope.purpose;
  const recipientName = envelope.recipientName;
  const info = Buffer.from(stableJson({
    purpose,
    version: envelope.version,
    recipientName,
    suite: envelope.suite,
  }), 'utf8');
  const aad = genericAad({ purpose, recipientName, context: envelope.context ?? {} });
  const expectedAadDigest = `sha256:${crypto.createHash('sha256').update(aad).digest('hex')}`;
  if (envelope.aadDigest !== expectedAadDigest) {
    throw new Error('HPKE sealed bytes AAD digest mismatch');
  }

  const recipientContext = await suite.createRecipientContext({
    recipientKey: recipientPrivateKey,
    enc: fromBase64(envelope.enc),
    info,
  });

  return Buffer.from(await recipientContext.open(fromBase64(envelope.ciphertext), aad));
}

async function runHpkeGrantProof() {
  const bob = await createHpkeIdentity('bob');
  const carol = await createHpkeIdentity('carol');
  const repoKey = crypto.randomBytes(32);
  const grant = await wrapRepoKeyWithHpke(repoKey, bob, {
    repoId: 'project-api',
    keyEpoch: 7,
  });
  const recovered = await unwrapRepoKeyWithHpke(grant, bob);
  let wrongRecipientRejected = false;
  try {
    await unwrapRepoKeyWithHpke(grant, carol);
  } catch {
    wrongRecipientRejected = true;
  }

  const tampered = structuredClone(grant);
  tampered.ciphertext = `${tampered.ciphertext.slice(0, -1)}${tampered.ciphertext.endsWith('A') ? 'B' : 'A'}`;
  let tamperRejected = false;
  try {
    await unwrapRepoKeyWithHpke(tampered, bob);
  } catch {
    tamperRejected = true;
  }

  return {
    grant,
    recipient: bob,
    expectedRepoKeyDigest: `sha256:${crypto.createHash('sha256').update(repoKey).digest('hex')}`,
    intendedRecipientRecovered: recovered.equals(repoKey),
    wrongRecipientRejected,
    tamperRejected,
    pass: recovered.equals(repoKey) && wrongRecipientRejected && tamperRejected,
  };
}

module.exports = {
  HPKE_KEY_GRANT_VERSION,
  HPKE_SUITE,
  createHpkeIdentity,
  openBytesWithHpke,
  runHpkeGrantProof,
  sealBytesWithHpke,
  unwrapRepoKeyWithHpke,
  wrapRepoKeyWithHpke,
};
