const crypto = require('node:crypto');
const path = require('node:path');
const { createIdentity: createCryptoIdentity } = require('../crypto/keys');
const { ensureDir, readJson, writeJson } = require('./files');
const { importPublicIdentity } = require('./identities');

const USER_KEY_BLOB_VERSION = 'viewport.context_user_key_blob/v1';

function usersDir(home) {
  return path.join(home, 'users');
}

function userPath(home, userName) {
  return path.join(usersDir(home), `${userName}.json`);
}

function deriveRecoveryKey({ passphrase, recoveryCode, salt }) {
  return crypto.scryptSync(
    `${passphrase}:${recoveryCode}`,
    Buffer.from(salt, 'base64'),
    32,
    { N: 16384, r: 8, p: 1 },
  );
}

function encryptUserIdentity(identity, { passphrase, recoveryCode }) {
  const salt = crypto.randomBytes(16).toString('base64');
  const iv = crypto.randomBytes(12);
  const key = deriveRecoveryKey({ passphrase, recoveryCode, salt });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(identity), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    version: USER_KEY_BLOB_VERSION,
    kdf: 'scrypt-n16384-r8-p1-sha256',
    salt,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptUserIdentity(blob, { passphrase, recoveryCode }) {
  if (blob.version !== USER_KEY_BLOB_VERSION) {
    throw new Error(`Unsupported user key blob version: ${blob.version}`);
  }

  const key = deriveRecoveryKey({ passphrase, recoveryCode, salt: blob.salt });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, 'base64')),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString('utf8'));
}

function publicUserIdentity(identity) {
  return {
    name: identity.name,
    publicKey: identity.signingPublicKey ?? identity.publicKey,
    signingPublicKey: identity.signingPublicKey ?? identity.publicKey,
    encryptionPublicKey: identity.encryptionPublicKey,
    hpkePublicKey: identity.hpkePublicKey,
  };
}

function createUser(home, { userName, passphrase, recoveryCode }) {
  ensureDir(usersDir(home));
  const identity = createCryptoIdentity(userName);
  const record = {
    userName,
    createdAt: new Date().toISOString(),
    signingPublicKey: identity.signingPublicKey,
    encryptionPublicKey: identity.encryptionPublicKey,
    hpkePublicKey: identity.hpkePublicKey,
    encryptedUserKeyBlob: encryptUserIdentity(identity, { passphrase, recoveryCode }),
  };

  writeJson(userPath(home, userName), record);
  importPublicIdentity(home, publicUserIdentity(identity));
  return record;
}

function rotateUserDecryptionIdentity(home, { userName, passphrase, recoveryCode }) {
  const current = recoverUserIdentity(home, { userName, passphrase, recoveryCode });
  const nextEncryption = createCryptoIdentity(userName);
  const rotated = {
    ...current,
    encryptionPublicKey: nextEncryption.encryptionPublicKey,
    encryptionPrivateKey: nextEncryption.encryptionPrivateKey,
    hpkePublicKey: nextEncryption.hpkePublicKey,
    hpkePrivateKey: nextEncryption.hpkePrivateKey,
  };
  const existing = getUser(home, userName);
  const record = {
    ...existing,
    rotatedAt: new Date().toISOString(),
    encryptionPublicKey: rotated.encryptionPublicKey,
    hpkePublicKey: rotated.hpkePublicKey,
    encryptedUserKeyBlob: encryptUserIdentity(rotated, { passphrase, recoveryCode }),
  };

  writeJson(userPath(home, userName), record);
  importPublicIdentity(home, publicUserIdentity(rotated), { allowKeyRotation: true });
  return record;
}

function getUser(home, userName) {
  const record = readJson(userPath(home, userName));
  if (!record?.encryptedUserKeyBlob) {
    throw new Error(`Unknown user: ${userName}`);
  }

  return record;
}

function recoverUserIdentity(home, { userName, passphrase, recoveryCode }) {
  const record = getUser(home, userName);
  return decryptUserIdentity(record.encryptedUserKeyBlob, { passphrase, recoveryCode });
}

module.exports = {
  createUser,
  decryptUserIdentity,
  encryptUserIdentity,
  getUser,
  publicUserIdentity,
  recoverUserIdentity,
  rotateUserDecryptionIdentity,
  userPath,
};
