const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { pairedVaults, tempHome } = require('./helpers');

test('trusted edge resolves cached approved context offline with manifest state', () => {
  const { aliceVault, bobVault } = pairedVaults();
  const syncDir = path.join(tempHome('vault-offline-sync'), 'events');

  aliceVault.addEntry({
    repoId: 'project-api',
    actorName: 'alice',
    scope: 'resource',
    title: 'Offline review rule',
    body: 'Offline agents may use cached approved context with stale manifest state.',
  });
  aliceVault.grantRepo({ repoId: 'project-api', actorName: 'alice', recipientName: 'bob' });
  aliceVault.exportSync({ repoId: 'project-api', outDir: syncDir });
  bobVault.importSync({ repoId: 'project-api', actorName: 'bob', inDir: syncDir });

  const bundle = bobVault.resolveBundle({
    repoId: 'project-api',
    actorName: 'bob',
    query: 'Can offline agents use cached approved context?',
    maxItems: 1,
    offline: true,
    lastSyncAt: '2026-05-06T12:00:00.000Z',
  });

  assert.equal(bundle.delivery.items.length, 1);
  assert.equal(bundle.manifest.offline.active, true);
  assert.equal(bundle.manifest.offline.last_sync_at, '2026-05-06T12:00:00.000Z');
  assert.equal(bundle.manifest.retrieval.local_only, true);
});
