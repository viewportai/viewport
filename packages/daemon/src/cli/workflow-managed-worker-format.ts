import type {
  ManagedAssignment,
  ManagedWorkerCapabilities,
} from './workflow-managed-worker-types.js';
import { sanitizeWorkflowApprovalActor } from '../workflows/approval-actor.js';
import type { WorkflowApprovalActor, WorkflowRunRecord } from '../workflows/types.js';

export { workflowRunToSyncPayload as localRunToSyncPayload } from '../workflows/platform-sync-payload.js';

export function capabilityPayload(
  capabilities: ManagedWorkerCapabilities,
): Record<string, string[] | string> {
  const tools = [...new Set(['shell', ...capabilities.tools])];

  return {
    tools,
    ...(capabilities.runnerPool ? { runner_pool: capabilities.runnerPool } : {}),
    ...(capabilities.agents.length > 0 ? { agents: capabilities.agents } : {}),
    ...(capabilities.models.length > 0 ? { models: capabilities.models } : {}),
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
): WorkflowApprovalActor {
  const approval = node.metadata?.['approval'];
  const actor =
    approval && typeof approval === 'object' ? (approval as { actor?: unknown }).actor : null;
  return sanitizeWorkflowApprovalActor(actor) ?? { name: 'Viewport', source: 'managed-executor' };
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

export function approvalExecutionGrant(
  node: NonNullable<ManagedAssignment['nodes']>[number],
): Record<string, string> | undefined {
  const approval = node.metadata?.['approval'];
  if (!approval || typeof approval !== 'object') return undefined;
  const grant =
    (approval as { executionGrant?: unknown; execution_grant?: unknown }).executionGrant ??
    (approval as { execution_grant?: unknown }).execution_grant;
  if (!grant || typeof grant !== 'object') return undefined;
  const record = grant as Record<string, unknown>;
  const digest = stringValue(record['digest']);
  if (!digest) return undefined;

  return {
    ...(stringValue(record['schema']) ? { schema: stringValue(record['schema']) as string } : {}),
    digest,
    ...(stringValue(record['proposal_key'])
      ? { proposal_key: stringValue(record['proposal_key']) as string }
      : {}),
    ...(stringValue(record['approval_decision_key'])
      ? { approval_decision_key: stringValue(record['approval_decision_key']) as string }
      : {}),
    ...(stringValue(record['issued_at'])
      ? { issued_at: stringValue(record['issued_at']) as string }
      : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function progressSyncEveryMs(leaseSeconds: number): number {
  return Math.max(500, Math.min(30_000, Math.floor(leaseSeconds * 500)));
}
