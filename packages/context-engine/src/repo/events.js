const crypto = require('node:crypto');
const path = require('node:path');
const { canonicalize } = require('../crypto/canonical');
const { digest, encryptJson } = require('../crypto/envelope');
const { signEnvelope } = require('../crypto/signatures');
const { listJsonFiles, readJson, writeJson } = require('./files');
const { repoPaths } = require('./paths');

function appendSharedEvent(vault, { repoId, actorName, type, payload, contextResourceId = null }) {
  const metadata = vault.getRepoMetadata(repoId);
  const repoKey = vault.getRepoKey(repoId, metadata.currentKeyEpoch);
  const encrypted = encryptJson(payload, repoKey);
  return appendUnsignedEvent(vault, {
    repoId,
    actor: vault.getIdentity(actorName),
    type,
    keyEpoch: metadata.currentKeyEpoch,
    visibility: 'shared',
    encrypted,
    payloadDigest: digest(canonicalize(payload)),
    contextResourceId,
  });
}

function appendPrivateEvent(vault, { repoId, actorName, type, payload, contextResourceId = null }) {
  const identity = vault.getIdentity(actorName);
  const encrypted = encryptJson(payload, Buffer.from(identity.personalKey, 'base64'));
  return appendUnsignedEvent(vault, {
    repoId,
    actor: identity,
    type,
    keyEpoch: 0,
    visibility: 'private',
    encrypted,
    payloadDigest: digest(canonicalize(payload)),
    contextResourceId,
  });
}

function appendUnsignedEvent(
  vault,
  {
    repoId,
    actor,
    type,
    keyEpoch,
    visibility,
    encrypted = null,
    grant = null,
    payloadDigest = null,
    contextResourceId = null,
  },
) {
  const event = {
    id: `evt_${crypto.randomUUID()}`,
    repoId,
    type,
    actorName: actor.name,
    keyEpoch,
    visibility,
    createdAt: new Date().toISOString(),
    parentIds: latestEventIds(vault.home, repoId).slice(-2),
    ...(contextResourceId ? { contextResourceId } : {}),
    encrypted,
    grant,
    payloadDigest,
    schemaVersion: 'viewport.context_event/v1',
  };

  const signature = signEnvelope(event, actor);
  const signed = { ...event, signature };
  const sequence = latestEventIds(vault.home, repoId).length + 1;
  const fileName = `${String(sequence).padStart(8, '0')}-${signed.id}.json`;
  writeJson(path.join(repoPaths(vault.home, repoId).eventsDir, fileName), signed);
  return signed;
}

function latestEventIds(home, repoId) {
  return listJsonFiles(repoPaths(home, repoId).eventsDir).map((file) => readJson(file).id);
}

module.exports = {
  appendPrivateEvent,
  appendSharedEvent,
  appendUnsignedEvent,
  latestEventIds,
};
