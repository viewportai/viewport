const { createRepoKey } = require('../crypto/keys');
const { readJson, writeJson } = require('./files');
const { repoPaths } = require('./paths');

function grantDecision({ allowed, pending = false, reason, epochs = [] }) {
  return { allowed, pending, reason, epochs };
}

class ContextAccessModel {
  constructor({ peerVault, repoId, peerActorName }) {
    this.peerVault = peerVault;
    this.repoId = repoId;
    this.peerActorName = peerActorName;
    this.members = new Map();
    this.devices = new Map();
  }

  addMember(userName, { history = 'full' } = {}) {
    const metadata = this.peerVault.getRepoMetadata(this.repoId);
    const joinedEpoch = history === 'join_date'
      ? this.rotateEpoch(`member.joined:${userName}`)
      : metadata.currentKeyEpoch;

    this.members.set(userName, {
      active: true,
      history,
      joinedEpoch,
    });

    return this.members.get(userName);
  }

  removeMember(userName) {
    const member = this.members.get(userName);
    if (!member) {
      throw new Error(`Unknown member: ${userName}`);
    }

    member.active = false;
    return this.rotateEpoch(`member.removed:${userName}`);
  }

  importDeviceIdentity(devicePublicIdentity) {
    this.peerVault.importPublicIdentity(devicePublicIdentity);
  }

  approveDevice({ userName, deviceName, devicePublicIdentity = null }) {
    if (devicePublicIdentity) {
      this.importDeviceIdentity(devicePublicIdentity);
    }

    this.devices.set(deviceName, {
      userName,
      approved: true,
    });

    return this.devices.get(deviceName);
  }

  denyDevice({ userName, deviceName }) {
    this.devices.set(deviceName, {
      userName,
      approved: false,
    });

    return this.devices.get(deviceName);
  }

  accessDecision({ userName, deviceName }) {
    const member = this.members.get(userName);
    if (!member?.active) {
      return grantDecision({ allowed: false, reason: 'acl_denied' });
    }

    const device = this.devices.get(deviceName);
    if (!device || device.userName !== userName) {
      return grantDecision({ allowed: false, reason: 'device_unknown' });
    }

    if (!device.approved) {
      return grantDecision({ allowed: false, reason: 'device_not_approved' });
    }

    const epochs = this.allowedEpochs(member);
    const missingEpochs = epochs.filter((epoch) => !this.hasGrant({ userName, keyEpoch: epoch }));

    if (missingEpochs.length > 0) {
      return grantDecision({
        allowed: true,
        pending: true,
        reason: 'key_delivery_pending',
        epochs: missingEpochs,
      });
    }

    return grantDecision({
      allowed: true,
      reason: 'ready',
      epochs,
    });
  }

  async ensureAccess({ userName, deviceName }) {
    const decision = this.accessDecision({ userName, deviceName });
    if (!decision.allowed) {
      return decision;
    }

    for (const epoch of decision.epochs) {
      await this.grantEpochToUser({ userName, keyEpoch: epoch });
    }

    return this.accessDecision({ userName, deviceName });
  }

  allowedEpochs(member) {
    const metadata = this.peerVault.getRepoMetadata(this.repoId);
    const start = member.history === 'full' ? 1 : member.joinedEpoch;
    const epochs = [];
    for (let epoch = start; epoch <= metadata.currentKeyEpoch; epoch += 1) {
      epochs.push(epoch);
    }

    return epochs;
  }

  hasGrant({ userName, keyEpoch }) {
    return this.peerVault.activeRecipients(this.repoId).has(userName)
      && this.grantEventsFor({ userName, keyEpoch }).length > 0;
  }

  grantEventsFor({ userName, keyEpoch }) {
    const { listJsonFiles, readJson: readEvent } = require('./files');
    return listJsonFiles(repoPaths(this.peerVault.home, this.repoId).eventsDir)
      .map((file) => readEvent(file))
      .filter((event) => (
        ['repo.created', 'member.granted', 'key.rotated'].includes(event.type)
        && event.grant?.recipientName === userName
        && event.grant?.keyEpoch === keyEpoch
      ));
  }

  async grantEpochToUser({ userName, keyEpoch }) {
    return this.peerVault.appendGrantEventHpke({
      repoId: this.repoId,
      actorName: this.peerActorName,
      recipient: this.peerVault.getKnownIdentity(userName),
      keyEpoch,
      repoKey: this.peerVault.getRepoKey(this.repoId, keyEpoch),
      eventType: 'member.granted',
    });
  }

  rotateEpoch(reason) {
    const paths = repoPaths(this.peerVault.home, this.repoId);
    const metadata = this.peerVault.getRepoMetadata(this.repoId);
    const nextEpoch = metadata.currentKeyEpoch + 1;
    const keys = readJson(paths.keys, { epochs: {} });
    keys.epochs[String(nextEpoch)] = createRepoKey().toString('base64');
    writeJson(paths.keys, keys);
    writeJson(paths.metadata, {
      ...metadata,
      currentKeyEpoch: nextEpoch,
    });

    return nextEpoch;
  }
}

module.exports = { ContextAccessModel };
