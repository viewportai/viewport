import type {
  WorkflowNodeRunState,
  WorkflowRunArtifactRecord,
  WorkflowRunEvent,
  WorkflowRunRecord,
} from '../workflows/types.js';
import type { ManagedAssignment, ManagedWorkerCapabilities } from './workflow-managed-worker.js';

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

function iso(value: number | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}
