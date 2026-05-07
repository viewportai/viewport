const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { createIdentity, createRepoKey, wrapKeyForIdentity } = require('../src/crypto/keys');

const KEY_WRAP_SALT = Buffer.from('viewport-context-vault-key-wrap-v1', 'utf8');

function independentDecodeKeyGrant({ grant, recipient }) {
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

test('independent decoder can recover X25519 key grant from documented fields only', () => {
  const recipient = createIdentity('decoder-recipient');
  const repoKey = createRepoKey();
  const grant = wrapKeyForIdentity(repoKey, recipient);
  const decoded = independentDecodeKeyGrant({ grant, recipient });

  assert.equal(decoded.equals(repoKey), true);
  assert.equal(grant.version, 'viewport.context_key_grant/v1');
  assert.equal(grant.encryptedRepoKey.alg, 'x25519-hkdf-sha256+a256gcm');
});
