const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { test } = require('node:test');
const { pairedVaults } = require('./helpers');

const ENTRY_COUNT = 1000;
const MAX_ITEMS = 25;
const LOAD_BUDGET_MS = Number(process.env.CONTEXT_LARGE_VAULT_BUDGET_MS ?? '5000');

test('large vault bundle resolution stays bounded and within load budget', (t) => {
  const { aliceVault } = pairedVaults();

  for (let index = 0; index < ENTRY_COUNT; index += 1) {
    aliceVault.addEntry({
      repoId: 'project-api',
      actorName: 'alice',
      scope: 'resource',
      title: `Session rotation note ${String(index).padStart(4, '0')}`,
      body: `Run session rotation tests for auth-sensitive paths. Load proof note ${index}.`,
      source: `test://large-vault/${index}`,
    });
  }

  const started = performance.now();
  const bundle = aliceVault.resolveBundle({
    repoId: 'project-api',
    actorName: 'alice',
    query: 'session rotation auth',
    maxItems: MAX_ITEMS,
  });
  const elapsedMs = performance.now() - started;
  t.diagnostic(
    `resolved ${ENTRY_COUNT} entries to ${MAX_ITEMS} delivery items in ${Math.round(elapsedMs)}ms`,
  );

  assert.equal(bundle.delivery.items.length, MAX_ITEMS);
  assert.equal(bundle.manifest.items.length, MAX_ITEMS);
  assert.equal(bundle.manifest.request.max_items, MAX_ITEMS);
  assert.equal(bundle.manifest.retrieval.remote_plaintext_calls, 0);
  assert.ok(
    elapsedMs < LOAD_BUDGET_MS,
    `expected 1k-entry resolve under ${LOAD_BUDGET_MS}ms, got ${Math.round(elapsedMs)}ms`,
  );
});
