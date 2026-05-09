const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pairedVaults } = require('./helpers');

test('context profile registry drives bundle retrieval policy and records digest', () => {
  const { aliceVault } = pairedVaults();
  const repoId = 'project-api';

  const profile = aliceVault.writeProfile({
    repoId,
    name: 'code-review',
    profile: {
      packs: ['project-standards', 'review-rules'],
      query: 'What auth regression proof is needed for review?',
      maxItems: 1,
    },
  });

  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'resource',
    title: 'Auth review standard',
    body: 'Code reviews touching auth need session rotation regression proof.',
    source: 'git://api/context-profiles/code-review.json',
  });
  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'resource',
    title: 'Release window',
    body: 'Deployments use the release calendar.',
    source: 'git://api/context-profiles/release.json',
  });

  const bundle = aliceVault.resolveBundle({
    repoId,
    actorName: 'alice',
    profile: 'code-review',
  });

  assert.equal(bundle.delivery.items.length, 1);
  assert.equal(bundle.delivery.items[0].title, 'Auth review standard');
  assert.equal(bundle.manifest.profile.name, 'code-review');
  assert.equal(bundle.manifest.profile.path, '.viewport/context/profiles/code-review.json');
  assert.equal(bundle.manifest.profile.digest, profile.digest);
  assert.deepEqual(bundle.manifest.request.packs, ['project-standards', 'review-rules']);
});

test('context profile registry refuses path or digest drift when pinned', () => {
  const { aliceVault } = pairedVaults();
  const repoId = 'project-api';

  const profile = aliceVault.writeProfile({
    repoId,
    name: 'code-review',
    profile: {
      packs: ['project-standards'],
      query: 'auth review',
      maxItems: 1,
    },
  });

  assert.throws(
    () => aliceVault.resolveBundle({
      repoId,
      actorName: 'alice',
      profile: 'code-review',
      profilePin: {
        path: '.viewport/context/profiles/code-review.json',
        digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
    }),
    (error) => error.code === 'CONTEXT_PROFILE_PIN_MISMATCH'
      && error.mismatches.some((mismatch) => mismatch.field === 'digest'),
  );

  assert.throws(
    () => aliceVault.resolveBundle({
      repoId,
      actorName: 'alice',
      profile: 'code-review',
      profilePin: {
        path: '.viewport/context/profiles/release.json',
        digest: profile.digest,
      },
    }),
    (error) => error.code === 'CONTEXT_PROFILE_PIN_MISMATCH'
      && error.mismatches.some((mismatch) => mismatch.field === 'path'),
  );

  const bundle = aliceVault.resolveBundle({
    repoId,
    actorName: 'alice',
    profile: 'code-review',
    profilePin: {
      path: profile.path,
      digest: profile.digest,
    },
  });

  assert.equal(bundle.manifest.profile.path, profile.path);
  assert.equal(bundle.manifest.profile.digest, profile.digest);
});
