const path = require('node:path');
const { createIdentity: createCryptoIdentity } = require('../crypto/keys');
const { listJsonFiles, readJson, writeJson } = require('./files');

function createIdentity(home, name) {
  const identity = createCryptoIdentity(name);
  writeJson(identityPath(home, name), identity);
  return identity;
}

function getIdentity(home, name) {
  const identity = readJson(identityPath(home, name));
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
};
