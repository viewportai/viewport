const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createProtocolValidator } = require('../src/protocol/schemas');

const VECTOR_DIR = path.join(__dirname, '..', 'fixtures', 'protocol-vectors');
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

test('draft protocol vectors validate against schemas', () => {
  const validators = createProtocolValidator();

  validateOrThrow(validators.validateKeyGrant, readVector('key-grant.json').grant);
  validateOrThrow(validators.validateEvent, readVector('event.json'));
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
