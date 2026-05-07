const path = require('node:path');
const { createIdentity: createCryptoIdentity } = require('../crypto/keys');
const { listJsonFiles, readJson, writeJson } = require('./files');
const {
  hasIdentitySecrets,
  mergeIdentitySecrets,
  splitIdentitySecrets,
} = require('./key-store');

function createIdentity(home, name, { keyStore = null } = {}) {
  const identity = createCryptoIdentity(name);
  writeIdentity(home, name, identity, { keyStore });
  return identity;
}

function getIdentity(home, name, { keyStore = null } = {}) {
  const publicRecord = readJson(identityPath(home, name));
  if (!publicRecord) {
    throw new Error(`Unknown identity: ${name}`);
  }

  const identity = keyStore
    ? mergeIdentitySecrets(publicRecord, keyStore.getIdentitySecrets(name))
    : publicRecord;

  if (!identity?.privateKey) {
    throw new Error(`Unknown identity: ${name}`);
  }
  return identity;
}

function getKnownIdentity(home, name) {
  const identity = readJson(identityPath(home, name));
  if (!identity?.publicKey) {
    throw new Error(`Unknown identity: ${name}`);
  }
  return identity;
}

function exportPublicIdentity(home, name) {
  const identity = getKnownIdentity(home, name);
  return {
    name: identity.name,
    publicKey: identity.signingPublicKey ?? identity.publicKey,
    signingPublicKey: identity.signingPublicKey ?? identity.publicKey,
    encryptionPublicKey: identity.encryptionPublicKey,
    hpkePublicKey: identity.hpkePublicKey,
  };
}

function importPublicIdentity(home, identity, { allowKeyRotation = false } = {}) {
  const existing = readJson(identityPath(home, identity.name), {});
  const nextSigningKey = identity.signingPublicKey ?? identity.publicKey;

  if (existing.signingPublicKey && existing.signingPublicKey !== nextSigningKey) {
    throw new Error(`Identity signing key changed for ${identity.name}; explicit key rotation is required`);
  }

  if (!allowKeyRotation && existing.encryptionPublicKey && existing.encryptionPublicKey !== identity.encryptionPublicKey) {
    throw new Error(`Identity encryption key changed for ${identity.name}; explicit key rotation is required`);
  }

  if (!allowKeyRotation && existing.hpkePublicKey && existing.hpkePublicKey !== identity.hpkePublicKey) {
    throw new Error(`Identity HPKE key changed for ${identity.name}; explicit key rotation is required`);
  }

  writeJson(identityPath(home, identity.name), {
    ...existing,
    name: identity.name,
    publicKey: nextSigningKey,
    signingPublicKey: nextSigningKey,
    encryptionPublicKey: identity.encryptionPublicKey,
    hpkePublicKey: identity.hpkePublicKey,
    grantRecipientName: identity.grantRecipientName ?? existing.grantRecipientName,
  });
}

function updateIdentity(home, name, patch, { keyStore = null } = {}) {
  let current = {};
  try {
    current = getIdentity(home, name, { keyStore });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Unknown identity:')) {
      throw error;
    }
  }
  const next = { ...current, ...patch };
  writeIdentity(home, name, next, { keyStore });
  return getIdentity(home, name, { keyStore });
}

function writeIdentity(home, name, identity, { keyStore = null } = {}) {
  if (!keyStore) {
    writeJson(identityPath(home, name), identity);
    return;
  }

  const { publicRecord, secrets } = splitIdentitySecrets(identity);
  if (hasIdentitySecrets(secrets)) {
    keyStore.setIdentitySecrets(name, secrets);
  }
  writeJson(identityPath(home, name), publicRecord);
}

function identityPath(home, name) {
  return path.join(home, 'identities', `${name}.json`);
}

function loadPublicKeys(home) {
  const publicKeys = new Map();
  for (const file of listJsonFiles(path.join(home, 'identities'))) {
    const identity = readJson(file);
    publicKeys.set(identity.name, identity.signingPublicKey ?? identity.publicKey);
  }
  return publicKeys;
}

module.exports = {
  createIdentity,
  exportPublicIdentity,
  getIdentity,
  getKnownIdentity,
  identityPath,
  importPublicIdentity,
  loadPublicKeys,
  updateIdentity,
  writeIdentity,
};
