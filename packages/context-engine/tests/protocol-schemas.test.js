const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { signEnvelope } = require('../src/crypto/signatures');
const { createProtocolValidator } = require('../src/protocol/schemas');
const {
  createHpkeIdentity,
  wrapRepoKeyWithHpke,
} = require('../src/crypto/hpke-grants');
const { pairedVaults, tempHome } = require('./helpers');

function jsonFiles(dir) {
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => path.join(dir, file));
}

function validateOrThrow(validate, value) {
  const valid = validate(value);
  assert.equal(valid, true, JSON.stringify(validate.errors, null, 2));
}

test('generated protocol artifacts validate against canonical JSON schemas', () => {
  const {
    validateBundleManifest: validateManifest,
    validateEraseReceipt: validateReceipt,
    validateEvent,
    validateKeyGrant: validateGrant,
    validateProfile,
  } = createProtocolValidator();
  const { aliceVault, bobVault } = pairedVaults();
  const repoId = 'project-api';
  const syncDir = path.join(tempHome('vault-schema-sync'), 'events');

  const profile = aliceVault.writeProfile({
    repoId,
    name: 'code-review',
    profile: {
      packs: ['project-standards'],
      query: 'auth review proof',
      maxItems: 2,
    },
  });
  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'resource',
    title: 'Schema proof context',
    body: 'Auth reviews require regression proof.',
  });
  aliceVault.grantRepo({ repoId, actorName: 'alice', recipientName: 'bob' });
  const { revokeEvent } = aliceVault.revokeRepo({ repoId, actorName: 'alice', recipientName: 'bob' });
  aliceVault.exportSync({ repoId, outDir: syncDir });

  for (const eventPath of jsonFiles(syncDir)) {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    validateOrThrow(validateEvent, event);
    if (event.grant?.wrappedRepoKeyEnvelope) {
      validateOrThrow(validateGrant, event.grant.wrappedRepoKeyEnvelope);
    }
  }

  const bundle = aliceVault.resolveBundle({
    repoId,
    actorName: 'alice',
    profile: 'code-review',
    pins: { resolverVersion: '0.0.1' },
  });
  validateOrThrow(validateManifest, bundle.manifest);
  validateOrThrow(validateProfile, profile);

  bobVault.importSync({ repoId, actorName: 'bob', inDir: syncDir });
  const receipt = bobVault.cooperativeErase({
    repoId,
    actorName: 'bob',
    revocationEventId: revokeEvent.id,
  });
  validateOrThrow(validateReceipt, receipt);
});

test('protocol schemas reject malformed or downgraded artifacts', () => {
  const {
    validateEvent,
    validateKeyGrant: validateGrant,
  } = createProtocolValidator();
  const { aliceVault } = pairedVaults();
  const repoId = 'project-api';
  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'resource',
    title: 'Strict schema context',
    body: 'Malformed events must be rejected before sync.',
  });

  const eventPath = jsonFiles(path.join(aliceVault.home, 'repos', repoId, 'events'))
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
    .find((event) => event.type === 'entry.approved');
  const missingSignature = structuredClone(eventPath);
  delete missingSignature.signature;
  assert.equal(validateEvent(missingSignature), false);

  const downgraded = structuredClone(eventPath);
  downgraded.schemaVersion = 'viewport.context_event/v0';
  assert.equal(validateEvent(downgraded), false);

  const payloadEventWithoutCiphertext = structuredClone(eventPath);
  payloadEventWithoutCiphertext.encrypted = null;
  assert.equal(validateEvent(payloadEventWithoutCiphertext), false);

  const payloadEventWithGrant = structuredClone(eventPath);
  payloadEventWithGrant.grant = {
    revokedName: 'bob',
    nextKeyEpoch: 2,
  };
  assert.equal(validateEvent(payloadEventWithGrant), false);

  const grantEventWithEncryptedPayload = jsonFiles(path.join(aliceVault.home, 'repos', repoId, 'events'))
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
    .find((event) => event.type === 'repo.created');
  grantEventWithEncryptedPayload.encrypted = eventPath.encrypted;
  assert.equal(validateEvent(grantEventWithEncryptedPayload), false);

  const badGrant = {
    version: 'viewport.context_key_grant/v1',
    recipientName: 'bob',
    ephemeralPublicKey: 'pem',
    encryptedRepoKey: {
      alg: 'rsa-oaep',
      iv: 'iv',
      ciphertext: 'ciphertext',
      tag: 'tag',
    },
  };
  assert.equal(validateGrant(badGrant), false);
});

test('HPKE draft key grant validates against explicit draft schema', async () => {
  const {
    validateEvent,
    validateKeyGrantHpkeDraft,
  } = createProtocolValidator();
  const { aliceVault } = pairedVaults();
  const bob = await createHpkeIdentity('bob');
  const grant = await wrapRepoKeyWithHpke(crypto.randomBytes(32), bob, {
    repoId: 'project-api',
    keyEpoch: 2,
  });

  validateOrThrow(validateKeyGrantHpkeDraft, grant);
  const unsignedEvent = {
    id: 'evt_hpke000000000000000000000000000001',
    repoId: 'project-api',
    type: 'member.granted',
    actorName: 'alice',
    keyEpoch: 2,
    visibility: 'shared',
    createdAt: '2026-05-06T00:00:00.000Z',
    parentIds: [],
    encrypted: null,
    grant: {
      recipientName: 'bob',
      keyEpoch: 2,
      wrappedRepoKeyEnvelope: grant,
    },
    payloadDigest: null,
    schemaVersion: 'viewport.context_event/v1',
  };
  validateOrThrow(validateEvent, {
    ...unsignedEvent,
    signature: signEnvelope(unsignedEvent, aliceVault.getIdentity('alice')),
  });

  const downgraded = structuredClone(grant);
  downgraded.suite.aead = 'AES_128_GCM';
  assert.equal(validateKeyGrantHpkeDraft(downgraded), false);
});
