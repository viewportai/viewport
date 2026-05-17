import { createHash } from 'node:crypto';
import { sanitizeActionInput } from '../workflows/action-digest.js';
import type {
  WorkflowInputValue,
  WorkflowNodeRunState,
  WorkflowRunArtifactRecord,
  WorkflowRunEvent,
  WorkflowRunRecord,
} from '../workflows/types.js';
import type {
  ManagedAssignment,
  ManagedWorkerCapabilities,
} from './workflow-managed-worker-types.js';

export function localRunToSyncPayload(run: WorkflowRunRecord): Record<string, unknown> {
  return {
    runtime_run_id: run.id,
    status: run.status,
    data_capture_policy: run.dataCapturePolicy,
    output_snapshot: {
      inputs: run.inputs,
      nodes: Object.fromEntries(
        Object.entries(run.nodes).map(([key, node]) => [
          key,
          { status: node.status, output: node.output, outputs: node.outputs ?? null },
        ]),
      ),
    },
    error_summary: run.error ?? null,
    started_at: iso(run.startedAt),
    completed_at: iso(run.completedAt),
    nodes: Object.values(run.nodes).map(formatNode),
    artifacts: run.artifacts.map(formatArtifact),
    events: run.events.map(formatEvent),
    evidence_packets: Object.values(run.nodes).flatMap(formatEvidencePacket),
    action_proposals: Object.values(run.nodes).flatMap(formatActionProposal),
    approval_decisions: Object.values(run.nodes).flatMap(formatApprovalDecision),
    execution_receipts: run.events.flatMap(formatExecutionReceipt),
    audit_receipts: run.events.flatMap(formatAuditReceipt),
  };
}

export function capabilityPayload(
  capabilities: ManagedWorkerCapabilities,
): Record<string, string[]> {
  return {
    tools: ['shell'],
    ...(capabilities.agentCommand && capabilities.agents.length > 0
      ? { agents: capabilities.agents }
      : {}),
    ...(capabilities.agentCommand && capabilities.models.length > 0
      ? { models: capabilities.models }
      : {}),
    ...(capabilities.integrations.length > 0 ? { integrations: capabilities.integrations } : {}),
    ...((capabilities.actionCommand || capabilities.providerActions) &&
    capabilities.integrations.length > 0
      ? { action_replay: capabilities.integrations }
      : {}),
    ...(capabilities.secrets.length > 0 ? { secrets: capabilities.secrets } : {}),
  };
}

export function dataFrom(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}

export function readRun(body: unknown): WorkflowRunRecord {
  const run =
    body && typeof body === 'object' && 'run' in body ? (body as { run: unknown }).run : body;
  if (!run || typeof run !== 'object' || typeof (run as { id?: unknown }).id !== 'string') {
    throw new Error('Daemon workflow response did not include a run.');
  }
  return run as WorkflowRunRecord;
}

export function approvalMessage(node: NonNullable<ManagedAssignment['nodes']>[number]): string {
  const approval = node.metadata?.['approval'];
  if (approval && typeof approval === 'object' && 'message' in approval) {
    const message = (approval as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return node.output ?? 'Approved from Viewport';
}

export function approvalActor(
  node: NonNullable<ManagedAssignment['nodes']>[number],
): Record<string, string> {
  const approval = node.metadata?.['approval'];
  const actor =
    approval && typeof approval === 'object' ? (approval as { actor?: unknown }).actor : null;
  return actor && typeof actor === 'object'
    ? (actor as Record<string, string>)
    : { name: 'Viewport', source: 'managed-executor' };
}

export function approvalExpectedActionDigest(
  node: NonNullable<ManagedAssignment['nodes']>[number],
): string | undefined {
  const approval = node.metadata?.['approval'];
  if (approval && typeof approval === 'object') {
    const digest = (approval as { actionDigest?: unknown }).actionDigest;
    if (typeof digest === 'string' && digest.trim() !== '') return digest;
  }
  const action = node.metadata?.['action'];
  if (action && typeof action === 'object') {
    const digest = (action as { digest?: unknown }).digest;
    if (typeof digest === 'string' && digest.trim() !== '') return digest;
  }
  return undefined;
}

export function progressSyncEveryMs(leaseSeconds: number): number {
  return Math.max(500, Math.min(30_000, Math.floor(leaseSeconds * 500)));
}

function formatNode(node: WorkflowNodeRunState): Record<string, unknown> {
  return {
    node_key: node.id,
    title: node.title ?? node.id,
    type: node.type,
    status: node.status,
    session_id: node.sessionId ?? null,
    worktree_path: node.worktreePath ?? null,
    output: node.output ?? null,
    output_snapshot: node.outputs ?? null,
    transcript_excerpt: node.transcriptExcerpt ?? null,
    error: node.error ?? null,
    started_at: iso(node.startedAt),
    completed_at: iso(node.completedAt),
    metadata: {
      ...(node.metadata ?? {}),
      approval: node.approval ?? null,
      inlineAgents: node.inlineAgents ?? null,
      nativeSessionId: node.nativeSessionId ?? null,
      exitCode: node.exitCode ?? null,
      skipReason: node.skipReason ?? null,
    },
  };
}

function formatArtifact(artifact: WorkflowRunArtifactRecord): Record<string, unknown> {
  return {
    node_key: artifact.nodeId,
    name: artifact.name,
    kind: artifact.kind ?? null,
    path: artifact.path,
    uri: null,
    mime_type: null,
    digest: artifact.digest ?? null,
    metadata: {
      ...(artifact.metadata ?? {}),
      description: artifact.description ?? null,
      sizeBytes: artifact.sizeBytes ?? null,
    },
  };
}

function formatEvent(event: WorkflowRunEvent): Record<string, unknown> {
  return {
    runtime_event_id: event.id,
    node_key: event.nodeId ?? null,
    type: event.type,
    severity: event.type.includes('failed') ? 'error' : 'info',
    message: event.message,
    payload: event.data ?? null,
    occurred_at: iso(event.timestamp),
  };
}

function formatActionProposal(node: WorkflowNodeRunState): Array<Record<string, unknown>> {
  const action = recordValue(node.metadata?.['action']);
  if (!action) return [];
  const adapter = stringValue(action['adapter']);
  const actionName = stringValue(action['action']);
  if (!adapter || !actionName) return [];

  return [
    {
      proposal_key: proposalKey(node.id),
      node_key: node.id,
      adapter,
      action: actionName,
      state: stringValue(action['status']) ?? 'proposed',
      idempotency_key: stringValue(action['idempotencyKey']),
      proposal_digest: stringValue(action['digest']),
      evidence_refs: arrayValue(action['evidenceRefs']),
      policy_evaluation: recordValue(action['policyReason'])
        ? { reason: action['policyReason'] }
        : stringValue(action['policyReason'])
          ? { reason: action['policyReason'] }
          : null,
      payload: recordValue(action['input'])
        ? sanitizeActionInput(action['input'] as Record<string, WorkflowInputValue>)
        : null,
      proposed_at: iso(node.startedAt ?? node.completedAt),
      expires_at: null,
    },
  ];
}

function formatEvidencePacket(node: WorkflowNodeRunState): Array<Record<string, unknown>> {
  if (node.status !== 'completed') return [];
  const output = typeof node.output === 'string' ? node.output.trim() : '';
  if (!output) return [];

  const payload = {
    nodeId: node.id,
    nodeType: node.type,
    outputExcerpt: excerpt(output),
    outputs: node.outputs ?? null,
    exitCode: node.exitCode ?? null,
  };

  return [
    {
      evidence_key: `node:${node.id}:output`,
      node_key: node.id,
      kind: node.type === 'shell' ? 'command_output' : 'node_output',
      title: node.title ?? node.id,
      summary: excerpt(output),
      confidence: 'observed',
      visibility: 'team',
      digest: payloadDigest(payload),
      payload,
      occurred_at: iso(node.completedAt ?? node.startedAt),
    },
  ];
}

function formatApprovalDecision(node: WorkflowNodeRunState): Array<Record<string, unknown>> {
  if (!node.approval?.resolvedAt) return [];
  const action = recordValue(node.metadata?.['action']);
  const actionDigest = stringValue(action?.['digest']);

  return [
    {
      decision_key: `approval:${node.id}:${node.approval.resolvedAt}`,
      proposal_key: action ? proposalKey(node.id) : null,
      node_key: node.id,
      actor_user_id: null,
      subject_type: action ? 'action_proposal' : 'workflow_node',
      subject_id: node.id,
      subject_digest: actionDigest,
      decision: approvalDecision(
        node.approval.decision ?? (node.approval.approved ? 'approve' : 'reject'),
      ),
      reason: node.approval.message ?? null,
      actor_snapshot: node.approval.actor ?? null,
      payload: {
        approved: node.approval.approved,
        feedback: node.approval.feedback ?? null,
      },
      decided_at: iso(node.approval.resolvedAt),
    },
  ];
}

function formatExecutionReceipt(event: WorkflowRunEvent): Array<Record<string, unknown>> {
  if (
    ![
      'action-executed',
      'action-failed',
      'action-dead-letter',
      'action-duplicate-suppressed',
    ].includes(event.type)
  ) {
    return [];
  }
  const action = recordValue(event.data?.['action']);
  const adapter = stringValue(action?.['adapter']);
  const actionName = stringValue(action?.['action']);
  if (!adapter || !actionName) return [];

  return [
    {
      receipt_key: `execution:${event.id}`,
      proposal_key: event.nodeId ? proposalKey(event.nodeId) : null,
      approval_decision_key: null,
      adapter,
      action: actionName,
      status:
        event.type === 'action-executed'
          ? 'executed'
          : event.type === 'action-failed'
            ? 'failed'
            : event.type === 'action-dead-letter'
              ? 'dead_letter'
              : 'duplicate_suppressed',
      provider_reference:
        stringValue(recordValue(action?.['response'])?.['number']) ??
        stringValue(recordValue(action?.['response'])?.['ts']) ??
        stringValue(recordValue(action?.['response'])?.['id']),
      provider_url:
        stringValue(recordValue(action?.['response'])?.['htmlUrl']) ??
        stringValue(recordValue(action?.['response'])?.['apiUrl']),
      idempotency_key: stringValue(action?.['idempotencyKey']),
      payload_digest: stringValue(action?.['digest']) ?? payloadDigest(action),
      payload: sanitizeSyncPayload(action),
      executed_at: iso(event.timestamp),
    },
  ];
}

function formatAuditReceipt(event: WorkflowRunEvent): Array<Record<string, unknown>> {
  if (
    ![
      'approval-requested',
      'approval-resolved',
      'action-executed',
      'action-failed',
      'action-dead-letter',
      'action-duplicate-suppressed',
    ].includes(event.type)
  ) {
    return [];
  }
  const payload = sanitizeSyncPayload(event.data);

  return [
    {
      receipt_key: `audit:${event.id}`,
      event_type: event.type,
      actor_type: event.type.startsWith('approval') ? 'human_or_platform' : 'runner',
      actor_id: null,
      payload_digest: payloadDigest(payload),
      payload,
      occurred_at: iso(event.timestamp),
    },
  ];
}

function iso(value: number | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function proposalKey(nodeId: string): string {
  return `action:${nodeId}`;
}

function approvalDecision(decision: string): 'approve' | 'deny' | 'request_changes' {
  if (decision === 'approve' || decision === 'request_changes') return decision;
  return 'deny';
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function excerpt(value: string): string {
  return value.length <= 1_000 ? value : `${value.slice(0, 1_000)}...`;
}

function sanitizeSyncPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value ?? null;
  return sanitizeActionInput(value as WorkflowInputValue | Record<string, WorkflowInputValue>);
}

function payloadDigest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(stableJson(value ?? null))
    .digest('hex')}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortKeys(entry));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortKeys(entry)]),
  );
}
