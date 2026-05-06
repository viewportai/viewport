const fs = require('node:fs');
const path = require('node:path');
const { createProtocolValidator } = require('../protocol/schemas');
const { ensureDir, listJsonFiles, readJson, writeJson } = require('./files');
const { repoPaths } = require('./paths');

const protocol = createProtocolValidator();

function assertValidSyncEvent(event, file) {
  if (!protocol.validateEvent(event)) {
    throw new Error(`Invalid context event schema in ${file}: ${JSON.stringify(protocol.validateEvent.errors)}`);
  }

  if (event.grant?.wrappedRepoKeyEnvelope) {
    const grant = event.grant.wrappedRepoKeyEnvelope;
    const validLegacyGrant = protocol.validateKeyGrant(grant);
    const validHpkeGrant = protocol.validateKeyGrantHpkeDraft(grant);
    if (!validLegacyGrant && !validHpkeGrant) {
      throw new Error(`Invalid context key grant schema in ${file}: ${JSON.stringify({
        legacy: protocol.validateKeyGrant.errors,
        hpke: protocol.validateKeyGrantHpkeDraft.errors,
      })}`);
    }
  }
}

function ensureMetadataFromEvents(paths, repoId, events) {
  if (readJson(paths.metadata, null)) {
    return;
  }

  const repoCreated = events.find(({ event }) => event.type === 'repo.created')?.event;
  const currentKeyEpoch = events.reduce((max, { event }) => Math.max(
    max,
    Number(event.grant?.nextKeyEpoch ?? event.grant?.keyEpoch ?? event.keyEpoch ?? 1),
  ), 1);

  writeJson(paths.metadata, {
    repoId,
    createdAt: repoCreated?.createdAt ?? new Date().toISOString(),
    currentKeyEpoch,
    ownerName: repoCreated?.grant?.recipientName ?? repoCreated?.actorName ?? 'unknown',
    erasedActors: {},
    grantProtocol: events.some(({ event }) => (
      event.grant?.wrappedRepoKeyEnvelope?.version === 'viewport.context_key_grant/hpke-draft-01'
    )) ? 'hpke-draft-01' : 'legacy-poc',
  });
}

function exportSync(home, { repoId, outDir }) {
  const paths = repoPaths(home, repoId);
  ensureDir(outDir);
  const copied = [];

  for (const eventFile of listJsonFiles(paths.eventsDir)) {
    const event = readJson(eventFile);
    assertValidSyncEvent(event, eventFile);

    if (event.visibility === 'private') {
      continue;
    }

    const target = path.join(outDir, path.basename(eventFile));
    fs.copyFileSync(eventFile, target);
    copied.push(target);
  }

  return copied;
}

function importSync(vault, { repoId, inDir, actorName }) {
  const paths = repoPaths(vault.home, repoId);
  ensureDir(paths.eventsDir);
  const events = listJsonFiles(inDir).map((eventFile) => ({
    eventFile,
    event: readJson(eventFile),
  }));

  for (const { eventFile, event } of events) {
    assertValidSyncEvent(event, eventFile);
  }

  for (const { eventFile } of events) {
    const target = path.join(paths.eventsDir, path.basename(eventFile));
    if (!fs.existsSync(target)) {
      fs.copyFileSync(eventFile, target);
    }
  }
  ensureMetadataFromEvents(paths, repoId, events);

  return vault.materialize({ repoId, actorName });
}

async function importSyncAsync(vault, { repoId, inDir, actorName }) {
  const paths = repoPaths(vault.home, repoId);
  ensureDir(paths.eventsDir);
  const events = listJsonFiles(inDir).map((eventFile) => ({
    eventFile,
    event: readJson(eventFile),
  }));

  for (const { eventFile, event } of events) {
    assertValidSyncEvent(event, eventFile);
  }

  for (const { eventFile } of events) {
    const target = path.join(paths.eventsDir, path.basename(eventFile));
    if (!fs.existsSync(target)) {
      fs.copyFileSync(eventFile, target);
    }
  }
  ensureMetadataFromEvents(paths, repoId, events);

  return vault.materializeHpke({ repoId, actorName });
}

module.exports = { exportSync, importSync, importSyncAsync };
