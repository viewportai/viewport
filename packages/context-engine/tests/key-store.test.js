const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { test } = require('node:test');
const {
  ContextVault,
  MacOsKeychainIdentitySecretStore,
  MemoryIdentitySecretStore,
} = require('../src');
const { tempHome } = require('./helpers');

test('identity secret store keeps device private material out of identity JSON files', async () => {
  const home = tempHome('vault-key-store-memory');
  const keyStore = new MemoryIdentitySecretStore();
  const vault = new ContextVault(home, { keyStore });

  vault.createUser({
    userName: 'alice',
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  const request = vault.createDeviceApprovalRequest({
    deviceName: 'alice-laptop',
    code: '123456',
  });

  const pendingRecord = JSON.parse(fs.readFileSync(vault.identityPath('alice-laptop'), 'utf8'));
  assert.equal(pendingRecord.privateKey, undefined);
  assert.equal(pendingRecord.signingPrivateKey, undefined);
  assert.equal(pendingRecord.encryptionPrivateKey, undefined);
  assert.equal(pendingRecord.hpkePrivateKey, undefined);

  const approval = await vault.approveDeviceRequest({
    userName: 'alice',
    request,
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
    code: '123456',
  });
  await vault.acceptDeviceApproval({
    userName: 'alice',
    deviceName: 'alice-laptop',
    approval,
    code: '123456',
  });

  const approvedRecord = JSON.parse(fs.readFileSync(vault.identityPath('alice-laptop'), 'utf8'));
  assert.equal(approvedRecord.privateKey, undefined);
  assert.equal(approvedRecord.signingPrivateKey, undefined);
  assert.equal(approvedRecord.grantEncryptionPrivateKey, undefined);
  assert.equal(approvedRecord.grantHpkePrivateKey, undefined);

  const identity = vault.getIdentity('alice-laptop');
  assert.ok(identity.privateKey);
  assert.ok(identity.grantEncryptionPrivateKey);
  assert.ok(identity.grantHpkePrivateKey);
});

test('macOS keychain store round-trips identity secrets when available', { skip: process.platform !== 'darwin' }, () => {
  const store = new MacOsKeychainIdentitySecretStore({
    namespace: `context-engine-test-${crypto.randomUUID()}`,
    service: 'ai.viewport.context-engine.test',
  });

  try {
    store.setIdentitySecrets('alice-laptop', {
      privateKey: 'private-test-key',
      hpkePrivateKey: 'hpke-test-key',
    });

    assert.deepEqual(store.getIdentitySecrets('alice-laptop'), {
      privateKey: 'private-test-key',
      hpkePrivateKey: 'hpke-test-key',
    });
  } finally {
    store.deleteIdentitySecrets('alice-laptop');
  }
});
