const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { ContextVault } = require('../src');
const { ContextAccessModel } = require('../src/repo/access-model');
const { tempHome } = require('./helpers');

function createDevice(deviceName) {
  const vault = new ContextVault(tempHome(`vault-access-${deviceName}`));
  return vault;
}

async function createApprovedDevice({
  deviceVault,
  deviceName,
  userName,
  approvingVault,
  passphrase,
  recoveryCode,
  code = '123456',
}) {
  const request = deviceVault.createDeviceApprovalRequest({ deviceName, code });
  const approval = await approvingVault.approveDeviceRequest({
    userName,
    request,
    passphrase,
    recoveryCode,
    code,
  });
  await deviceVault.acceptDeviceApproval({ userName, deviceName, approval, code });
  deviceVault.importPublicIdentity(approvingVault.exportPublicIdentity(userName));
  return deviceVault;
}

function trustSigner(deviceVault, signerVault, signerName) {
  deviceVault.importPublicIdentity(signerVault.exportPublicIdentity(signerName));
}

async function syncToDevice({ sourceVault, peerVault = null, deviceVault, repoId, deviceName, label }) {
  const syncDir = path.join(tempHome(`vault-access-sync-${label}`), 'events');
  (sourceVault ?? peerVault).exportSync({ repoId, outDir: syncDir });
  await deviceVault.importSyncHpke({ repoId, actorName: deviceName, inDir: syncDir });
}

test('resource ACL grants context to approved devices for current and future members', async () => {
  const repoId = 'resource-acl';
  const aliceLaptop = createDevice('alice-laptop');
  const aliceDesktop = createDevice('alice-desktop');
  const bobLaptop = createDevice('bob-laptop');
  const carolLaptop = createDevice('carol-laptop');
  const daveLaptop = createDevice('dave-laptop');
  const erinLaptop = createDevice('erin-laptop');

  aliceLaptop.createUser({
    userName: 'alice',
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  await createApprovedDevice({
    deviceVault: aliceLaptop,
    deviceName: 'alice-laptop',
    userName: 'alice',
    approvingVault: aliceLaptop,
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  await aliceLaptop.createRepoHpke(repoId, 'alice', { actorName: 'alice-laptop' });
  const access = new ContextAccessModel({
    peerVault: aliceLaptop,
    repoId,
    peerActorName: 'alice-laptop',
  });

  for (const [userName, deviceName, deviceVault] of [
    ['alice', 'alice-desktop', aliceDesktop],
    ['bob', 'bob-laptop', bobLaptop],
    ['carol', 'carol-laptop', carolLaptop],
    ['dave', 'dave-laptop', daveLaptop],
    ['erin', 'erin-laptop', erinLaptop],
  ]) {
    if (userName !== 'alice') {
      deviceVault.createUser({
        userName,
        passphrase: `${userName}-passphrase`,
        recoveryCode: `${userName}-recovery`,
      });
      aliceLaptop.importPublicIdentity(deviceVault.exportPublicIdentity(userName));
    }
    await createApprovedDevice({
      deviceVault,
      deviceName,
      userName,
      approvingVault: userName === 'alice' ? aliceLaptop : deviceVault,
      passphrase: `${userName}-passphrase`,
      recoveryCode: `${userName}-recovery`,
    });
    trustSigner(deviceVault, aliceLaptop, 'alice');
    trustSigner(deviceVault, aliceLaptop, 'alice-laptop');
  }

  access.addMember('alice');
  access.addMember('bob');
  access.addMember('carol');
  access.approveDevice({ userName: 'alice', deviceName: 'alice-laptop' });
  access.approveDevice({ userName: 'bob', deviceName: 'bob-laptop' });
  access.approveDevice({ userName: 'carol', deviceName: 'carol-laptop' });
  access.denyDevice({ userName: 'alice', deviceName: 'alice-desktop' });

  aliceLaptop.addEntry({
    repoId,
    actorName: 'alice-laptop',
    scope: 'resource',
    title: 'Resource history rule',
    body: 'All active resource members should receive approved historical resource context.',
  });

  assert.deepEqual(access.accessDecision({ userName: 'alice', deviceName: 'alice-desktop' }), {
    allowed: false,
    pending: false,
    reason: 'device_not_approved',
    epochs: [],
  });

  access.approveDevice({ userName: 'alice', deviceName: 'alice-desktop' });
  assert.equal(access.accessDecision({ userName: 'alice', deviceName: 'alice-desktop' }).pending, false);
  assert.equal(access.accessDecision({ userName: 'alice', deviceName: 'alice-desktop' }).reason, 'ready');
  await access.ensureAccess({ userName: 'alice', deviceName: 'alice-desktop' });
  await access.ensureAccess({ userName: 'bob', deviceName: 'bob-laptop' });
  await access.ensureAccess({ userName: 'carol', deviceName: 'carol-laptop' });

  await syncToDevice({
    peerVault: aliceLaptop,
    deviceVault: aliceDesktop,
    repoId,
    deviceName: 'alice-desktop',
    label: 'alice-desktop-history',
  });
  await syncToDevice({
    peerVault: aliceLaptop,
    deviceVault: bobLaptop,
    repoId,
    deviceName: 'bob-laptop',
    label: 'bob-history',
  });
  await syncToDevice({
    peerVault: aliceLaptop,
    deviceVault: carolLaptop,
    repoId,
    deviceName: 'carol-laptop',
    label: 'carol-history',
  });

  assert.equal(aliceDesktop.search({ repoId, actorName: 'alice-desktop', query: 'historical resource context' }).length, 1);
  assert.equal(bobLaptop.search({ repoId, actorName: 'bob-laptop', query: 'historical resource context' }).length, 1);
  assert.equal(carolLaptop.search({ repoId, actorName: 'carol-laptop', query: 'historical resource context' }).length, 1);

  access.addMember('dave', { history: 'full' });
  access.approveDevice({ userName: 'dave', deviceName: 'dave-laptop' });
  assert.equal(access.accessDecision({ userName: 'dave', deviceName: 'dave-laptop' }).reason, 'key_delivery_pending');
  await access.ensureAccess({ userName: 'dave', deviceName: 'dave-laptop' });
  await syncToDevice({
    peerVault: aliceLaptop,
    deviceVault: daveLaptop,
    repoId,
    deviceName: 'dave-laptop',
    label: 'dave-history',
  });
  assert.equal(daveLaptop.search({ repoId, actorName: 'dave-laptop', query: 'historical resource context' }).length, 1);

  access.addMember('erin', { history: 'join_date' });
  access.approveDevice({ userName: 'erin', deviceName: 'erin-laptop' });
  await access.ensureAccess({ userName: 'erin', deviceName: 'erin-laptop' });
  await syncToDevice({
    peerVault: aliceLaptop,
    deviceVault: erinLaptop,
    repoId,
    deviceName: 'erin-laptop',
    label: 'erin-before-future',
  });
  assert.equal(erinLaptop.search({ repoId, actorName: 'erin-laptop', query: 'historical resource context' }).length, 0);

  aliceLaptop.addEntry({
    repoId,
    actorName: 'alice-laptop',
    scope: 'resource',
    title: 'Join date rule',
    body: 'Join-date members can read context created after their membership epoch.',
  });
  await syncToDevice({
    peerVault: aliceLaptop,
    deviceVault: erinLaptop,
    repoId,
    deviceName: 'erin-laptop',
    label: 'erin-future',
  });
  assert.equal(erinLaptop.search({ repoId, actorName: 'erin-laptop', query: 'membership epoch' }).length, 1);

  access.removeMember('bob');
  aliceLaptop.addEntry({
    repoId,
    actorName: 'alice-laptop',
    scope: 'resource',
    title: 'Post-removal rule',
    body: 'Removed members must not decrypt resource context created after removal.',
  });
  await syncToDevice({
    peerVault: aliceLaptop,
    deviceVault: bobLaptop,
    repoId,
    deviceName: 'bob-laptop',
    label: 'bob-after-removal',
  });

  assert.equal(access.accessDecision({ userName: 'bob', deviceName: 'bob-laptop' }).reason, 'acl_denied');
  assert.equal(bobLaptop.search({ repoId, actorName: 'bob-laptop', query: 'after removal' }).length, 0);
  assert.equal(bobLaptop.search({ repoId, actorName: 'bob-laptop', query: 'historical resource context' }).length, 1);
});

test('any authorized peer can fulfill a missing user grant', async () => {
  const repoId = 'resource-peer-grantor';
  const aliceLaptop = createDevice('alice-peer-laptop');
  const bobLaptop = createDevice('bob-peer-laptop');
  const erinLaptop = createDevice('erin-peer-laptop');

  aliceLaptop.createUser({
    userName: 'alice',
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  await createApprovedDevice({
    deviceVault: aliceLaptop,
    deviceName: 'alice-laptop',
    userName: 'alice',
    approvingVault: aliceLaptop,
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  await aliceLaptop.createRepoHpke(repoId, 'alice', { actorName: 'alice-laptop' });
  bobLaptop.createUser({
    userName: 'bob',
    passphrase: 'bob-passphrase',
    recoveryCode: 'bob-recovery',
  });
  await createApprovedDevice({
    deviceVault: bobLaptop,
    deviceName: 'bob-laptop',
    userName: 'bob',
    approvingVault: bobLaptop,
    passphrase: 'bob-passphrase',
    recoveryCode: 'bob-recovery',
  });
  erinLaptop.createUser({
    userName: 'erin',
    passphrase: 'erin-passphrase',
    recoveryCode: 'erin-recovery',
  });
  await createApprovedDevice({
    deviceVault: erinLaptop,
    deviceName: 'erin-laptop',
    userName: 'erin',
    approvingVault: erinLaptop,
    passphrase: 'erin-passphrase',
    recoveryCode: 'erin-recovery',
  });

  aliceLaptop.importPublicIdentity(bobLaptop.exportPublicIdentity('bob'));
  aliceLaptop.importPublicIdentity(erinLaptop.exportPublicIdentity('erin'));
  bobLaptop.importPublicIdentity(aliceLaptop.exportPublicIdentity('alice'));
  bobLaptop.importPublicIdentity(aliceLaptop.exportPublicIdentity('alice-laptop'));
  bobLaptop.importPublicIdentity(erinLaptop.exportPublicIdentity('erin'));
  erinLaptop.importPublicIdentity(aliceLaptop.exportPublicIdentity('alice'));
  erinLaptop.importPublicIdentity(aliceLaptop.exportPublicIdentity('alice-laptop'));
  erinLaptop.importPublicIdentity(bobLaptop.exportPublicIdentity('bob-laptop'));

  const aliceAccess = new ContextAccessModel({
    peerVault: aliceLaptop,
    repoId,
    peerActorName: 'alice-laptop',
  });
  aliceAccess.addMember('alice');
  aliceAccess.addMember('bob');
  aliceAccess.approveDevice({ userName: 'alice', deviceName: 'alice-laptop' });
  aliceAccess.approveDevice({ userName: 'bob', deviceName: 'bob-laptop' });
  await aliceAccess.ensureAccess({ userName: 'bob', deviceName: 'bob-laptop' });
  aliceLaptop.addEntry({
    repoId,
    actorName: 'alice-laptop',
    scope: 'resource',
    title: 'Peer grantor rule',
    body: 'Any authorized peer can deliver missing user grants.',
  });
  await syncToDevice({
    sourceVault: aliceLaptop,
    deviceVault: bobLaptop,
    repoId,
    deviceName: 'bob-laptop',
    label: 'bob-peer-ready',
  });

  const bobAccess = new ContextAccessModel({
    peerVault: bobLaptop,
    repoId,
    peerActorName: 'bob-laptop',
  });
  bobAccess.addMember('erin');
  bobAccess.approveDevice({ userName: 'erin', deviceName: 'erin-laptop' });
  assert.equal(bobAccess.accessDecision({ userName: 'erin', deviceName: 'erin-laptop' }).reason, 'key_delivery_pending');
  await bobAccess.ensureAccess({ userName: 'erin', deviceName: 'erin-laptop' });
  await syncToDevice({
    sourceVault: bobLaptop,
    deviceVault: erinLaptop,
    repoId,
    deviceName: 'erin-laptop',
    label: 'erin-peer-granted',
  });

  assert.equal(
    erinLaptop.search({ repoId, actorName: 'erin-laptop', query: 'missing user grants' }).length,
    1,
  );
});

test('pending key delivery resolves when an authorized peer comes back online', async () => {
  const repoId = 'project-pending-delivery';
  const aliceLaptop = createDevice('alice-pending-laptop');
  const bobLaptop = createDevice('bob-pending-laptop');

  aliceLaptop.createUser({
    userName: 'alice',
    passphrase: 'alice-passphrase',
    recoveryCode: 'alice-recovery',
  });
  await createApprovedDevice({
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
  await createApprovedDevice({
    deviceVault: bobLaptop,
    deviceName: 'bob-laptop',
    userName: 'bob',
    approvingVault: bobLaptop,
    passphrase: 'bob-passphrase',
    recoveryCode: 'bob-recovery',
  });
  aliceLaptop.importPublicIdentity(bobLaptop.exportPublicIdentity('bob'));
  bobLaptop.importPublicIdentity(aliceLaptop.exportPublicIdentity('alice'));
  bobLaptop.importPublicIdentity(aliceLaptop.exportPublicIdentity('alice-laptop'));

  await aliceLaptop.createRepoHpke(repoId, 'alice', { actorName: 'alice-laptop' });
  const access = new ContextAccessModel({
    peerVault: aliceLaptop,
    repoId,
    peerActorName: 'alice-laptop',
  });
  access.addMember('alice');
  access.approveDevice({ userName: 'alice', deviceName: 'alice-laptop' });
  aliceLaptop.addEntry({
    repoId,
    actorName: 'alice-laptop',
    scope: 'resource',
    title: 'Pending delivery rule',
    body: 'Key delivery waits until an authorized peer comes back online.',
  });

  access.addMember('bob');
  access.approveDevice({ userName: 'bob', deviceName: 'bob-laptop' });
  const pending = access.accessDecision({ userName: 'bob', deviceName: 'bob-laptop' });
  assert.equal(pending.allowed, true);
  assert.equal(pending.pending, true);
  assert.equal(pending.reason, 'key_delivery_pending');

  const ready = await access.ensureAccess({ userName: 'bob', deviceName: 'bob-laptop' });
  assert.equal(ready.pending, false);
  assert.equal(ready.reason, 'ready');
  await syncToDevice({
    sourceVault: aliceLaptop,
    deviceVault: bobLaptop,
    repoId,
    deviceName: 'bob-laptop',
    label: 'bob-after-peer-return',
  });

  assert.equal(
    bobLaptop.search({ repoId, actorName: 'bob-laptop', query: 'authorized peer comes back online' }).length,
    1,
  );
});
