const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { pairedVaults, readAllText } = require('./helpers');

test('materialized index can be deleted and rebuilt from encrypted event log', () => {
  const { aliceVault } = pairedVaults();
  const sensitiveBody = 'Auth incident last week: rotate session tokens before touching login.';

  aliceVault.addEntry({
    repoId: 'project-api',
    actorName: 'alice',
    scope: 'resource',
    title: 'Auth incident guardrail',
    body: sensitiveBody,
    source: 'incident://auth-rotation',
  });

  const first = aliceVault.resolveBundle({
    repoId: 'project-api',
    actorName: 'alice',
    query: 'auth incident',
    maxItems: 1,
  });
  assert.equal(first.delivery.items[0]?.body, sensitiveBody);

  const repoDir = path.join(aliceVault.home, 'repos', 'project-api');
  const dbPath = path.join(repoDir, 'materialized.sqlite');
  assert.equal(fs.existsSync(dbPath), true);
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
  assert.equal(fs.existsSync(dbPath), false);

  const eventLogText = readAllText(path.join(repoDir, 'events'));
  assert.equal(eventLogText.includes(sensitiveBody), false);

  const rebuilt = aliceVault.resolveBundle({
    repoId: 'project-api',
    actorName: 'alice',
    query: 'auth incident',
    maxItems: 1,
  });
  assert.equal(fs.existsSync(dbPath), true);
  assert.equal(rebuilt.delivery.items[0]?.body, sensitiveBody);
  assert.equal(rebuilt.manifest.items.length, 1);
  assert.equal(rebuilt.manifest.retrieval.remote_plaintext_calls, 0);
});
