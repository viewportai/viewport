const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { canonicalize } = require('../src/crypto/canonical');
const { createProtocolValidator } = require('../src/protocol/schemas');

const VECTOR_DIR = path.join(__dirname, '..', 'fixtures', 'protocol-vectors');
const execFileAsync = promisify(execFile);
const KEY_WRAP_SALT = Buffer.from('viewport-context-vault-key-wrap-v1', 'utf8');

function readVector(name) {
  return JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, name), 'utf8'));
}

function validateOrThrow(validate, value) {
  const valid = validate(value);
  assert.equal(valid, true, JSON.stringify(validate.errors, null, 2));
}

function decodeKeyGrant({ grant, recipient }) {
  const sharedSecret = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey(recipient.encryptionPrivateKey),
    publicKey: crypto.createPublicKey(grant.ephemeralPublicKey),
  });
  const info = Buffer.from(`${grant.version}:${recipient.name}:${grant.ephemeralPublicKey}`, 'utf8');
  const wrapKey = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, KEY_WRAP_SALT, info, 32));
  const encrypted = grant.encryptedRepoKey;
  const decipher = crypto.createDecipheriv('aes-256-gcm', wrapKey, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]);
}

async function decodeHpkeKeyGrant({ grant, recipient }) {
  const { Aes256Gcm, CipherSuite, HkdfSha256 } = await import('@hpke/core');
  const { DhkemX25519HkdfSha256 } = await import('@hpke/dhkem-x25519');
  const suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
  const privateKey = await suite.kem.deserializePrivateKey(Buffer.from(recipient.hpkePrivateKey, 'base64'));
  const info = Buffer.from(canonicalize({
    purpose: 'viewport-context-repo-key-grant',
    version: grant.version,
    recipientName: grant.recipientName,
    repoId: grant.repoId,
    keyEpoch: grant.keyEpoch,
    suite: grant.suite,
  }), 'utf8');
  const aad = Buffer.from(canonicalize({
    version: grant.version,
    recipientName: grant.recipientName,
    repoId: grant.repoId,
    keyEpoch: grant.keyEpoch,
  }), 'utf8');
  const expectedAadDigest = `sha256:${crypto.createHash('sha256').update(aad).digest('hex')}`;
  assert.equal(grant.aadDigest, expectedAadDigest);

  const recipientContext = await suite.createRecipientContext({
    recipientKey: privateKey,
    enc: Buffer.from(grant.enc, 'base64'),
    info,
  });

  return Buffer.from(await recipientContext.open(Buffer.from(grant.ciphertext, 'base64'), aad));
}

function verifySignedEventVector({ actor, event }) {
  const { signature, ...unsignedEvent } = event;

  return crypto.verify(
    null,
    Buffer.from(canonicalize(unsignedEvent)),
    actor.signingPublicKey,
    Buffer.from(signature, 'base64'),
  );
}

test('draft protocol vectors validate against schemas', () => {
  const validators = createProtocolValidator();

  validateOrThrow(validators.validateKeyGrant, readVector('key-grant.json').grant);
  validateOrThrow(validators.validateKeyGrantHpkeDraft, readVector('hpke-key-grant.json').grant);
  validateOrThrow(validators.validateEvent, readVector('event.json'));
  validateOrThrow(validators.validateEvent, readVector('signed-event.json').event);
  validateOrThrow(validators.validateBundleManifest, readVector('bundle-manifest.json'));
  validateOrThrow(validators.validateProfile, readVector('profile.json'));
  validateOrThrow(validators.validateEraseReceipt, readVector('erase-receipt.json'));
});

test('draft key grant vector can be decoded from documented fields', () => {
  const vector = readVector('key-grant.json');
  const decodedRepoKey = decodeKeyGrant(vector);
  const decodedDigest = `sha256:${crypto.createHash('sha256').update(decodedRepoKey).digest('hex')}`;

  assert.equal(decodedDigest, vector.expectedRepoKeyDigest);
});

test('HPKE draft key grant vector can be decoded from documented fields', async () => {
  const vector = readVector('hpke-key-grant.json');
  const decodedRepoKey = await decodeHpkeKeyGrant(vector);
  const decodedDigest = `sha256:${crypto.createHash('sha256').update(decodedRepoKey).digest('hex')}`;

  assert.equal(decodedDigest, vector.expectedRepoKeyDigest);
});

test('signed event vector verifies from canonical JSON and public key only', () => {
  const vector = readVector('signed-event.json');

  assert.equal(verifySignedEventVector(vector), true);

  const tampered = structuredClone(vector);
  tampered.event.payloadDigest = `sha256:${'0'.repeat(64)}`;
  assert.equal(verifySignedEventVector(tampered), false);
});

test('standalone decoder validates protocol vectors without importing engine source', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(VECTOR_DIR, 'standalone-decoder.mjs')],
    { cwd: path.join(__dirname, '..') },
  );
  const result = JSON.parse(stdout);

  assert.equal(result.schemaVersion, 'viewport.context_protocol_standalone_decoder_result/v1');
  assert.equal(result.hpke_key_grant.ok, true);
  assert.equal(
    result.hpke_key_grant.repo_key_digest,
    readVector('hpke-key-grant.json').expectedRepoKeyDigest,
  );
  assert.equal(result.signed_event.ok, true);
  assert.equal(result.signed_event.tamper_rejected, true);
});
