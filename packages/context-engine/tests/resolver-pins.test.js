const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ResolverPinMismatchError } = require('../src');
const { pairedVaults } = require('./helpers');

function addSharedRule(vault) {
  vault.addEntry({
    repoId: 'project-api',
    actorName: 'alice',
    scope: 'resource',
    title: 'Pinned resolver rule',
    body: 'Use pinned resolver versions before delivering context to agents.',
  });
}

test('resolver pin mismatch refuses before context is delivered', () => {
  const { aliceVault } = pairedVaults();
  addSharedRule(aliceVault);

  assert.throws(
    () => aliceVault.resolveBundle({
      repoId: 'project-api',
      actorName: 'alice',
      pins: {
        resolverVersion: '9.9.9',
        vectorIndexEngine: 'remote-vector-store',
      },
    }),
    (error) => {
      assert.equal(error instanceof ResolverPinMismatchError, true);
      assert.equal(error.code, 'CONTEXT_RESOLVER_PIN_MISMATCH');
      assert.deepEqual(
        error.mismatches.map((mismatch) => mismatch.field),
        ['resolverVersion', 'vectorIndexEngine'],
      );
      assert.equal(error.mismatches[0].expected, '9.9.9');
      assert.equal(error.mismatches[0].actual, '0.0.1');
      return true;
    },
  );
});

test('resolver pin override is explicit and recorded in the manifest', () => {
  const { aliceVault } = pairedVaults();
  addSharedRule(aliceVault);

  const bundle = aliceVault.resolveBundle({
    repoId: 'project-api',
    actorName: 'alice',
    pins: {
      resolverVersion: '9.9.9',
    },
    override: {
      reason: 'Manual compatibility smoke test.',
    },
  });

  assert.equal(bundle.delivery.items.length, 1);
  assert.equal(bundle.manifest.override.reason, 'Manual compatibility smoke test.');
  assert.equal(bundle.manifest.override.actor_name, 'alice');
  assert.deepEqual(
    bundle.manifest.override.mismatches.map((mismatch) => mismatch.field),
    ['resolverVersion'],
  );
  assert.equal(bundle.manifest.index.engine, 'sqlite-fts5+local-hash-embeddings');
  assert.equal(bundle.manifest.index.embedding_model_id, 'viewport-local-hash-embed-v0');
});
