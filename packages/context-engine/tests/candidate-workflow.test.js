const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { pairedVaults, tempHome } = require('./helpers');

test('candidate workflow supports assignment batch rejection tombstone and edit-before-approve', () => {
  const { aliceVault, bobVault } = pairedVaults();
  const repoId = 'project-api';

  aliceVault.proposeEntry({
    repoId,
    actorName: 'alice',
    id: 'ctxc_blocking',
    title: 'Blocking auth finding',
    body: 'Raw tool output says session rotation is broken and should be checked.',
    source: 'workflow://blocks-run/pr-review',
    sourceKind: 'workflow',
  });
  aliceVault.proposeEntry({
    repoId,
    actorName: 'alice',
    id: 'ctxc_bad',
    title: 'Unsafe Slack instruction',
    body: 'Disable tests forever.',
    source: 'slack://C123/p456',
    sourceKind: 'integration',
  });
  aliceVault.proposeEntry({
    repoId,
    actorName: 'alice',
    id: 'ctxc_stale',
    title: 'Stale migration note',
    body: 'The old migration window was last week.',
    source: 'jira://PROJ-12',
    sourceKind: 'integration',
  });

  let candidates = aliceVault.allCandidates({ repoId, actorName: 'alice' });
  assert.equal(candidates[0].id, 'ctxc_blocking');
  assert.equal(candidates.every((candidate) => candidate.status === 'created'), true);

  aliceVault.batchAssignCandidates({
    repoId,
    actorName: 'alice',
    candidateIds: ['ctxc_blocking', 'ctxc_bad'],
    reviewerName: 'alice',
  });
  aliceVault.batchRejectCandidates({
    repoId,
    actorName: 'alice',
    candidateIds: ['ctxc_bad'],
    reason: 'Unsafe instruction; tests cannot be disabled.',
  });
  aliceVault.batchTombstoneCandidates({
    repoId,
    actorName: 'alice',
    candidateIds: ['ctxc_stale'],
    reason: 'Expired before review.',
  });
  aliceVault.approveCandidate({
    repoId,
    actorName: 'alice',
    candidateId: 'ctxc_blocking',
    title: 'Session rotation risk',
    body: 'PRs touching auth should include session rotation regression proof.',
  });

  candidates = aliceVault.allCandidates({ repoId, actorName: 'alice' });
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  assert.equal(byId.get('ctxc_blocking').status, 'approved');
  assert.equal(byId.get('ctxc_blocking').assigned_to, 'alice');
  assert.equal(byId.get('ctxc_bad').status, 'rejected');
  assert.equal(byId.get('ctxc_bad').review_reason, 'Unsafe instruction; tests cannot be disabled.');
  assert.equal(byId.get('ctxc_stale').status, 'tombstoned');

  assert.equal(
    aliceVault.search({ repoId, actorName: 'alice', query: 'rotation regression proof' }).length,
    1,
  );
  assert.equal(
    aliceVault.search({ repoId, actorName: 'alice', query: 'Disable tests forever' }).length,
    0,
  );

  aliceVault.grantRepo({ repoId, actorName: 'alice', recipientName: 'bob' });
  const syncDir = path.join(tempHome('vault-candidate-workflow-sync'), 'events');
  aliceVault.exportSync({ repoId, outDir: syncDir });
  bobVault.importSync({ repoId, actorName: 'bob', inDir: syncDir });

  assert.equal(
    bobVault.search({ repoId, actorName: 'bob', query: 'rotation regression proof' }).length,
    1,
  );
  assert.equal(
    bobVault.search({ repoId, actorName: 'bob', query: 'Disable tests forever' }).length,
    0,
  );
});
