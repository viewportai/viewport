import { configDir } from '../core/config.js';
import { digestText } from './local-edge-crypto.js';
import {
  assertCredentialsOrApprovedDevice,
  createVault,
  ensureUserOrApprovedDevice,
} from './local-edge-engine.js';
import { recordCandidateDecisionApplication } from './local-edge-decision-applications.js';
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
    return recordAndReturnDecisionApplication({
      actorName: options.actorName,
      decision: options.decision,
      emitted: 0,
      home,
      projectId: options.projectId,
      reason: 'repo_mismatch',
      status: 'skipped',
    });
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
    return recordAndReturnDecisionApplication({
      actorName: options.actorName,
      decision: options.decision,
      emitted: 0,
      home,
      projectId: options.projectId,
      reason: 'candidate_not_found',
      status: 'skipped',
    });
  }
  if (candidate.status === 'approved' || candidate.status === 'rejected') {
    return recordAndReturnDecisionApplication({
      actorName: options.actorName,
      candidateId: candidate.id,
      decision: options.decision,
      emitted: 0,
      home,
      projectId: options.projectId,
      reason: `candidate_already_${candidate.status}`,
      status: 'skipped',
    });
  }

  if (options.decision.decision === 'approved') {
    vault.approveCandidate({
      repoId: metadata.repoId,
      actorName: options.actorName,
      candidateId: candidate.id,
      title: candidate.title,
      body: candidate.body,
      source: candidate.source ?? `candidate://${candidate.id}`,
      review: {
        platformDecisionId: options.decision.id,
        platformInboxItemId: options.decision.inbox_item_id ?? null,
        decidedByUserId: options.decision.decided_by_user_id ?? null,
        decidedAt: options.decision.decided_at ?? null,
        platformSignatureDigest: options.decision.platform_signature.signed_payload_digest,
      },
    });
    await touchProjectMetadata(metadata, home);

    return recordAndReturnDecisionApplication({
      actorName: options.actorName,
      candidateId: candidate.id,
      decision: options.decision,
      emitted: 2,
      home,
      projectId: options.projectId,
      status: 'applied',
    });
  }

  vault.rejectCandidate({
    repoId: metadata.repoId,
    actorName: options.actorName,
    candidateId: candidate.id,
    reason: options.decision.message ?? 'Rejected in Viewport Inbox.',
  });
  await touchProjectMetadata(metadata, home);

  return recordAndReturnDecisionApplication({
    actorName: options.actorName,
    candidateId: candidate.id,
    decision: options.decision,
    emitted: 1,
    home,
    projectId: options.projectId,
    status: 'applied',
  });
}

async function recordAndReturnDecisionApplication(options: {
  actorName: string;
  candidateId?: string;
  decision: ContextCandidateDecisionPullRecord;
  emitted: number;
  home: string;
  projectId: string;
  reason?: string;
  status: 'applied' | 'skipped';
}): Promise<{ applied: boolean; reason?: string; candidateId?: string; emitted: number }> {
  await recordCandidateDecisionApplication({
    home: options.home,
    projectId: options.projectId,
    application: {
      schema_version: 'viewport.context_candidate_application/v1',
      decision_id: options.decision.id,
      inbox_item_id: options.decision.inbox_item_id ?? null,
      repo_id: options.decision.repo_id,
      candidate_event_id: options.decision.candidate_event_id,
      payload_digest: options.decision.payload_digest ?? null,
      decision: options.decision.decision,
      status: options.status,
      ...(options.reason ? { reason: options.reason } : {}),
      actor_name: options.actorName,
      ...(options.candidateId ? { candidate_id: options.candidateId } : {}),
      emitted: options.emitted,
      applied_at: new Date().toISOString(),
      platform_signature_digest: options.decision.platform_signature.signed_payload_digest,
    },
  });

  return {
    applied: options.status === 'applied',
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.candidateId ? { candidateId: options.candidateId } : {}),
    emitted: options.emitted,
  };
}
