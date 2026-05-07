const { spawnSync } = require('node:child_process');

const PRIVATE_IDENTITY_FIELDS = [
  'privateKey',
  'signingPrivateKey',
  'encryptionPrivateKey',
  'hpkePrivateKey',
  'personalKey',
  'grantEncryptionPrivateKey',
  'grantHpkePrivateKey',
];

function splitIdentitySecrets(identity) {
  const publicRecord = { ...identity };
  const secrets = {};

  for (const field of PRIVATE_IDENTITY_FIELDS) {
    if (publicRecord[field] !== undefined) {
      secrets[field] = publicRecord[field];
      delete publicRecord[field];
    }
  }

  return { publicRecord, secrets };
}

function hasIdentitySecrets(secrets) {
  return Object.keys(secrets).length > 0;
}

function mergeIdentitySecrets(publicRecord, secrets = {}) {
  return { ...publicRecord, ...secrets };
}

class MemoryIdentitySecretStore {
  constructor() {
    this.records = new Map();
  }

  setIdentitySecrets(name, secrets) {
    this.records.set(name, { ...secrets });
  }

  getIdentitySecrets(name) {
    const secrets = this.records.get(name);
    if (!secrets) {
      throw new Error(`Missing identity secrets for ${name}`);
    }
    return { ...secrets };
  }

  deleteIdentitySecrets(name) {
    this.records.delete(name);
  }
}

class MacOsKeychainIdentitySecretStore {
  constructor({ service = 'ai.viewport.context-engine', namespace = 'default' } = {}) {
    this.service = service;
    this.namespace = namespace;
  }

  setIdentitySecrets(name, secrets) {
    const account = this.account(name);
    runSecurity(['delete-generic-password', '-a', account, '-s', this.service], {
      allowFailure: true,
    });
    runSecurity([
      'add-generic-password',
      '-a',
      account,
      '-s',
      this.service,
      '-w',
      JSON.stringify(secrets),
      '-U',
    ]);
  }

  getIdentitySecrets(name) {
    const result = runSecurity([
      'find-generic-password',
      '-a',
      this.account(name),
      '-s',
      this.service,
      '-w',
    ]);
    return JSON.parse(result.stdout.trim());
  }

  deleteIdentitySecrets(name) {
    runSecurity(['delete-generic-password', '-a', this.account(name), '-s', this.service], {
      allowFailure: true,
    });
  }

  account(name) {
    return `${this.namespace}:${name}`;
  }
}

function runSecurity(args, { allowFailure = false } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS Keychain context key store is only available on darwin');
  }

  const result = spawnSync('security', args, {
    encoding: 'utf8',
  });

  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`macOS Keychain command failed: ${detail || `security ${args[0]}`}`);
  }

  return result;
}

module.exports = {
  MacOsKeychainIdentitySecretStore,
  MemoryIdentitySecretStore,
  hasIdentitySecrets,
  mergeIdentitySecrets,
  splitIdentitySecrets,
};
