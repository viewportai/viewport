const assert = require('node:assert/strict');
const { test } = require('node:test');
const { digestBundleManifest } = require('../src/repo/bundles');
const { pairedVaults } = require('./helpers');

test('bundle manifests are deterministic and change when active context is superseded', () => {
  const { aliceVault } = pairedVaults();
  aliceVault.addEntry({
    repoId: 'project-api',
    actorName: 'alice',
    scope: 'resource',
    title: 'Testing rule',
    body: 'Run the focused auth test suite before merge.',
  });

  const first = aliceVault.resolveBundle({
    repoId: 'project-api',
    actorName: 'alice',
    packs: ['testing-policy'],
    target: { type: 'branch', ref: 'feature/auth' },
  });
  const second = aliceVault.resolveBundle({
    repoId: 'project-api',
    actorName: 'alice',
    packs: ['testing-policy'],
    target: { type: 'branch', ref: 'feature/auth' },
  });

  assert.equal(first.manifest.digest, second.manifest.digest);
  assert.equal(
    digestBundleManifest(JSON.parse(JSON.stringify(first.manifest))),
    first.manifest.digest,
  );

  aliceVault.supersedeEntry({
    repoId: 'project-api',
    actorName: 'alice',
    entryId: first.manifest.items[0].entry_id,
    title: 'Testing rule',
    body: 'Run auth tests and session replay tests before merge.',
  });

  const third = aliceVault.resolveBundle({
    repoId: 'project-api',
    actorName: 'alice',
    packs: ['testing-policy'],
    target: { type: 'branch', ref: 'feature/auth' },
  });

  assert.notEqual(third.manifest.digest, first.manifest.digest);
  assert.equal(
    digestBundleManifest(JSON.parse(JSON.stringify(third.manifest))),
    third.manifest.digest,
  );
  assert.equal(third.manifest.items.length, 1);
  assert.equal(third.delivery.items[0].body, 'Run auth tests and session replay tests before merge.');

  const rebuilt = aliceVault.rebuild({ repoId: 'project-api', actorName: 'alice' });
  assert.equal(rebuilt.entries.filter((row) => !row.superseded_by).length, 1);
});
