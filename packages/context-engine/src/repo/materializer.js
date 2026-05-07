const { decryptJson } = require('../crypto/envelope');
const { unwrapRepoKeyWithHpke } = require('../crypto/hpke-grants');
const { unwrapKeyForIdentity } = require('../crypto/keys');
const { verifyEnvelope } = require('../crypto/signatures');
const { createProtocolValidator } = require('../protocol/schemas');
const { allCandidates, allEntries } = require('../store/search');
const { resetStore } = require('../store/sqlite');
const { listJsonFiles, readJson, writeJson } = require('./files');

const protocol = createProtocolValidator();

function assertValidEvent(event) {
  if (!protocol.validateEvent(event)) {
    throw new Error(`Invalid context event schema: ${event.id ?? 'unknown'}`);
  }

  if (event.grant?.wrappedRepoKeyEnvelope) {
    const grant = event.grant.wrappedRepoKeyEnvelope;
    const validLegacyGrant = protocol.validateKeyGrant(grant);
    const validHpkeGrant = protocol.validateKeyGrantHpkeDraft(grant);
    if (!validLegacyGrant && !validHpkeGrant) {
      throw new Error(`Invalid context key grant schema: ${event.id ?? 'unknown'}`);
    }
  }
}

function unwrapSupportedGrant(wrappedRepoKeyEnvelope, identity) {
  if (wrappedRepoKeyEnvelope.version === 'viewport.context_key_grant/hpke-draft-01') {
    throw new Error('HPKE key grant materialization is not wired into the synchronous POC store yet');
  }

  return unwrapKeyForIdentity(wrappedRepoKeyEnvelope, identity);
}

function grantRecipientNameFor(identity, actorName) {
  return identity.grantRecipientName ?? actorName;
}

function grantRecipientIdentity(identity, actorName) {
  return {
    ...identity,
    name: grantRecipientNameFor(identity, actorName),
    encryptionPrivateKey: identity.grantEncryptionPrivateKey ?? identity.encryptionPrivateKey,
    hpkePrivateKey: identity.grantHpkePrivateKey ?? identity.hpkePrivateKey,
  };
}

async function unwrapSupportedGrantAsync(wrappedRepoKeyEnvelope, identity, { repoId, keyEpoch }) {
  if (wrappedRepoKeyEnvelope.version === 'viewport.context_key_grant/hpke-draft-01') {
    return unwrapRepoKeyWithHpke(wrappedRepoKeyEnvelope, identity, {
      expectedRepoId: repoId,
      expectedKeyEpoch: keyEpoch,
    });
  }

  return unwrapKeyForIdentity(wrappedRepoKeyEnvelope, identity);
}

function decryptEventPayload(event, identity, keys) {
  if (event.visibility === 'private') {
    if (event.actorName !== identity.name) {
      throw new Error('Private event does not belong to actor');
    }

    return decryptJson(event.encrypted, Buffer.from(identity.personalKey, 'base64'));
  }

  const key = keys.epochs[String(event.keyEpoch)];
  if (!key) {
    throw new Error(`No key for epoch ${event.keyEpoch}`);
  }

  return decryptJson(event.encrypted, Buffer.from(key, 'base64'));
}

function materializeRepo({ paths, actorName, identity, publicKeys }) {
  const db = resetStore(paths.db);
  const keys = readJson(paths.keys, { epochs: {} });

  const insertEntry = db.prepare(`
    INSERT OR REPLACE INTO context_entries
    (id, version_id, scope, title, body, source_kind, trust_state, source, created_at, superseded_by)
    VALUES (@id, @versionId, @scope, @title, @body, @sourceKind, @trustState, @source, @createdAt, @supersededBy)
  `);
  const insertFts = db.prepare(`
    INSERT INTO context_entries_fts (id, title, body) VALUES (?, ?, ?)
  `);
  const insertCandidate = db.prepare(`
    INSERT OR REPLACE INTO context_candidates
    (id, proposal_event_id, payload_digest, title, body, source_kind, trust_state, source, created_at, status, priority_score)
    VALUES (@id, @proposalEventId, @payloadDigest, @title, @body, @sourceKind, @trustState, @source, @createdAt, @status, @priorityScore)
  `);
  const assignCandidate = db.prepare(`
    UPDATE context_candidates
    SET status = 'assigned', assigned_to = @assignedTo, reviewed_at = @reviewedAt
    WHERE id = @id AND status NOT IN ('approved', 'rejected', 'tombstoned')
  `);
  const approveCandidate = db.prepare(`
    UPDATE context_candidates
    SET status = 'approved', reviewed_by = @reviewedBy, reviewed_at = @reviewedAt
    WHERE id = @id AND status NOT IN ('rejected', 'tombstoned')
  `);
  const rejectCandidate = db.prepare(`
    UPDATE context_candidates
    SET status = 'rejected', reviewed_by = @reviewedBy, review_reason = @reviewReason, reviewed_at = @reviewedAt
    WHERE id = @id AND status != 'approved'
  `);
  const tombstoneCandidate = db.prepare(`
    UPDATE context_candidates
    SET status = 'tombstoned', reviewed_by = @reviewedBy, review_reason = @reviewReason, tombstoned_at = @tombstonedAt
    WHERE id = @id AND status != 'approved'
  `);
  const insertEdge = db.prepare(`
    INSERT INTO context_edges (from_id, relation, to_id) VALUES (?, ?, ?)
  `);
  const markSuperseded = db.prepare(`
    UPDATE context_entries SET superseded_by = ? WHERE id = ?
  `);

  const tx = db.transaction(() => {
    const eventFiles = listJsonFiles(paths.eventsDir);

    for (const file of eventFiles) {
      const event = readJson(file);
      assertValidEvent(event);
      const signerPublicKey = publicKeys.get(event.actorName);
      if (!signerPublicKey || !verifyEnvelope(event, signerPublicKey)) {
        throw new Error(`Invalid event signature: ${event.id}`);
      }

      if (event.type === 'repo.created' || event.type === 'member.granted' || event.type === 'key.rotated') {
        if (event.grant?.recipientName === grantRecipientNameFor(identity, actorName)) {
          if (event.grant.wrappedRepoKeyEnvelope.version === 'viewport.context_key_grant/hpke-draft-01') {
            if (!keys.epochs[String(event.grant.keyEpoch)]) {
              throw new Error('HPKE key grant requires async materialization before synchronous projection');
            }
          } else {
            try {
              keys.epochs[String(event.grant.keyEpoch)] = unwrapSupportedGrant(
                event.grant.wrappedRepoKeyEnvelope,
                grantRecipientIdentity(identity, actorName),
              ).toString('base64');
            } catch {
              continue;
            }
          }
        }
      }
    }

    for (const file of eventFiles) {
      const event = readJson(file);

      if (event.type === 'repo.created' || event.type === 'member.granted' || event.type === 'key.rotated') {
        continue;
      }

      let payload = null;
      try {
        payload = decryptEventPayload(event, identity, keys);
      } catch {
        continue;
      }

      if (event.type === 'entry.approved') {
        const row = { ...payload, supersededBy: null };
        insertEntry.run(row);
        insertFts.run(row.id, row.title, row.body);
        for (const target of payload.appliesTo ?? []) {
          insertEdge.run(row.id, 'applies_to', target);
        }
      }

      if (event.type === 'entry.proposed') {
        insertCandidate.run({
          ...payload,
          proposalEventId: event.id,
          payloadDigest: event.payloadDigest,
        });
      }

      if (event.type === 'candidate.assigned') {
        assignCandidate.run(payload);
      }

      if (event.type === 'candidate.approved') {
        approveCandidate.run(payload);
      }

      if (event.type === 'candidate.rejected') {
        rejectCandidate.run(payload);
      }

      if (event.type === 'candidate.tombstoned') {
        tombstoneCandidate.run(payload);
      }

      if (event.type === 'entry.superseded') {
        markSuperseded.run(payload.supersededBy, payload.id);
        insertEdge.run(payload.id, 'superseded_by', payload.supersededBy);
      }
    }
  });

  tx();
  writeJson(paths.keys, keys);

  const result = {
    entries: allEntries(db),
    candidates: allCandidates(db),
  };
  db.close();
  return result;
}

async function materializeRepoAsync({ paths, actorName, identity, publicKeys }) {
  const eventFiles = listJsonFiles(paths.eventsDir);
  const keys = readJson(paths.keys, { epochs: {} });

  for (const file of eventFiles) {
    const event = readJson(file);
    assertValidEvent(event);
    const signerPublicKey = publicKeys.get(event.actorName);
    if (!signerPublicKey || !verifyEnvelope(event, signerPublicKey)) {
      throw new Error(`Invalid event signature: ${event.id}`);
    }

    if (event.type === 'repo.created' || event.type === 'member.granted' || event.type === 'key.rotated') {
      if (event.grant?.recipientName === grantRecipientNameFor(identity, actorName)) {
        try {
          keys.epochs[String(event.grant.keyEpoch)] = (await unwrapSupportedGrantAsync(
            event.grant.wrappedRepoKeyEnvelope,
            grantRecipientIdentity(identity, actorName),
            { repoId: event.repoId, keyEpoch: event.grant.keyEpoch },
          )).toString('base64');
        } catch {
          continue;
        }
      }
    }
  }

  writeJson(paths.keys, keys);
  return materializeRepo({ paths, actorName, identity, publicKeys });
}

module.exports = { materializeRepo, materializeRepoAsync };
