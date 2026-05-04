import type { WorkflowRunRecord } from './types.js';

export function buildReviewPacket(run: WorkflowRunRecord): Record<string, unknown> | null {
  if (!shouldPublishReviewPacket(run)) return null;

  const nodes = Object.values(run.nodes);
  const completed = nodes.filter((node) => node.status === 'completed').length;
  const failed = nodes.filter((node) => node.status === 'failed').length;
  const blocked = nodes.filter((node) => node.status === 'blocked').length;
  const skipped = nodes.filter((node) => node.status === 'skipped').length;

  return {
    source_key: 'daemon-workflow-readiness',
    title: `${run.workflowTitle ?? run.workflowName} readiness packet`,
    status: reviewPacketStatus(run),
    decision: reviewDecision(run, failed, blocked),
    risk_level: reviewRiskLevel(run, failed, blocked),
    summary: reviewSummary(run, { completed, failed, blocked }),
    checks: nodes.map((node) => ({
      key: node.id,
      title: node.title ?? node.id,
      type: node.type,
      status: node.status,
      exitCode: node.exitCode ?? null,
    })),
    findings: reviewFindings(run),
    proof_items: reviewProofItems(run),
    artifacts: run.artifacts.map((artifact) => ({
      node: artifact.nodeId,
      name: artifact.name,
      kind: artifact.kind ?? null,
      digest: artifact.digest ?? readString(artifact.metadata?.['digest']),
    })),
    source_snapshot: sourceSnapshot(run),
    metadata: {
      generatedBy: 'vpd',
      generatedAt: new Date(run.completedAt ?? run.updatedAt).toISOString(),
      nodeCounts: { completed, failed, blocked, skipped, total: nodes.length },
      privacy: {
        rawTranscriptIncluded: false,
        rawLogContentIncluded: false,
        rawArtifactBytesIncluded: false,
      },
    },
    published_at:
      run.status === 'completed' && run.completedAt
        ? new Date(run.completedAt).toISOString()
        : null,
  };
}

function shouldPublishReviewPacket(run: WorkflowRunRecord): boolean {
  if (!['completed', 'failed', 'canceled'].includes(run.status)) return false;

  const searchable = [run.workflowName, run.workflowTitle]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();

  if (
    /\b(pull request review|merge readiness|pr readiness|pr review)\b/.test(searchable) ||
    /(^|[/_.-])(pr-review|pull-request-review|merge-readiness|pr-readiness)([/_.-]|$)/.test(
      searchable,
    )
  ) {
    return true;
  }

  return Object.values(run.nodes).some((node) => {
    const metadata = node.metadata ?? {};
    return metadata['reviewPacket'] === true || metadata['readinessPacket'] === true;
  });
}

function reviewPacketStatus(run: WorkflowRunRecord): 'draft' | 'published' | 'failed' | 'canceled' {
  if (run.status === 'completed') return 'published';
  if (run.status === 'failed') return 'failed';
  if (run.status === 'canceled') return 'canceled';
  return 'draft';
}

function reviewDecision(
  run: WorkflowRunRecord,
  failed: number,
  blocked: number,
): 'approved' | 'changes_requested' | 'blocked' | 'needs_review' {
  if (blocked > 0 || run.status === 'blocked') return 'blocked';
  if (failed > 0 || run.status === 'failed') return 'changes_requested';
  if (run.status === 'completed') return 'needs_review';
  return 'needs_review';
}

function reviewRiskLevel(
  run: WorkflowRunRecord,
  failed: number,
  blocked: number,
): 'unknown' | 'low' | 'medium' | 'high' | 'critical' {
  if (run.status === 'failed' || failed > 0) return 'high';
  if (run.status === 'blocked' || blocked > 0) return 'medium';
  if (run.status === 'completed') return 'low';
  return 'unknown';
}

function reviewSummary(
  run: WorkflowRunRecord,
  counts: { completed: number; failed: number; blocked: number },
): string {
  const title = run.workflowTitle ?? run.workflowName;
  if (run.status === 'completed') {
    return `${title} completed with ${counts.completed}/${Object.keys(run.nodes).length} nodes complete.`;
  }
  if (run.status === 'failed') {
    return `${title} failed with ${counts.failed} failed node${counts.failed === 1 ? '' : 's'}.`;
  }
  if (run.status === 'blocked') {
    return `${title} is waiting on ${counts.blocked} blocked node${counts.blocked === 1 ? '' : 's'}.`;
  }
  return `${title} ended with status ${run.status}.`;
}

function reviewFindings(run: WorkflowRunRecord): Array<Record<string, unknown>> {
  return Object.values(run.nodes)
    .filter((node) => node.status === 'failed' || Boolean(node.error))
    .map((node) => ({
      severity: 'high',
      node: node.id,
      title: node.title ?? node.id,
      message: `Node ${node.id} failed. Inspect the local run for redacted command output.`,
    }));
}

function reviewProofItems(run: WorkflowRunRecord): Array<Record<string, unknown>> {
  const nodeProof = Object.values(run.nodes).map((node) => ({
    kind: 'node',
    node: node.id,
    title: node.title ?? node.id,
    status: node.status,
    completedAt: node.completedAt ? new Date(node.completedAt).toISOString() : null,
  }));

  const artifactProof = run.artifacts.map((artifact) => ({
    kind: 'artifact',
    node: artifact.nodeId,
    name: artifact.name,
    type: artifact.kind ?? null,
    digest: artifact.digest ?? readString(artifact.metadata?.['digest']),
  }));

  return [...nodeProof, ...artifactProof];
}

function sourceSnapshot(run: WorkflowRunRecord): Record<string, unknown> {
  return {
    runtime_run_id: run.id,
    workflow_name: run.workflowName,
    workflow_title: run.workflowTitle ?? null,
    source_type: run.sourceType,
    workflow_digest: run.digest,
    directory_id: run.directoryId,
    execution_policy_mode: run.executionPolicy?.mode ?? null,
    data_capture_policy: run.dataCapturePolicy ?? {
      transcripts: 'none',
      logs: 'metadata',
      artifacts: 'metadata',
    },
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
