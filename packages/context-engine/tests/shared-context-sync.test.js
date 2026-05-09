const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const path = require('node:path');
const { signEnvelope } = require('../src/crypto/signatures');
const { pairedVaults, readAllText, tempHome } = require('./helpers');

test('shared resource context syncs as encrypted events and materializes for another identity', () => {
  const { aliceVault, bobVault } = pairedVaults();
  const secretBody = 'PRs touching auth must run session rotation tests.';

  aliceVault.addEntry({
    repoId: 'project-api',
    actorName: 'alice',
    scope: 'resource',
    title: 'Auth review rule',
    body: secretBody,
    source: 'git://api/AGENTS.md#auth',
    appliesTo: ['repo:api', 'path:app/Auth'],
  });
  aliceVault.grantRepo({ repoId: 'project-api', actorName: 'alice', recipientName: 'bob' });

  const syncDir = path.join(tempHome('vault-sync'), 'events');
  aliceVault.exportSync({ repoId: 'project-api', outDir: syncDir });

  assert.equal(readAllText(syncDir).includes(secretBody), false, 'sync export must not contain plaintext context');

  const imported = bobVault.importSync({
    repoId: 'project-api',
    actorName: 'bob',
    inDir: syncDir,
  });

  assert.equal(imported.entries.length, 1);
  assert.equal(imported.entries[0].title, 'Auth review rule');

  const search = bobVault.search({
    repoId: 'project-api',
    actorName: 'bob',
    query: 'session rotation',
  });

  assert.equal(search.length, 1);
  assert.equal(search[0].body, secretBody);
});

test('shared resource context syncs from event objects and materializes for another identity', async () => {
  const { aliceVault, bobVault } = pairedVaults();
  const repoId = 'project-hpke-api';
  const secretBody = 'PRs touching auth must run session rotation tests.';

  await aliceVault.createRepoHpke(repoId, 'alice');
  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'resource',
    title: 'Auth review rule',
    body: secretBody,
    source: 'git://api/AGENTS.md#auth',
    appliesTo: ['repo:api', 'path:app/Auth'],
  });
  await aliceVault.grantRepoHpke({ repoId, actorName: 'alice', recipientName: 'bob' });

  const events = aliceVault.listSyncEvents({ repoId });

  assert.equal(events.length > 0, true);
  assert.equal(JSON.stringify(events).includes(secretBody), false, 'sync event objects must not contain plaintext context');
  assert.equal(events.some((event) => event.schemaVersion === 'viewport.context_event/v1'), true);
  assert.equal(events.some((event) => event.visibility === 'private'), false);

  const imported = await bobVault.importSyncEvents({
    repoId,
    actorName: 'bob',
    events,
  });

  assert.equal(imported.imported.length, events.length);
  assert.equal(imported.materialized.entries.length, 1);
  assert.equal(imported.materialized.entries[0].title, 'Auth review rule');

  const search = bobVault.search({
    repoId,
    actorName: 'bob',
    query: 'session rotation',
  });

  assert.equal(search.length, 1);
  assert.equal(search[0].body, secretBody);
});

test('sync import rejects downgraded signed events before copying them', () => {
  const { aliceVault, bobVault } = pairedVaults();
  aliceVault.addEntry({
    repoId: 'project-api',
    actorName: 'alice',
    scope: 'resource',
    title: 'Downgrade guard',
    body: 'Schema downgrade must not sync.',
  });

  const syncDir = path.join(tempHome('vault-sync-downgrade'), 'events');
  aliceVault.exportSync({ repoId: 'project-api', outDir: syncDir });
  const eventFile = fs.readdirSync(syncDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.join(syncDir, file))
    .find((file) => JSON.parse(fs.readFileSync(file, 'utf8')).type === 'entry.approved');
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  const { signature: _signature, ...unsigned } = event;
  const downgraded = {
    ...unsigned,
    schemaVersion: 'viewport.context_event/v0',
  };
  const signedDowngrade = {
    ...downgraded,
    signature: signEnvelope(downgraded, aliceVault.getIdentity('alice')),
  };
  fs.writeFileSync(eventFile, `${JSON.stringify(signedDowngrade, null, 2)}\n`);

  assert.throws(
    () => bobVault.importSync({ repoId: 'project-api', actorName: 'bob', inDir: syncDir }),
    /Invalid context event schema/,
  );
  assert.equal(
    fs.readdirSync(path.join(bobVault.home, 'repos', 'project-api', 'events')).length,
    0,
  );
});

test('materializer rejects downgraded local events before decrypting payloads', () => {
  const { aliceVault } = pairedVaults();
  aliceVault.addEntry({
    repoId: 'project-api',
    actorName: 'alice',
    scope: 'resource',
    title: 'Materializer downgrade guard',
    body: 'Local event log downgrade must not materialize.',
  });

  const eventsDir = path.join(aliceVault.home, 'repos', 'project-api', 'events');
  const eventFile = fs.readdirSync(eventsDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.join(eventsDir, file))
    .find((file) => JSON.parse(fs.readFileSync(file, 'utf8')).type === 'entry.approved');
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  const { signature: _signature, ...unsigned } = event;
  const downgraded = {
    ...unsigned,
    schemaVersion: 'viewport.context_event/v0',
  };
  fs.writeFileSync(eventFile, `${JSON.stringify({
    ...downgraded,
    signature: signEnvelope(downgraded, aliceVault.getIdentity('alice')),
  }, null, 2)}\n`);

  assert.throws(
    () => aliceVault.rebuild({ repoId: 'project-api', actorName: 'alice' }),
    /Invalid context event schema/,
  );
});
