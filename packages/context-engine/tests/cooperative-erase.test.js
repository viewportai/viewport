const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { pairedVaults, tempHome } = require('./helpers');

test('revoked client can cooperatively erase local cache and emit signed receipt', () => {
  const { aliceVault, bobVault } = pairedVaults();
  const repoId = 'project-api';
  const firstSync = path.join(tempHome('vault-erase-sync-one'), 'events');
  const secondSync = path.join(tempHome('vault-erase-sync-two'), 'events');

  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'project',
    title: 'Shared rule before erase',
    body: 'Bob can see this before revocation.',
  });
  aliceVault.grantRepo({ repoId, actorName: 'alice', recipientName: 'bob' });
  aliceVault.exportSync({ repoId, outDir: firstSync });
  bobVault.importSync({ repoId, actorName: 'bob', inDir: firstSync });
  assert.equal(bobVault.search({ repoId, actorName: 'bob', query: 'before revocation' }).length, 1);

  const { revokeEvent } = aliceVault.revokeRepo({ repoId, actorName: 'alice', recipientName: 'bob' });
  aliceVault.exportSync({ repoId, outDir: secondSync });
  bobVault.importSync({ repoId, actorName: 'bob', inDir: secondSync });

  const receipt = bobVault.cooperativeErase({
    repoId,
    actorName: 'bob',
    revocationEventId: revokeEvent.id,
  });

  assert.equal(receipt.schemaVersion, 'viewport.context_erase_receipt/v1');
  assert.equal(receipt.cacheTombstoned, true);
  assert.equal(bobVault.verifyEraseReceipt({ repoId, receipt }), true);
  assert.equal(bobVault.search({ repoId, actorName: 'bob', query: 'before revocation' }).length, 0);
});
