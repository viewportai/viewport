const assert = require('node:assert/strict');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const { test } = require('node:test');
const { ContextVault } = require('../src');
const { readAllText, tempHome } = require('./helpers');

function createTeamFixture(memberCount = 20) {
  const aliceVault = new ContextVault(tempHome('vault-scale-alice'));
  const memberVaults = new Map();

  aliceVault.createIdentity('alice');
  aliceVault.createRepo('project-scale', 'alice');

  for (let index = 1; index <= memberCount; index += 1) {
    const name = `member-${String(index).padStart(2, '0')}`;
    const memberVault = new ContextVault(tempHome(`vault-scale-${name}`));
    memberVault.createIdentity(name);
    memberVault.importPublicIdentity(aliceVault.exportPublicIdentity('alice'));
    aliceVault.importPublicIdentity(memberVault.exportPublicIdentity(name));
    memberVaults.set(name, memberVault);
  }

  return { aliceVault, memberVaults };
}

function syncInto(vault, repoId, actorName, sourceDir) {
  vault.importSync({ repoId, actorName, inDir: sourceDir });
}

function eventStats(syncDir) {
  const files = fs.readdirSync(syncDir).filter((file) => file.endsWith('.json'));
  const bytes = files.reduce((total, file) => total + fs.statSync(path.join(syncDir, file)).size, 0);
  const eventsByType = new Map();

  for (const file of files) {
    const event = JSON.parse(fs.readFileSync(path.join(syncDir, file), 'utf8'));
    eventsByType.set(event.type, (eventsByType.get(event.type) ?? 0) + 1);
  }

  return {
    bytes,
    eventCount: files.length,
    eventsByType: Object.fromEntries([...eventsByType].sort()),
  };
}

test('20-member grant revoke rotation preserves non-revoked access and blocks revoked future access', () => {
  const startedAt = performance.now();
  const repoId = 'project-scale';
  const { aliceVault, memberVaults } = createTeamFixture(20);

  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'project',
    title: 'Pre-revocation standard',
    body: 'Pre-revocation scale context is visible to the whole project.',
  });

  for (const recipientName of memberVaults.keys()) {
    aliceVault.grantRepo({ repoId, actorName: 'alice', recipientName });
  }

  const firstSync = path.join(tempHome('vault-scale-sync-one'), 'events');
  aliceVault.exportSync({ repoId, outDir: firstSync });

  for (const [memberName, memberVault] of memberVaults) {
    syncInto(memberVault, repoId, memberName, firstSync);
    assert.equal(
      memberVault.search({ repoId, actorName: memberName, query: 'whole project' }).length,
      1,
      `${memberName} should decrypt pre-revocation context`,
    );
  }

  const revokedNames = ['member-03', 'member-09', 'member-17'];
  for (const revokedName of revokedNames) {
    aliceVault.revokeRepo({ repoId, actorName: 'alice', recipientName: revokedName });
  }

  aliceVault.addEntry({
    repoId,
    actorName: 'alice',
    scope: 'project',
    title: 'Post-revocation standard',
    body: 'Post-revocation scale context is visible only to remaining members.',
  });

  const secondSync = path.join(tempHome('vault-scale-sync-two'), 'events');
  aliceVault.exportSync({ repoId, outDir: secondSync });

  for (const [memberName, memberVault] of memberVaults) {
    syncInto(memberVault, repoId, memberName, secondSync);

    const results = memberVault.search({
      repoId,
      actorName: memberName,
      query: 'remaining members',
    });

    if (revokedNames.includes(memberName)) {
      assert.equal(results.length, 0, `${memberName} should not decrypt post-revocation context`);
    } else {
      assert.equal(results.length, 1, `${memberName} should decrypt post-revocation context`);
    }
  }

  const elapsedMs = performance.now() - startedAt;
  const secondStats = eventStats(secondSync);
  const syncText = readAllText(secondSync);

  assert.equal(syncText.includes('Post-revocation scale context'), false);
  assert.equal(secondStats.eventsByType['member.revoked'], 3);
  assert.ok(secondStats.eventsByType['key.rotated'] >= 54);
  const budgetMs = Number(process.env.CONTEXT_SCALE_BUDGET_MS ?? 15000);
  assert.ok(
    elapsedMs < budgetMs,
    `expected scale proof under ${budgetMs}ms, got ${elapsedMs}ms`,
  );
});
