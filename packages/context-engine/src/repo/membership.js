const { createRepoKey, wrapKeyForIdentity } = require('../crypto/keys');
const { wrapRepoKeyWithHpke } = require('../crypto/hpke-grants');
const { listJsonFiles, readJson, writeJson } = require('./files');
const { repoPaths } = require('./paths');

function grantRepo(vault, { repoId, actorName, recipientName }) {
  const recipient = vault.getKnownIdentity(recipientName);
  const metadata = vault.getRepoMetadata(repoId);
  const repoKey = vault.getRepoKey(repoId, metadata.currentKeyEpoch);

  return appendGrantEvent(vault, {
    repoId,
    actorName,
    recipient,
    keyEpoch: metadata.currentKeyEpoch,
    repoKey,
    eventType: 'member.granted',
  });
}

async function grantRepoHpke(vault, { repoId, actorName, recipientName }) {
  const recipient = vault.getKnownIdentity(recipientName);
  const metadata = vault.getRepoMetadata(repoId);
  const repoKey = vault.getRepoKey(repoId, metadata.currentKeyEpoch);

  return appendGrantEventHpke(vault, {
    repoId,
    actorName,
    recipient,
    keyEpoch: metadata.currentKeyEpoch,
    repoKey,
    eventType: 'member.granted',
  });
}

async function grantRepoHpkeRecipient(vault, { repoId, actorName, recipient }) {
  const metadata = vault.getRepoMetadata(repoId);
  const repoKey = vault.getRepoKey(repoId, metadata.currentKeyEpoch);

  return appendGrantEventHpke(vault, {
    repoId,
    actorName,
    recipient,
    keyEpoch: metadata.currentKeyEpoch,
    repoKey,
    eventType: 'member.granted',
  });
}

function revokeRepo(vault, { repoId, actorName, recipientName }) {
  const actor = vault.getIdentity(actorName);
  const actorRecipientName = actor.grantRecipientName ?? actorName;
  const paths = repoPaths(vault.home, repoId);
  const metadata = vault.getRepoMetadata(repoId);
  const active = activeRecipients(vault.home, repoId);
  active.delete(recipientName);
  active.add(actorRecipientName);

  const nextEpoch = metadata.currentKeyEpoch + 1;
  const nextRepoKey = createRepoKey();
  const keys = readJson(paths.keys, { epochs: {} });
  keys.epochs[String(nextEpoch)] = nextRepoKey.toString('base64');
  writeJson(paths.keys, keys);
  writeJson(paths.metadata, { ...metadata, currentKeyEpoch: nextEpoch });

  const revokeEvent = vault.appendUnsignedEvent({
    repoId,
    actor,
    type: 'member.revoked',
    keyEpoch: metadata.currentKeyEpoch,
    visibility: 'shared',
    grant: {
      revokedName: recipientName,
      nextKeyEpoch: nextEpoch,
    },
  });

  const rotateEvents = [...active]
    .sort()
    .map((activeRecipientName) => appendGrantEvent(vault, {
      repoId,
      actorName,
      recipient: vault.getKnownIdentity(activeRecipientName),
      keyEpoch: nextEpoch,
      repoKey: nextRepoKey,
      eventType: 'key.rotated',
    }));

  return { revokeEvent, rotateEvent: rotateEvents[0], rotateEvents };
}

async function revokeRepoHpke(vault, { repoId, actorName, recipientName }) {
  const actor = vault.getIdentity(actorName);
  const actorRecipientName = actor.grantRecipientName ?? actorName;
  const paths = repoPaths(vault.home, repoId);
  const metadata = vault.getRepoMetadata(repoId);
  const active = activeRecipients(vault.home, repoId);
  active.delete(recipientName);
  active.add(actorRecipientName);

  const nextEpoch = metadata.currentKeyEpoch + 1;
  const nextRepoKey = createRepoKey();
  const keys = readJson(paths.keys, { epochs: {} });
  keys.epochs[String(nextEpoch)] = nextRepoKey.toString('base64');
  writeJson(paths.keys, keys);
  writeJson(paths.metadata, { ...metadata, currentKeyEpoch: nextEpoch });

  const revokeEvent = vault.appendUnsignedEvent({
    repoId,
    actor,
    type: 'member.revoked',
    keyEpoch: metadata.currentKeyEpoch,
    visibility: 'shared',
    grant: {
      revokedName: recipientName,
      nextKeyEpoch: nextEpoch,
    },
  });

  const rotateEvents = [];
  for (const activeRecipientName of [...active].sort()) {
    rotateEvents.push(await appendGrantEventHpke(vault, {
      repoId,
      actorName,
      recipient: vault.getKnownIdentity(activeRecipientName),
      keyEpoch: nextEpoch,
      repoKey: nextRepoKey,
      eventType: 'key.rotated',
    }));
  }

  return { revokeEvent, rotateEvent: rotateEvents[0], rotateEvents };
}

function appendGrantEvent(vault, { repoId, actorName, recipient, keyEpoch, repoKey, eventType }) {
  return vault.appendUnsignedEvent({
    repoId,
    actor: vault.getIdentity(actorName),
    type: eventType,
    keyEpoch,
    visibility: 'shared',
    grant: {
      recipientName: recipient.name,
      keyEpoch,
      wrappedRepoKeyEnvelope: wrapKeyForIdentity(repoKey, recipient),
    },
  });
}

async function appendGrantEventHpke(vault, { repoId, actorName, recipient, keyEpoch, repoKey, eventType }) {
  return vault.appendUnsignedEvent({
    repoId,
    actor: vault.getIdentity(actorName),
    type: eventType,
    keyEpoch,
    visibility: 'shared',
    grant: {
      recipientName: recipient.name,
      keyEpoch,
      wrappedRepoKeyEnvelope: await wrapRepoKeyWithHpke(repoKey, recipient, { repoId, keyEpoch }),
    },
  });
}

function activeRecipients(home, repoId) {
  const recipients = new Set();

  for (const eventFile of listJsonFiles(repoPaths(home, repoId).eventsDir)) {
    const event = readJson(eventFile);

    if (['repo.created', 'member.granted', 'key.rotated'].includes(event.type) && event.grant?.recipientName) {
      recipients.add(event.grant.recipientName);
    }

    if (event.type === 'member.revoked' && event.grant?.revokedName) {
      recipients.delete(event.grant.revokedName);
    }
  }

  return recipients;
}

module.exports = {
  activeRecipients,
  appendGrantEvent,
  appendGrantEventHpke,
  grantRepo,
  grantRepoHpke,
  grantRepoHpkeRecipient,
  revokeRepo,
  revokeRepoHpke,
};
