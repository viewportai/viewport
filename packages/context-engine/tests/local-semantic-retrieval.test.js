const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pairedVaults } = require('./helpers');

test('local semantic retrieval ranks related context without remote plaintext calls', () => {
  const { aliceVault } = pairedVaults();
  const repoId = 'project-api';

  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'resource',
    title: 'Authentication session standard',
    body: 'Login changes must include session rotation regression proof before merge.',
    source: 'git://api/AGENTS.md#auth',
  });
  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'resource',
    title: 'Deployment calendar',
    body: 'Production deployments happen on Tuesday after release approval.',
    source: 'git://api/AGENTS.md#deploy',
  });

  const bundle = aliceVault.resolveBundle({
    repoId,
    actorName: 'alice',
    query: 'What authentication proof is needed for a login change?',
    maxItems: 1,
  });

  assert.equal(bundle.delivery.items.length, 1);
  assert.equal(bundle.delivery.items[0].title, 'Authentication session standard');
  assert.equal(bundle.manifest.retrieval.mode, 'local-semantic');
  assert.equal(bundle.manifest.retrieval.local_only, true);
  assert.equal(bundle.manifest.retrieval.remote_plaintext_calls, 0);
  assert.equal(bundle.manifest.index.embedding_model_id, 'viewport-local-hash-embed-v0');
  assert.equal(bundle.manifest.items[0].body_mode, 'included');
  assert.equal(bundle.manifest.items[0].retrieval_score > 0, true);
});
