import { resolveConfiguredContextSyncTarget } from '../cli/context-sync-target.js';
import { previewContextCandidate } from '../context/local-edge-candidates.js';
import { recordContextCandidatePreviewProof } from '../context/local-edge-sync.js';
import { ConfigManager } from '../core/config.js';

export interface ContextCandidatePreviewInput {
  contextResourceId: string;
  workspaceId?: string;
  actorName: string;
  candidateEventId?: string;
  payloadDigest?: string;
  passphrase?: string;
  recoveryCode?: string;
}

export type ContextCandidatePreviewProof =
  | { ok: true; previewProofId: string; expiresAt: string | null; workspaceId: string }
  | { ok: false; error: string };

export async function previewContextCandidateForTrustedEdge(
  input: ContextCandidatePreviewInput,
): Promise<{
  candidate: Awaited<ReturnType<typeof previewContextCandidate>> & {
    previewProof: ContextCandidatePreviewProof;
  };
  previewProof: ContextCandidatePreviewProof;
}> {
  if (!input.candidateEventId && !input.payloadDigest) {
    throw new Error('candidateEventId or payloadDigest is required');
  }

  const candidate = await previewContextCandidate({
    contextResourceId: input.contextResourceId,
    actorName: input.actorName,
    candidateEventId: input.candidateEventId,
    payloadDigest: input.payloadDigest,
    credentials: {
      passphrase: input.passphrase ?? '',
      recoveryCode: input.recoveryCode ?? '',
    },
  });

  const previewProof = await createPreviewProof({
    contextResourceId: input.contextResourceId,
    workspaceId: input.workspaceId,
    candidateEventId: candidate.proposalEventId,
    payloadDigest: candidate.payloadDigest,
  });

  return {
    candidate: { ...candidate, previewProof },
    previewProof,
  };
}

async function createPreviewProof(input: {
  contextResourceId: string;
  workspaceId?: string;
  candidateEventId: string;
  payloadDigest: string | null;
}): Promise<ContextCandidatePreviewProof> {
  try {
    const target = await resolveSavedSyncTarget(input.contextResourceId, input.workspaceId);
    if (!target) {
      return {
        ok: false,
        error: input.workspaceId
          ? `No saved remote credentials are available for workspace ${input.workspaceId}.`
          : 'Preview proof requires an explicit workspace when this daemon has multiple remote bindings.',
      };
    }

    const proof = await recordContextCandidatePreviewProof({
      workspaceId: target.workspaceId,
      serverUrl: target.serverUrl,
      credential: target.credential,
      contextResourceId: input.contextResourceId,
      candidateEventId: input.candidateEventId,
      payloadDigest: input.payloadDigest,
      previewDigest: input.payloadDigest,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    });
    return { ok: true, workspaceId: target.workspaceId, ...proof };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Context preview proof failed',
    };
  }
}

async function resolveSavedSyncTarget(
  contextResourceId: string,
  workspaceId?: string,
): Promise<{
  workspaceId: string;
  serverUrl: string;
  credential: string;
  tlsVerify?: 'auto' | '0' | '1';
  caCertPath?: string;
  tlsPins?: string[];
} | null> {
  const manager = new ConfigManager();
  await manager.load();
  const daemon = manager.getDaemonConfig() ?? {};
  return resolveConfiguredContextSyncTarget(daemon, {
    contextResourceId,
    requestedWorkspaceId: workspaceId,
  });
}
