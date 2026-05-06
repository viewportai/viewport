const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { ContextVault } = require('../src');
const { readAllText, tempHome } = require('./helpers');

async function approveDevice({
  deviceVault,
  deviceName,
  userName,
  approvingVault,
  passphrase,
  recoveryCode,
  code = '654321',
}) {
  const request = deviceVault.createDeviceApprovalRequest({ deviceName, code });
  const approval = await approvingVault.approveDeviceRequest({
    userName,
    request,
    passphrase,
    recoveryCode,
    code,
  });
  return deviceVault.acceptDeviceApproval({ userName, deviceName, approval, code });
}

async function syncInto({ sourceVault, targetVault, repoId, actorName, label }) {
  const syncDir = path.join(tempHome(`vault-user-device-sync-${label}`), 'events');
  sourceVault.exportSync({ repoId, outDir: syncDir });
  await targetVault.importSyncHpke({ repoId, actorName, inDir: syncDir });
}

test('new approved device decrypts existing project history without project-level rewrap', async () => {
  const repoId = 'project-user-device';
  const aliceLaptop = new ContextVault(tempHome('vault-user-device-alice-laptop'));
  const aliceDesktop = new ContextVault(tempHome('vault-user-device-alice-desktop'));

  aliceLaptop.createUser({
    userName: 'alice',
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  await approveDevice({
    deviceVault: aliceLaptop,
    deviceName: 'alice-laptop',
    userName: 'alice',
    approvingVault: aliceLaptop,
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  await aliceLaptop.createRepoHpke(repoId, 'alice', { actorName: 'alice-laptop' });
  aliceLaptop.addEntry({
    repoId,
    actorName: 'alice-laptop',
    scope: 'project',
    title: 'Historical architecture decision',
    body: 'The team standard says auth middleware owns session renewal.',
  });

  await approveDevice({
    deviceVault: aliceDesktop,
    deviceName: 'alice-desktop',
    userName: 'alice',
    approvingVault: aliceLaptop,
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  aliceDesktop.importPublicIdentity(aliceLaptop.exportPublicIdentity('alice'));
  aliceDesktop.importPublicIdentity(aliceLaptop.exportPublicIdentity('alice-laptop'));

  await syncInto({
    sourceVault: aliceLaptop,
    targetVault: aliceDesktop,
    repoId,
    actorName: 'alice-desktop',
    label: 'alice-desktop',
  });

  const results = aliceDesktop.search({
    repoId,
    actorName: 'alice-desktop',
    query: 'session renewal',
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Historical architecture decision');
});

test('device approval code is bound to the HPKE transfer envelope', async () => {
  const aliceLaptop = new ContextVault(tempHome('vault-device-code-alice-laptop'));
  const aliceDesktop = new ContextVault(tempHome('vault-device-code-alice-desktop'));
  aliceLaptop.createUser({
    userName: 'alice',
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });

  const request = aliceDesktop.createDeviceApprovalRequest({
    deviceName: 'alice-desktop',
    code: '111222',
  });

  await assert.rejects(
    () => aliceLaptop.approveDeviceRequest({
      userName: 'alice',
      request,
      passphrase: 'alice-passphrase',
      recoveryCode: 'alice-recovery',
      code: '333444',
    }),
    /code mismatch/,
  );

  const approval = await aliceLaptop.approveDeviceRequest({
    userName: 'alice',
    request,
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
    code: '111222',
  });

  await assert.rejects(
    () => aliceDesktop.acceptDeviceApproval({
      userName: 'alice',
      deviceName: 'alice-desktop',
      approval: { ...approval, approvedAt: '2026-05-06T00:00:00.000Z' },
      code: '111222',
    }),
    /signature invalid/,
  );

  await assert.rejects(
    () => aliceDesktop.acceptDeviceApproval({
      userName: 'alice',
      deviceName: 'alice-desktop',
      approval,
      code: '333444',
    }),
    /code mismatch/,
  );

  const device = await aliceDesktop.acceptDeviceApproval({
    userName: 'alice',
    deviceName: 'alice-desktop',
    approval,
    code: '111222',
  });

  assert.equal(device.deviceState, 'approved');
  assert.equal(device.grantRecipientName, 'alice');
  assert.equal(typeof device.grantHpkePrivateKey, 'string');
});

test('device approval can recover from encrypted user blob without plaintext identity shadow', async () => {
  const aliceHome = tempHome('vault-blob-only-alice');
  const aliceLaptop = new ContextVault(aliceHome);
  const aliceDesktop = new ContextVault(tempHome('vault-blob-only-desktop'));
  aliceLaptop.createUser({
    userName: 'alice',
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  assert.throws(() => aliceLaptop.getIdentity('alice'), /Unknown identity: alice/);

  const device = await approveDevice({
    deviceVault: aliceDesktop,
    deviceName: 'alice-desktop',
    userName: 'alice',
    approvingVault: aliceLaptop,
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });

  assert.equal(device.deviceState, 'approved');
  assert.equal(device.grantRecipientName, 'alice');
  assert.equal(typeof device.grantHpkePrivateKey, 'string');
});

test('user-owned repo events are signed by an approved device, not a plaintext user shadow', async () => {
  const repoId = 'project-device-signer';
  const aliceLaptop = new ContextVault(tempHome('vault-device-signer-alice'));
  aliceLaptop.createUser({
    userName: 'alice',
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  await approveDevice({
    deviceVault: aliceLaptop,
    deviceName: 'alice-laptop',
    userName: 'alice',
    approvingVault: aliceLaptop,
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });

  await assert.rejects(
    () => aliceLaptop.createRepoHpke(repoId, 'alice'),
    /Unknown identity: alice/,
  );

  const repo = await aliceLaptop.createRepoHpke(repoId, 'alice', { actorName: 'alice-laptop' });
  aliceLaptop.addEntry({
    repoId,
    actorName: 'alice-laptop',
    scope: 'project',
    title: 'Device signer rule',
    body: 'User-owned context events are signed by approved devices.',
  });

  const eventText = readAllText(fs.realpathSync(path.join(aliceLaptop.home, 'repos', repoId, 'events')));
  assert.equal(repo.ownerName, 'alice');
  assert.equal(eventText.includes('"actorName": "alice-laptop"'), true);
  assert.equal(eventText.includes('Device signer rule'), false);
});

test('user decryption key material is not written into encrypted event sync', async () => {
  const repoId = 'project-no-key-leak';
  const aliceLaptop = new ContextVault(tempHome('vault-no-key-leak-alice'));
  const bobLaptop = new ContextVault(tempHome('vault-no-key-leak-bob'));
  aliceLaptop.createUser({
    userName: 'alice',
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  await approveDevice({
    deviceVault: aliceLaptop,
    deviceName: 'alice-laptop',
    userName: 'alice',
    approvingVault: aliceLaptop,
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  bobLaptop.createUser({
    userName: 'bob',
    passphrase: 'bob-passphrase',
    recoveryCode: 'bob-recovery',
  });
  await approveDevice({
    deviceVault: bobLaptop,
    deviceName: 'bob-laptop',
    userName: 'bob',
    approvingVault: bobLaptop,
    passphrase: 'bob-passphrase',
    recoveryCode: 'bob-recovery',
  });
  aliceLaptop.importPublicIdentity(bobLaptop.exportPublicIdentity('bob'));
  await aliceLaptop.createRepoHpke(repoId, 'alice', { actorName: 'alice-laptop' });
  await aliceLaptop.grantRepoHpke({ repoId, actorName: 'alice-laptop', recipientName: 'bob' });
  aliceLaptop.addEntry({
    repoId,
    actorName: 'alice-laptop',
    scope: 'project',
    title: 'No key leak rule',
    body: 'Encrypted sync must not include user private key material.',
  });

  const syncDir = path.join(tempHome('vault-no-key-leak-sync'), 'events');
  aliceLaptop.exportSync({ repoId, outDir: syncDir });
  const syncText = readAllText(syncDir);
  const aliceIdentity = aliceLaptop.recoverUserIdentity({
    userName: 'alice',
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });

  assert.equal(syncText.includes(aliceIdentity.hpkePrivateKey), false);
  assert.equal(syncText.includes(aliceIdentity.encryptionPrivateKey), false);
  assert.equal(syncText.includes('No key leak rule'), false);
});

test('rotating user decryption identity blocks compromised device from future context', async () => {
  const repoId = 'project-user-rotation';
  const aliceLaptop = new ContextVault(tempHome('vault-rotate-alice-laptop'));
  const aliceDesktop = new ContextVault(tempHome('vault-rotate-alice-desktop'));
  aliceLaptop.createUser({
    userName: 'alice',
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  await approveDevice({
    deviceVault: aliceLaptop,
    deviceName: 'alice-laptop',
    userName: 'alice',
    approvingVault: aliceLaptop,
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  await approveDevice({
    deviceVault: aliceDesktop,
    deviceName: 'alice-desktop',
    userName: 'alice',
    approvingVault: aliceLaptop,
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  aliceDesktop.importPublicIdentity(aliceLaptop.exportPublicIdentity('alice'));
  aliceDesktop.importPublicIdentity(aliceLaptop.exportPublicIdentity('alice-laptop'));
  await aliceLaptop.createRepoHpke(repoId, 'alice', { actorName: 'alice-laptop' });
  aliceLaptop.addEntry({
    repoId,
    actorName: 'alice-laptop',
    scope: 'project',
    title: 'Before compromise rotation',
    body: 'Old approved devices can read context created before compromise rotation.',
  });
  await syncInto({
    sourceVault: aliceLaptop,
    targetVault: aliceDesktop,
    repoId,
    actorName: 'alice-desktop',
    label: 'desktop-before-rotation',
  });
  assert.equal(
    aliceDesktop.search({ repoId, actorName: 'alice-desktop', query: 'before compromise rotation' }).length,
    1,
  );

  aliceLaptop.rotateUserDecryptionIdentity({
    userName: 'alice',
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  aliceLaptop.revokeRepoHpke({ repoId, actorName: 'alice-laptop', recipientName: 'alice' });
  aliceLaptop.addEntry({
    repoId,
    actorName: 'alice-laptop',
    scope: 'project',
    title: 'After compromise rotation',
    body: 'Only devices with the rotated user decryption identity can read future context.',
  });
  await syncInto({
    sourceVault: aliceLaptop,
    targetVault: aliceDesktop,
    repoId,
    actorName: 'alice-desktop',
    label: 'desktop-after-rotation',
  });

  assert.equal(
    aliceDesktop.search({ repoId, actorName: 'alice-desktop', query: 'future context' }).length,
    0,
  );
});
