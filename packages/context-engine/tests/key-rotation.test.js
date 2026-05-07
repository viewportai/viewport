const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { pairedVaults, tempHome } = require('./helpers');

test('revocation rotates future keys while documenting retained old access', () => {
  const { aliceVault, bobVault } = pairedVaults();
  aliceVault.addEntry({
    repoId: 'project-api',
    actorName: 'alice',
    scope: 'project',
    title: 'Old shared rule',
    body: 'This pre-revocation rule is visible to Bob.',
  });
  aliceVault.grantRepo({ repoId: 'project-api', actorName: 'alice', recipientName: 'bob' });

  const firstSync = path.join(tempHome('vault-sync-one'), 'events');
  aliceVault.exportSync({ repoId: 'project-api', outDir: firstSync });
  bobVault.importSync({ repoId: 'project-api', actorName: 'bob', inDir: firstSync });
  assert.equal(bobVault.search({ repoId: 'project-api', actorName: 'bob', query: 'pre-revocation' }).length, 1);

  aliceVault.revokeRepo({ repoId: 'project-api', actorName: 'alice', recipientName: 'bob' });
  aliceVault.addEntry({
    repoId: 'project-api',
    actorName: 'alice',
    scope: 'project',
    title: 'New shared rule',
    body: 'This post-revocation rule must not decrypt for Bob.',
  });

  const secondSync = path.join(tempHome('vault-sync-two'), 'events');
  aliceVault.exportSync({ repoId: 'project-api', outDir: secondSync });
  bobVault.importSync({ repoId: 'project-api', actorName: 'bob', inDir: secondSync });

  assert.equal(bobVault.search({ repoId: 'project-api', actorName: 'bob', query: 'pre-revocation' }).length, 1);
  assert.equal(bobVault.search({ repoId: 'project-api', actorName: 'bob', query: 'post-revocation' }).length, 0);
});
