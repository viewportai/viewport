const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const path = require('node:path');
const { signEnvelope } = require('../src/crypto/signatures');
const { ContextVault } = require('../src');
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

test('revoked HPKE recipient cannot decrypt context added after repo key rotation', async () => {
  const { aliceVault, bobVault } = pairedVaults();
  const repoId = 'project-hpke-revocation';
  const initialBody = 'Initial context remains readable before revoke.';
  const futureBody = 'Future context after revoke must stay hidden from Bob.';

  await aliceVault.createRepoHpke(repoId, 'alice');
  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'resource',
    title: 'Initial context',
    body: initialBody,
    source: 'manual://initial',
  });
  await aliceVault.grantRepoHpke({ repoId, actorName: 'alice', recipientName: 'bob' });

  await bobVault.importSyncEvents({
    repoId,
    actorName: 'bob',
    events: aliceVault.listSyncEvents({ repoId }),
  });
  assert.equal(
    bobVault.search({ repoId, actorName: 'bob', query: 'Initial context' })[0]?.body,
    initialBody,
  );

  const revokeResult = await aliceVault.revokeRepoHpke({
    repoId,
    actorName: 'alice',
    recipientName: 'bob',
  });
  assert.equal(revokeResult.revokeEvent.type, 'member.revoked');
  assert.equal(revokeResult.revokeEvent.grant.revokedName, 'bob');
  assert.equal(revokeResult.rotateEvents.every((event) => event.grant.recipientName !== 'bob'), true);

  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'resource',
    title: 'Future context',
    body: futureBody,
    source: 'manual://future',
  });

  await bobVault.importSyncEvents({
    repoId,
    actorName: 'bob',
    events: aliceVault.listSyncEvents({ repoId }),
  });

  assert.equal(bobVault.search({ repoId, actorName: 'bob', query: 'Initial context' }).length, 1);
  assert.equal(bobVault.search({ repoId, actorName: 'bob', query: 'Future context' }).length, 0);
});

test('team epoch revocation rotates the context repo key to remaining team epochs only', async () => {
  const aliceVault = new ContextVault(tempHome('vault-team-owner'));
  const revokedTeamVault = new ContextVault(tempHome('vault-team-revoked'));
  const remainingTeamVault = new ContextVault(tempHome('vault-team-remaining'));
  const repoId = 'project-team-revocation';
  const initialBody = 'Team-shared context before revoke.';
  const futureBody = 'Future context after team revoke belongs to remaining team only.';

  aliceVault.createIdentity('alice');
  revokedTeamVault.createIdentity('team-alpha-epoch-1');
  remainingTeamVault.createIdentity('team-beta-epoch-1');
  aliceVault.importPublicIdentity(revokedTeamVault.exportPublicIdentity('team-alpha-epoch-1'));
  aliceVault.importPublicIdentity(remainingTeamVault.exportPublicIdentity('team-beta-epoch-1'));
  revokedTeamVault.importPublicIdentity(aliceVault.exportPublicIdentity('alice'));
  remainingTeamVault.importPublicIdentity(aliceVault.exportPublicIdentity('alice'));

  await aliceVault.createRepoHpke(repoId, 'alice');
  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'resource',
    title: 'Initial team context',
    body: initialBody,
    source: 'manual://team-initial',
  });
  await aliceVault.grantRepoHpkeRecipient({
    repoId,
    actorName: 'alice',
    recipient: {
      name: 'team-alpha-epoch-1',
      hpkePublicKey: revokedTeamVault.exportPublicIdentity('team-alpha-epoch-1').hpkePublicKey,
    },
  });
  await aliceVault.grantRepoHpkeRecipient({
    repoId,
    actorName: 'alice',
    recipient: {
      name: 'team-beta-epoch-1',
      hpkePublicKey: remainingTeamVault.exportPublicIdentity('team-beta-epoch-1').hpkePublicKey,
    },
  });

  await revokedTeamVault.importSyncEvents({
    repoId,
    actorName: 'team-alpha-epoch-1',
    events: aliceVault.listSyncEvents({ repoId }),
  });
  await remainingTeamVault.importSyncEvents({
    repoId,
    actorName: 'team-beta-epoch-1',
    events: aliceVault.listSyncEvents({ repoId }),
  });
  assert.equal(
    revokedTeamVault.search({ repoId, actorName: 'team-alpha-epoch-1', query: 'Initial team context' })[0]?.body,
    initialBody,
  );

  const revokeResult = await aliceVault.revokeRepoHpke({
    repoId,
    actorName: 'alice',
    recipientName: 'team-alpha-epoch-1',
  });
  assert.equal(revokeResult.rotateEvents.length, 2);
  assert.deepEqual(
    revokeResult.rotateEvents.map((event) => event.grant.recipientName).sort(),
    ['alice', 'team-beta-epoch-1'],
  );

  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'resource',
    title: 'Future team context',
    body: futureBody,
    source: 'manual://team-future',
  });
  const rotatedEvents = aliceVault.listSyncEvents({ repoId });

  await revokedTeamVault.importSyncEvents({
    repoId,
    actorName: 'team-alpha-epoch-1',
    events: rotatedEvents,
  });
  await remainingTeamVault.importSyncEvents({
    repoId,
    actorName: 'team-beta-epoch-1',
    events: rotatedEvents,
  });

  assert.equal(
    revokedTeamVault.search({ repoId, actorName: 'team-alpha-epoch-1', query: 'Future team context' }).length,
    0,
  );
  assert.equal(
    remainingTeamVault.search({ repoId, actorName: 'team-beta-epoch-1', query: 'Future team context' })[0]?.body,
    futureBody,
  );
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
