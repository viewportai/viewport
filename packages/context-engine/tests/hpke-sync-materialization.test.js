const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { ContextVault } = require('../src');
const { readAllText, tempHome } = require('./helpers');

test('HPKE grants can sync and materialize approved shared context', async () => {
  const aliceVault = new ContextVault(tempHome('vault-hpke-sync-alice'));
  const bobVault = new ContextVault(tempHome('vault-hpke-sync-bob'));
  const syncDir = path.join(tempHome('vault-hpke-sync'), 'events');
  const repoId = 'project-hpke';
  const sharedBody = 'HPKE-synced context is readable by authorized trusted edges only.';

  aliceVault.createIdentity('alice');
  bobVault.createIdentity('bob');
  aliceVault.importPublicIdentity(bobVault.exportPublicIdentity('bob'));
  bobVault.importPublicIdentity(aliceVault.exportPublicIdentity('alice'));
  await aliceVault.createRepoHpke(repoId, 'alice');
  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'resource',
    title: 'HPKE sync rule',
    body: sharedBody,
  });
  await aliceVault.grantRepoHpke({ repoId, actorName: 'alice', recipientName: 'bob' });

  aliceVault.exportSync({ repoId, outDir: syncDir });
  const syncText = readAllText(syncDir);
  assert.equal(syncText.includes(sharedBody), false);
  assert.equal(syncText.includes('viewport.context_key_grant/hpke-draft-01'), true);

  await bobVault.importSyncHpke({ repoId, actorName: 'bob', inDir: syncDir });
  const results = bobVault.search({ repoId, actorName: 'bob', query: 'trusted edges' });

  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'HPKE sync rule');
});

test('legacy sync materializer refuses HPKE grants without async HPKE materialization', async () => {
  const aliceVault = new ContextVault(tempHome('vault-hpke-refuse-alice'));
  const bobVault = new ContextVault(tempHome('vault-hpke-refuse-bob'));
  const syncDir = path.join(tempHome('vault-hpke-refuse'), 'events');
  const repoId = 'project-hpke-refuse';

  aliceVault.createIdentity('alice');
  bobVault.createIdentity('bob');
  aliceVault.importPublicIdentity(bobVault.exportPublicIdentity('bob'));
  bobVault.importPublicIdentity(aliceVault.exportPublicIdentity('alice'));
  await aliceVault.createRepoHpke(repoId, 'alice');
  await aliceVault.grantRepoHpke({ repoId, actorName: 'alice', recipientName: 'bob' });
  aliceVault.exportSync({ repoId, outDir: syncDir });

  assert.throws(
    () => bobVault.importSync({ repoId, actorName: 'bob', inDir: syncDir }),
    /requires async materialization/,
  );
});
