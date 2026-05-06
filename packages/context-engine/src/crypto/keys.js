const crypto = require('node:crypto');

const KEY_WRAP_VERSION = 'viewport.context_key_grant/v1';
const KEY_WRAP_ALG = 'x25519-hkdf-sha256+a256gcm';
const KEY_WRAP_SALT = Buffer.from('viewport-context-vault-key-wrap-v1', 'utf8');

function base64UrlToBase64(value) {
  return value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
}

function createIdentity(name) {
  const signing = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const encryption = crypto.generateKeyPairSync('x25519');
  const encryptionPublicJwk = encryption.publicKey.export({ format: 'jwk' });
  const encryptionPrivateJwk = encryption.privateKey.export({ format: 'jwk' });

  return {
    name,
    publicKey: signing.publicKey,
    privateKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey.export({ type: 'spki', format: 'pem' }),
    encryptionPrivateKey: encryption.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    hpkePublicKey: base64UrlToBase64(encryptionPublicJwk.x),
    hpkePrivateKey: base64UrlToBase64(encryptionPrivateJwk.d),
    personalKey: crypto.randomBytes(32).toString('base64'),
  };
}

function createRepoKey() {
  return crypto.randomBytes(32);
}

function deriveWrapKey({ privateKeyPem, publicKeyPem, recipientName, ephemeralPublicKeyPem }) {
  const sharedSecret = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey(privateKeyPem),
    publicKey: crypto.createPublicKey(publicKeyPem),
  });
  const info = Buffer.from(`${KEY_WRAP_VERSION}:${recipientName}:${ephemeralPublicKeyPem}`, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, KEY_WRAP_SALT, info, 32));
}

function encryptRepoKey(repoKey, wrapKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey, iv);
  const ciphertext = Buffer.concat([cipher.update(repoKey), cipher.final()]);
  return {
    alg: KEY_WRAP_ALG,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptRepoKey(encrypted, wrapKey) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', wrapKey, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]);
}

function wrapKeyForIdentity(repoKey, identity) {
  if (!identity.encryptionPublicKey) {
    throw new Error(`Missing encryption public key for ${identity.name}`);
  }

  const ephemeral = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const wrapKey = deriveWrapKey({
    privateKeyPem: ephemeral.privateKey,
    publicKeyPem: identity.encryptionPublicKey,
    recipientName: identity.name,
    ephemeralPublicKeyPem: ephemeral.publicKey,
  });

  return {
    version: KEY_WRAP_VERSION,
    recipientName: identity.name,
    ephemeralPublicKey: ephemeral.publicKey,
    encryptedRepoKey: encryptRepoKey(repoKey, wrapKey),
  };
}

function unwrapKeyForIdentity(wrappedKey, identity) {
  if (!identity.encryptionPrivateKey) {
    throw new Error(`Missing encryption private key for ${identity.name}`);
  }

  if (wrappedKey.version !== KEY_WRAP_VERSION) {
    throw new Error(`Unsupported key grant version: ${wrappedKey.version}`);
  }

  if (wrappedKey.recipientName !== identity.name) {
    throw new Error(`Key grant belongs to ${wrappedKey.recipientName}, not ${identity.name}`);
  }

  const wrapKey = deriveWrapKey({
    privateKeyPem: identity.encryptionPrivateKey,
    publicKeyPem: wrappedKey.ephemeralPublicKey,
    recipientName: identity.name,
    ephemeralPublicKeyPem: wrappedKey.ephemeralPublicKey,
  });

  return decryptRepoKey(wrappedKey.encryptedRepoKey, wrapKey);
}

module.exports = {
  KEY_WRAP_ALG,
  KEY_WRAP_VERSION,
  createIdentity,
  createRepoKey,
  unwrapKeyForIdentity,
  wrapKeyForIdentity,
};
