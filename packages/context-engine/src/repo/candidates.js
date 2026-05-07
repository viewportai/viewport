function candidatePriority(options) {
  const sourceKind = options.sourceKind ?? 'integration';
  const source = options.source ?? '';
  let score = 10;

  if (sourceKind === 'workflow') {
    score += 40;
  }

  if (sourceKind === 'plan') {
    score += 30;
  }

  if (sourceKind === 'integration') {
    score += 20;
  }

  if (source.includes('blocks-run') || source.includes('approval-gate')) {
    score += 30;
  }

  return score;
}

function proposeEntry(vault, options) {
  const payload = {
    id: options.id ?? `ctxc_${cryptoRandomUuid()}`,
    title: options.title,
    body: options.body,
    source: options.source ?? 'integration://unknown',
    sourceKind: options.sourceKind ?? 'integration',
    trustState: 'candidate',
    status: 'created',
    priorityScore: options.priorityScore ?? candidatePriority(options),
    createdAt: options.createdAt ?? new Date().toISOString(),
  };

  return vault.appendSharedEvent({
    repoId: options.repoId,
    actorName: options.actorName,
    type: 'entry.proposed',
    payload,
  });
}

function approveCandidate(vault, { repoId, actorName, candidateId, title, body, source, review = null }) {
  const approved = vault.appendSharedEvent({
    repoId,
    actorName,
    type: 'candidate.approved',
    payload: {
      id: candidateId,
      reviewedBy: actorName,
      reviewedAt: new Date().toISOString(),
      review,
    },
  });

  const entry = vault.addEntry({
    repoId,
    actorName,
    scope: 'project',
    title,
    body,
    source: source ?? `candidate://${candidateId}`,
    sourceKind: 'human',
    trustState: 'approved',
    review,
  });

  return { approved, entry };
}

function assignCandidate(vault, { repoId, actorName, candidateId, reviewerName }) {
  return vault.appendSharedEvent({
    repoId,
    actorName,
    type: 'candidate.assigned',
    payload: {
      id: candidateId,
      assignedTo: reviewerName,
      reviewedAt: new Date().toISOString(),
    },
  });
}

function rejectCandidate(vault, { repoId, actorName, candidateId, reason }) {
  return vault.appendSharedEvent({
    repoId,
    actorName,
    type: 'candidate.rejected',
    payload: {
      id: candidateId,
      reviewedBy: actorName,
      reviewReason: reason,
      reviewedAt: new Date().toISOString(),
    },
  });
}

function tombstoneCandidate(vault, { repoId, actorName, candidateId, reason }) {
  return vault.appendSharedEvent({
    repoId,
    actorName,
    type: 'candidate.tombstoned',
    payload: {
      id: candidateId,
      reviewedBy: actorName,
      reviewReason: reason,
      tombstonedAt: new Date().toISOString(),
    },
  });
}

function batchAssignCandidates(vault, { repoId, actorName, candidateIds, reviewerName }) {
  return candidateIds.map((candidateId) => assignCandidate(vault, {
    repoId,
    actorName,
    candidateId,
    reviewerName,
  }));
}

function batchRejectCandidates(vault, { repoId, actorName, candidateIds, reason }) {
  return candidateIds.map((candidateId) => rejectCandidate(vault, {
    repoId,
    actorName,
    candidateId,
    reason,
  }));
}

function batchTombstoneCandidates(vault, { repoId, actorName, candidateIds, reason }) {
  return candidateIds.map((candidateId) => tombstoneCandidate(vault, {
    repoId,
    actorName,
    candidateId,
    reason,
  }));
}

function decayCandidates(vault, { repoId, actorName, staleAfterDays = 14, now = new Date() }) {
  const candidates = vault.allCandidates({ repoId, actorName });
  const cutoffMs = now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000;
  const staleCandidateIds = candidates
    .filter((candidate) => ['created', 'assigned'].includes(candidate.status))
    .filter((candidate) => new Date(candidate.created_at).getTime() < cutoffMs)
    .map((candidate) => candidate.id);

  if (staleCandidateIds.length === 0) {
    return [];
  }

  return batchTombstoneCandidates(vault, {
    repoId,
    actorName,
    candidateIds: staleCandidateIds,
    reason: `Candidate exceeded ${staleAfterDays} day review SLA.`,
  });
}

function cryptoRandomUuid() {
  return require('node:crypto').randomUUID();
}

module.exports = {
  approveCandidate,
  assignCandidate,
  batchAssignCandidates,
  batchRejectCandidates,
  batchTombstoneCandidates,
  candidatePriority,
  decayCandidates,
  proposeEntry,
  rejectCandidate,
  tombstoneCandidate,
};
