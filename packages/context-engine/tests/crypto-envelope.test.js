const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  KEY_WRAP_ALG,
  KEY_WRAP_VERSION,
  createIdentity,
  createRepoKey,
  unwrapKeyForIdentity,
  wrapKeyForIdentity,
} = require('../src/crypto/keys');
const { pairedVaults, tempHome } = require('./helpers');

function mutateBase64(value) {
  return `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
}

test('X25519 key grant unwraps for intended recipient and rejects wrong recipient', () => {
  const bob = createIdentity('bob');
  const carol = createIdentity('carol');
  const repoKey = createRepoKey();
  const grant = wrapKeyForIdentity(repoKey, bob);

  assert.equal(grant.version, KEY_WRAP_VERSION);
  assert.equal(grant.encryptedRepoKey.alg, KEY_WRAP_ALG);
  assert.equal(unwrapKeyForIdentity(grant, bob).equals(repoKey), true);
  assert.throws(() => unwrapKeyForIdentity(grant, carol), /belongs to bob/);
});

test('tampered X25519 key grant fails authentication before repo key recovery', () => {
  const bob = createIdentity('bob');
  const repoKey = createRepoKey();
  const grant = wrapKeyForIdentity(repoKey, bob);
  const tampered = structuredClone(grant);
  tampered.encryptedRepoKey.ciphertext = mutateBase64(tampered.encryptedRepoKey.ciphertext);

  assert.throws(() => unwrapKeyForIdentity(tampered, bob));
});

test('signed encrypted event tampering is rejected during sync import', () => {
  const { aliceVault, bobVault } = pairedVaults();
  const syncDir = path.join(tempHome('vault-tamper-sync'), 'events');

  aliceVault.addEntry({
    repoId: 'project-api',
    actorName: 'alice',
    scope: 'project',
    title: 'Tamper-proof event',
    body: 'Tampered signed events must not import.',
  });
  aliceVault.grantRepo({ repoId: 'project-api', actorName: 'alice', recipientName: 'bob' });
  aliceVault.exportSync({ repoId: 'project-api', outDir: syncDir });

  const entryFile = fs.readdirSync(syncDir)
    .map((file) => path.join(syncDir, file))
    .find((file) => JSON.parse(fs.readFileSync(file, 'utf8')).type === 'entry.approved');
  const event = JSON.parse(fs.readFileSync(entryFile, 'utf8'));
  event.encrypted.ciphertext = mutateBase64(event.encrypted.ciphertext);
  fs.writeFileSync(entryFile, `${JSON.stringify(event, null, 2)}\n`);

  assert.throws(
    () => bobVault.importSync({ repoId: 'project-api', actorName: 'bob', inDir: syncDir }),
    /Invalid event signature/,
  );
});
