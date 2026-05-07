import { configDir } from '../core/config.js';
import { digestText } from './local-edge-crypto.js';
import {
  assertCredentialsOrApprovedDevice,
  createVault,
  ensureUserOrApprovedDevice,
} from './local-edge-engine.js';
import { readProjectMetadata, touchProjectMetadata } from './local-edge-metadata.js';
import { migrateLegacyProjectIfNeeded } from './local-edge-migration.js';
import {
  CONTEXT_EVENT_SCHEMA_VERSION,
  type ContextCandidateDecisionPullRecord,
  type ContextCandidateProposal,
  type ContextCredentials,
} from './local-edge-types.js';

export async function proposeContextEntry(options: {
  projectId: string;
  actorName: string;
  title: string;
  body: string;
  source?: string;
  sourceKind?: 'workflow' | 'plan' | 'integration';
  credentials: ContextCredentials;
  home?: string;
}): Promise<ContextCandidateProposal> {
  const home = options.home ?? configDir();
  await migrateLegacyProjectIfNeeded({
    projectId: options.projectId,
    home,
    credentials: options.credentials,
    keyStore: 'file',
  });
  const metadata = await readProjectMetadata(options.projectId, home);
  const vault = createVault(home, metadata.keyStore);
  assertCredentialsOrApprovedDevice(vault, {
    userName: metadata.userName,
    deviceName: options.actorName,
    credentials: options.credentials,
  });
  await ensureUserOrApprovedDevice(vault, {
    userName: metadata.userName,
    deviceName: options.actorName,
    credentials: options.credentials,
  });

  const source = options.source ?? 'workflow://vpd-context-candidate';
  const event = vault.proposeEntry({
    repoId: metadata.repoId,
    actorName: options.actorName,
    title: options.title,
    body: options.body,
    source,
    sourceKind: options.sourceKind ?? 'workflow',
  });
  await touchProjectMetadata(metadata, home);

  return {
    id: event.id,
    titleDigest: digestText(options.title),
    bodyDigest: event.payloadDigest ?? digestText(options.body),
    source,
    trustState: 'candidate',
    actorName: options.actorName,
    createdAt: event.createdAt,
    schemaVersion: CONTEXT_EVENT_SCHEMA_VERSION,
  };
}

export async function applyContextCandidateDecision(options: {
  projectId: string;
  actorName: string;
  decision: ContextCandidateDecisionPullRecord;
  credentials: ContextCredentials;
  home?: string;
}): Promise<{ applied: boolean; reason?: string; candidateId?: string; emitted: number }> {
  const home = options.home ?? configDir();
  const metadata = await readProjectMetadata(options.projectId, home);
  const vault = createVault(home, metadata.keyStore);
  assertCredentialsOrApprovedDevice(vault, {
    userName: metadata.userName,
    deviceName: options.actorName,
    credentials: options.credentials,
  });
  await ensureUserOrApprovedDevice(vault, {
    userName: metadata.userName,
    deviceName: options.actorName,
    credentials: options.credentials,
  });

  if (options.decision.repo_id !== metadata.repoId) {
    return { applied: false, reason: 'repo_mismatch', emitted: 0 };
  }

  const candidates = vault.allCandidates({ repoId: metadata.repoId, actorName: options.actorName });
  const candidate = candidates.find(
    (item) =>
      item.proposal_event_id === options.decision.candidate_event_id ||
      (typeof options.decision.payload_digest === 'string' &&
        options.decision.payload_digest.length > 0 &&
        item.payload_digest === options.decision.payload_digest),
  );

  if (!candidate) {
    return { applied: false, reason: 'candidate_not_found', emitted: 0 };
  }
  if (candidate.status === 'approved' || candidate.status === 'rejected') {
    return {
      applied: false,
      reason: `candidate_already_${candidate.status}`,
      candidateId: candidate.id,
      emitted: 0,
    };
  }

  if (options.decision.decision === 'approved') {
    vault.approveCandidate({
      repoId: metadata.repoId,
      actorName: options.actorName,
      candidateId: candidate.id,
      title: candidate.title,
      body: candidate.body,
      source: candidate.source ?? `candidate://${candidate.id}`,
    });
    await touchProjectMetadata(metadata, home);

    return { applied: true, candidateId: candidate.id, emitted: 2 };
  }

  vault.rejectCandidate({
    repoId: metadata.repoId,
    actorName: options.actorName,
    candidateId: candidate.id,
    reason: options.decision.message ?? 'Rejected in Viewport Inbox.',
  });
  await touchProjectMetadata(metadata, home);

  return { applied: true, candidateId: candidate.id, emitted: 1 };
}
