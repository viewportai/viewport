const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { pairedVaults, readAllText, tempHome } = require('./helpers');

test('private context can participate in a local bundle without leaking through sync', () => {
  const { aliceVault, bobVault } = pairedVaults();
  const privateBody = 'My private local checkout is /Users/alice/work/secret-api.';

  aliceVault.addEntry({
    repoId: 'project-api',
    actorName: 'alice',
    scope: 'resource',
    title: 'Shared auth rule',
    body: 'Authentication changes require replay protection tests.',
  });
  aliceVault.addEntry({
    repoId: 'project-api',
    actorName: 'alice',
    scope: 'private',
    title: 'Private checkout note',
    body: privateBody,
    source: 'private-local://checkout',
  });
  aliceVault.grantRepo({ repoId: 'project-api', actorName: 'alice', recipientName: 'bob' });

  const localBundle = aliceVault.resolveBundle({
    repoId: 'project-api',
    actorName: 'alice',
    packs: ['pr-readiness'],
    target: { type: 'pull_request', ref: '123' },
    includePrivate: true,
  });

  const privateManifestItem = localBundle.manifest.items.find((item) => item.scope === 'private');
  assert.equal(privateManifestItem.body_mode, 'redacted');
  assert.equal(privateManifestItem.title, 'Private context item');
  assert.equal(privateManifestItem.source, 'private://redacted');
  assert.equal(JSON.stringify(localBundle.manifest).includes(privateBody), false);
  assert.equal(JSON.stringify(localBundle.manifest).includes('Private checkout note'), false);
  assert.equal(JSON.stringify(localBundle.manifest).includes('private-local://checkout'), false);
  assert.equal(localBundle.delivery.items.some((item) => item.body === privateBody), true);

  const syncDir = path.join(tempHome('vault-sync'), 'events');
  aliceVault.exportSync({ repoId: 'project-api', outDir: syncDir });
  assert.equal(readAllText(syncDir).includes(privateBody), false);

  bobVault.importSync({ repoId: 'project-api', actorName: 'bob', inDir: syncDir });
  const bobSearch = bobVault.search({
    repoId: 'project-api',
    actorName: 'bob',
    query: 'secret-api',
  });
  assert.equal(bobSearch.length, 0);
});
