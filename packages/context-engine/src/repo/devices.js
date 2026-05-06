const crypto = require('node:crypto');
const { createIdentity: createCryptoIdentity } = require('../crypto/keys');
const { openBytesWithHpke, sealBytesWithHpke } = require('../crypto/hpke-grants');
const { signEnvelope, verifyEnvelope } = require('../crypto/signatures');
const { readJson, writeJson } = require('./files');
const { exportPublicIdentity, identityPath, importPublicIdentity } = require('./identities');
const { recoverUserIdentity } = require('./users');

const DEVICE_APPROVAL_PURPOSE = 'viewport-context-device-approval-v1';

function codeDigest(code) {
  return `sha256:${crypto.createHash('sha256').update(String(code), 'utf8').digest('hex')}`;
}

function createDeviceApprovalRequest(home, { deviceName, code }) {
  const identity = createCryptoIdentity(deviceName);
  writeJson(identityPath(home, deviceName), {
    ...identity,
    deviceName,
    deviceState: 'pending_approval',
  });

  return {
    version: 'viewport.context_device_approval_request/v1',
    deviceName,
    codeDigest: codeDigest(code),
    devicePublicIdentity: exportPublicIdentity(home, deviceName),
    createdAt: new Date().toISOString(),
  };
}

function userDecryptionCapability(userIdentity) {
  return {
    userName: userIdentity.name,
    signingPublicKey: userIdentity.signingPublicKey ?? userIdentity.publicKey,
    encryptionPublicKey: userIdentity.encryptionPublicKey,
    encryptionPrivateKey: userIdentity.encryptionPrivateKey,
    hpkePublicKey: userIdentity.hpkePublicKey,
    hpkePrivateKey: userIdentity.hpkePrivateKey,
  };
}

async function approveDeviceRequest(home, {
  userName,
  request,
  passphrase,
  recoveryCode,
  code,
}) {
  if (request.codeDigest !== codeDigest(code)) {
    throw new Error('Device approval code mismatch');
  }

  const userIdentity = recoverUserIdentity(home, { userName, passphrase, recoveryCode });
  const capability = userDecryptionCapability(userIdentity);
  const envelope = await sealBytesWithHpke(
    Buffer.from(JSON.stringify(capability), 'utf8'),
    request.devicePublicIdentity,
    {
      purpose: DEVICE_APPROVAL_PURPOSE,
      context: {
        codeDigest: request.codeDigest,
        deviceName: request.deviceName,
        userName,
      },
    },
  );

  const unsignedApproval = {
    version: 'viewport.context_device_approval/v1',
    userName,
    deviceName: request.deviceName,
    envelope,
    approvedAt: new Date().toISOString(),
  };

  return {
    ...unsignedApproval,
    signature: signEnvelope(unsignedApproval, userIdentity),
  };
}

async function acceptDeviceApproval(home, { userName, deviceName, approval, code }) {
  if (approval.userName !== userName || approval.deviceName !== deviceName) {
    throw new Error('Device approval target mismatch');
  }

  if (approval.envelope.context?.codeDigest !== codeDigest(code)) {
    throw new Error('Device approval code mismatch');
  }

  const deviceIdentity = readJson(identityPath(home, deviceName));
  if (!deviceIdentity?.hpkePrivateKey) {
    throw new Error(`Unknown pending device: ${deviceName}`);
  }

  const plaintext = await openBytesWithHpke(approval.envelope, deviceIdentity, {
    expectedPurpose: DEVICE_APPROVAL_PURPOSE,
  });
  const capability = JSON.parse(plaintext.toString('utf8'));
  if (capability.userName !== userName) {
    throw new Error('Device approval capability user mismatch');
  }
  if (!verifyEnvelope(approval, capability.signingPublicKey)) {
    throw new Error('Device approval signature invalid');
  }

  writeJson(identityPath(home, deviceName), {
    ...deviceIdentity,
    deviceState: 'approved',
    approvedAt: new Date().toISOString(),
    grantRecipientName: userName,
    userSigningPublicKey: capability.signingPublicKey,
    grantEncryptionPublicKey: capability.encryptionPublicKey,
    grantEncryptionPrivateKey: capability.encryptionPrivateKey,
    grantHpkePublicKey: capability.hpkePublicKey,
    grantHpkePrivateKey: capability.hpkePrivateKey,
  });

  importPublicIdentity(home, {
    name: userName,
    publicKey: capability.signingPublicKey,
    signingPublicKey: capability.signingPublicKey,
    encryptionPublicKey: capability.encryptionPublicKey,
    hpkePublicKey: capability.hpkePublicKey,
  });

  return readJson(identityPath(home, deviceName));
}

module.exports = {
  DEVICE_APPROVAL_PURPOSE,
  acceptDeviceApproval,
  approveDeviceRequest,
  codeDigest,
  createDeviceApprovalRequest,
};
