const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pairedVaults } = require('./helpers');

test('candidate decay tombstones stale unreviewed candidates and preserves active reviews', () => {
  const { aliceVault } = pairedVaults();
  const repoId = 'project-api';

  aliceVault.proposeEntry({
    repoId,
    actorName: 'alice',
    id: 'ctxc_old',
    title: 'Old unreviewed candidate',
    body: 'Old candidate should expire.',
    source: 'slack://C123/old',
    createdAt: '2026-04-01T00:00:00.000Z',
  });
  aliceVault.proposeEntry({
    repoId,
    actorName: 'alice',
    id: 'ctxc_fresh',
    title: 'Fresh candidate',
    body: 'Fresh candidate should stay reviewable.',
    source: 'slack://C123/fresh',
    createdAt: '2026-05-19T00:00:00.000Z',
  });
  aliceVault.batchAssignCandidates({
    repoId,
    actorName: 'alice',
    candidateIds: ['ctxc_fresh'],
    reviewerName: 'alice',
  });

  const staleNow = new Date('2026-05-20T00:00:00.000Z');
  const tombstones = aliceVault.decayCandidates({
    repoId,
    actorName: 'alice',
    staleAfterDays: 14,
    now: staleNow,
  });

  assert.equal(tombstones.length, 1);
  assert.equal(
    tombstones.every((event) => event.type === 'candidate.tombstoned'),
    true,
  );

  const secondVault = pairedVaults().aliceVault;
  secondVault.proposeEntry({
    repoId,
    actorName: 'alice',
    id: 'ctxc_not_stale',
    title: 'Recently proposed candidate',
    body: 'Recently proposed candidate should survive.',
    source: 'slack://C123/recent',
    createdAt: '2026-05-19T00:00:00.000Z',
  });

  const noTombstones = secondVault.decayCandidates({
    repoId,
    actorName: 'alice',
    staleAfterDays: 14,
    now: staleNow,
  });
  assert.equal(noTombstones.length, 0);

  const candidates = secondVault.allCandidates({ repoId, actorName: 'alice' });
  assert.equal(candidates[0].status, 'created');
});
