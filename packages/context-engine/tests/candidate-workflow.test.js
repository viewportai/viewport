const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { decryptJson } = require('../src/crypto/envelope');
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
  assert.equal(
    candidates.every((candidate) => candidate.status === 'created'),
    true,
  );

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
  const byId = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  assert.equal(byId.get('ctxc_blocking').status, 'approved');
  assert.equal(byId.get('ctxc_blocking').assigned_to, 'alice');
  assert.equal(byId.get('ctxc_bad').status, 'rejected');
  assert.equal(
    byId.get('ctxc_bad').review_reason,
    'Unsafe instruction; tests cannot be disabled.',
  );
  assert.equal(byId.get('ctxc_stale').status, 'tombstoned');

  assert.equal(
    aliceVault.search({
      repoId,
      actorName: 'alice',
      query: 'rotation regression proof',
    }).length,
    1,
  );
  assert.equal(
    aliceVault.search({
      repoId,
      actorName: 'alice',
      query: 'Disable tests forever',
    }).length,
    0,
  );

  aliceVault.grantRepo({ repoId, actorName: 'alice', recipientName: 'bob' });
  const syncDir = path.join(
    tempHome('vault-candidate-workflow-sync'),
    'events',
  );
  aliceVault.exportSync({ repoId, outDir: syncDir });
  bobVault.importSync({ repoId, actorName: 'bob', inDir: syncDir });

  assert.equal(
    bobVault.search({
      repoId,
      actorName: 'bob',
      query: 'rotation regression proof',
    }).length,
    1,
  );
  assert.equal(
    bobVault.search({
      repoId,
      actorName: 'bob',
      query: 'Disable tests forever',
    }).length,
    0,
  );
});

test('candidate approval events preserve the platform decision audit chain inside encrypted payloads', () => {
  const { aliceVault } = pairedVaults();
  const repoId = 'project-api';

  aliceVault.proposeEntry({
    repoId,
    actorName: 'alice',
    id: 'ctxc_audit_chain',
    title: 'Audit chain candidate',
    body: 'Approved context should point back to the human Inbox decision.',
    source: 'workflow://audit-chain',
    sourceKind: 'workflow',
  });

  const review = {
    platformDecisionId: 'ctxd_inbox_123',
    platformInboxItemId: 'inbox_123',
    decidedByUserId: '42',
    decidedAt: '2026-05-07T16:00:00.000Z',
    platformSignatureDigest: 'sha256:decision-signature-digest',
  };
  const result = aliceVault.approveCandidate({
    repoId,
    actorName: 'alice',
    candidateId: 'ctxc_audit_chain',
    title: 'Audit chain candidate',
    body: 'Approved context should point back to the human Inbox decision.',
    source: 'workflow://audit-chain',
    review,
  });

  const repoKey = aliceVault.getRepoKey(repoId, result.entry.keyEpoch);
  const entryPayload = decryptJson(result.entry.encrypted, repoKey);
  const approvalPayload = decryptJson(result.approved.encrypted, repoKey);

  assert.deepEqual(entryPayload.review, review);
  assert.deepEqual(approvalPayload.review, review);

  const eventsDir = path.join(aliceVault.home, 'repos', repoId, 'events');
  const latestEvent = fs.readdirSync(eventsDir).sort().at(-1);
  const rawEvents = fs.readFileSync(path.join(eventsDir, latestEvent), 'utf8');
  assert.equal(rawEvents.includes('Approved context should point back'), false);
  assert.equal(rawEvents.includes('ctxd_inbox_123'), false);
});

test('duplicate candidate approvals converge to one approved entry', () => {
  const { aliceVault } = pairedVaults();
  const repoId = 'project-api';

  aliceVault.proposeEntry({
    repoId,
    actorName: 'alice',
    id: 'ctxc_multi_edge',
    title: 'Multi-edge candidate',
    body: 'Concurrent trusted edges should converge on one reusable context entry.',
    source: 'workflow://multi-edge',
    sourceKind: 'workflow',
  });

  aliceVault.approveCandidate({
    repoId,
    actorName: 'alice',
    candidateId: 'ctxc_multi_edge',
    title: 'Multi-edge candidate',
    body: 'Concurrent trusted edges should converge on one reusable context entry.',
    source: 'workflow://multi-edge',
    review: { platformDecisionId: 'ctxd_multi_edge' },
  });
  aliceVault.approveCandidate({
    repoId,
    actorName: 'alice',
    candidateId: 'ctxc_multi_edge',
    title: 'Multi-edge candidate',
    body: 'Concurrent trusted edges should converge on one reusable context entry.',
    source: 'workflow://multi-edge',
    review: { platformDecisionId: 'ctxd_multi_edge' },
  });

  const matches = aliceVault.search({
    repoId,
    actorName: 'alice',
    query: 'Concurrent trusted edges',
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 'ctxe_from_ctxc_multi_edge');
});
