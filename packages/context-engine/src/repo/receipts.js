const crypto = require('node:crypto');
const path = require('node:path');
const { signEnvelope, verifyEnvelope } = require('../crypto/signatures');
const { listJsonFiles, readJson, writeJson } = require('./files');
const { repoPaths } = require('./paths');
const { resetStore } = require('../store/sqlite');

function cooperativeErase(vault, { repoId, actorName, revocationEventId }) {
  const paths = repoPaths(vault.home, repoId);
  const identity = vault.getIdentity(actorName);
  const metadata = readJson(paths.metadata, { repoId, erasedActors: {} });
  const revocationEvent = listJsonFiles(paths.eventsDir)
    .map((file) => readJson(file))
    .find((event) => event.id === revocationEventId);

  if (!revocationEvent || revocationEvent.type !== 'member.revoked') {
    throw new Error(`Unknown revocation event: ${revocationEventId}`);
  }

  if (revocationEvent.grant?.revokedName !== actorName) {
    throw new Error(`Revocation event does not revoke ${actorName}`);
  }

  const erasedAt = new Date().toISOString();
  writeJson(paths.metadata, {
    ...metadata,
    erasedActors: {
      ...(metadata.erasedActors ?? {}),
      [actorName]: erasedAt,
    },
  });
  writeJson(paths.keys, { epochs: {} });
  resetStore(paths.db).close();

  const receipt = {
    schemaVersion: 'viewport.context_erase_receipt/v1',
    id: `erase_${crypto.randomUUID()}`,
    repoId,
    actorName,
    revocationEventId,
    erasedAt,
    cacheTombstoned: true,
  };
  const signed = {
    ...receipt,
    signature: signEnvelope(receipt, identity),
  };
  writeJson(path.join(paths.eraseReceiptsDir, `${signed.id}.json`), signed);
  return signed;
}

function verifyEraseReceipt(vault, { repoId, receipt }) {
  const publicKeys = vault.loadPublicKeys();
  const publicKey = publicKeys.get(receipt.actorName);
  if (!publicKey || !verifyEnvelope(receipt, publicKey)) {
    return false;
  }

  return listJsonFiles(repoPaths(vault.home, repoId).eventsDir)
    .map((file) => readJson(file))
    .some((event) => (
      event.id === receipt.revocationEventId
      && event.type === 'member.revoked'
      && event.grant?.revokedName === receipt.actorName
    ));
}

module.exports = { cooperativeErase, verifyEraseReceipt };
