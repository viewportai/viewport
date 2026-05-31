import type { WorkflowRuntimeCommand } from './platform-runtime-command.js';
import type { WorkflowRunStore } from './store.js';
import { workflowApprovalActorPayload } from './approval-actor.js';
import type { WorkflowApprovalDecision, WorkflowRunRecord } from './types.js';
import { addEvent } from './runtime-helpers.js';

export type WorkflowApprovalDecider = (
  runId: string,
  nodeId: string,
  decision: WorkflowApprovalDecision,
) => Promise<WorkflowRunRecord>;

export class WorkflowRuntimeCommandApplier {
  constructor(
    private readonly store: WorkflowRunStore,
    private readonly decideApproval: WorkflowApprovalDecider,
    private readonly saveRun?: (run: WorkflowRunRecord) => Promise<void>,
  ) {}

  async apply(command: WorkflowRuntimeCommand, syncedRunId?: string): Promise<boolean> {
    if (command.type === 'workflow.action_completed') {
      return this.applyActionCompleted(command, syncedRunId);
    }

    if (command.type !== 'workflow.approval_decision') return true;

    const targetRunId = command.workflow_run_id ?? syncedRunId;
    if (!targetRunId) return false;

    const run = await this.store.get(targetRunId);
    if (!run || run.status !== 'blocked') return false;

    const node = run.nodes[command.workflow_node_id];
    if (!node) return false;
    if (runtimeCommandConsumed(node.metadata, command.id)) return true;
    if (node.status !== 'blocked') return true;
    if (staleApprovalRequestedAt(node, command.decided_at)) {
      markRuntimeCommandConsumed(node, command.id, {
        ignored: true,
        reason: 'stale_approval_decided_before_current_request',
        decided_at: command.decided_at,
        requested_at: node.approval?.requestedAt,
      });
      await this.persistRun(run);
      return true;
    }
    const expectedActionDigest = command.expected_action_digest ?? undefined;
    if (missingDigestAfterInvalidation(node, expectedActionDigest)) {
      markRuntimeCommandConsumed(node, command.id, {
        ignored: true,
        reason: 'missing_expected_action_digest_after_invalidation',
        current_action_digest: approvalSubjectDigest(node),
      });
      await this.persistRun(run);
      return true;
    }
    if (staleApprovalDigest(node, expectedActionDigest)) {
      markRuntimeCommandConsumed(node, command.id, {
        ignored: true,
        reason: 'stale_expected_action_digest',
        expected_action_digest: expectedActionDigest,
        current_action_digest: approvalSubjectDigest(node),
      });
      await this.persistRun(run);
      return true;
    }

    markRuntimeCommandConsumed(node, command.id);
    await this.persistRun(run);

    const updated = await this.decideApproval(run.id, command.workflow_node_id, {
      approved: command.approved,
      ...(command.decision ? { decision: command.decision } : {}),
      ...(command.message ? { message: command.message } : {}),
      ...(command.expected_action_digest
        ? { expectedActionDigest: command.expected_action_digest }
        : {}),
      ...(command.execution_grant ? { executionGrant: command.execution_grant } : {}),
      ...(command.feedback ? { feedback: command.feedback } : {}),
      ...workflowApprovalActorPayload(command.actor),
    });
    markRuntimeCommandConsumed(updated.nodes[command.workflow_node_id], command.id);
    return true;
  }

  private async applyActionCompleted(
    command: Extract<WorkflowRuntimeCommand, { type: 'workflow.action_completed' }>,
    syncedRunId?: string,
  ): Promise<boolean> {
    const targetRunId = command.workflow_run_id ?? syncedRunId;
    if (!targetRunId) return false;

    const run = await this.store.get(targetRunId);
    if (!run) return false;
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'canceled') {
      return true;
    }

    const node = run.nodes[command.workflow_node_id];
    if (!node) return false;
    if (node.status === 'completed') return true;
    if (node.status !== 'blocked' && node.status !== 'queued' && node.status !== 'running') {
      return false;
    }

    const completedAt = Date.now();
    const metadata = { ...(node.metadata ?? {}) };
    metadata['action'] = {
      ...(typeof metadata['action'] === 'object' && metadata['action'] !== null
        ? (metadata['action'] as Record<string, unknown>)
        : {}),
      adapter: command.adapter,
      action: command.action,
      status: 'executed',
      proposalKey: command.proposal_key ?? undefined,
      receiptKey: command.receipt_key,
      receiptDigest: command.receipt_digest ?? undefined,
      providerReference: command.provider_reference ?? undefined,
      providerUrl: command.provider_url ?? undefined,
      executedAt: command.executed_at ?? new Date(completedAt).toISOString(),
      completedBy: 'viewport_broker',
    };
    metadata['executionReceipt'] = {
      source: 'viewport_broker',
      receiptKey: command.receipt_key,
      receiptDigest: command.receipt_digest ?? undefined,
      providerReference: command.provider_reference ?? undefined,
      providerUrl: command.provider_url ?? undefined,
    };

    node.status = 'completed';
    node.output = `${command.adapter}.${command.action}`;
    node.error = undefined;
    node.completedAt = completedAt;
    node.metadata = metadata;

    addEvent(
      run,
      'node-completed',
      command.message ?? `Node ${command.workflow_node_id} completed by Viewport action broker`,
      {
        source: 'viewport_broker',
        proposal_key: command.proposal_key ?? undefined,
        receipt_key: command.receipt_key,
        receipt_digest: command.receipt_digest ?? undefined,
        provider_reference: command.provider_reference ?? undefined,
        provider_url: command.provider_url ?? undefined,
      },
      command.workflow_node_id,
    );

    const hasOpenNode = Object.values(run.nodes).some(
      (candidate) =>
        candidate.status !== 'completed' &&
        candidate.status !== 'failed' &&
        candidate.status !== 'skipped' &&
        candidate.status !== 'canceled',
    );
    run.status = hasOpenNode ? 'running' : 'completed';
    run.completedAt = hasOpenNode ? run.completedAt : completedAt;
    run.updatedAt = completedAt;

    if (this.saveRun) {
      await this.saveRun(run);
    } else if ('save' in this.store && typeof this.store.save === 'function') {
      await this.store.save(run);
    }
    return true;
  }

  private async persistRun(run: WorkflowRunRecord): Promise<void> {
    if (this.saveRun) {
      await this.saveRun(run);
    } else if ('save' in this.store && typeof this.store.save === 'function') {
      await this.store.save(run);
    }
  }
}

function runtimeCommandConsumed(metadata: Record<string, unknown> | undefined, id: string): boolean {
  const runtimeCommands = metadata?.['runtime_commands'];
  if (!isRecord(runtimeCommands)) return false;
  const consumed = runtimeCommands['consumed'];
  return Array.isArray(consumed) && consumed.some((entry) => isRecord(entry) && entry['id'] === id);
}

function markRuntimeCommandConsumed(
  node: WorkflowRunRecord['nodes'][string] | undefined,
  id: string,
  extra: Record<string, unknown> = {},
): void {
  if (!node) return;
  const consumedAt = new Date().toISOString();
  const metadata = { ...(node.metadata ?? {}) };
  const runtimeCommands = isRecord(metadata['runtime_commands'])
    ? { ...metadata['runtime_commands'] }
    : {};
  const previous = Array.isArray(runtimeCommands['consumed'])
    ? runtimeCommands['consumed'].filter(isRecord)
    : [];
  runtimeCommands['consumed'] = [...previous, { id, consumed_at: consumedAt, ...extra }].slice(
    -50,
  );
  metadata['runtime_commands'] = runtimeCommands;
  node.metadata = metadata;
}

function staleApprovalDigest(
  node: WorkflowRunRecord['nodes'][string],
  expectedDigest: string | undefined,
): boolean {
  if (!expectedDigest) return false;
  const currentDigest = approvalSubjectDigest(node);
  return typeof currentDigest === 'string' && currentDigest !== expectedDigest;
}

function missingDigestAfterInvalidation(
  node: WorkflowRunRecord['nodes'][string],
  expectedDigest: string | undefined,
): boolean {
  if (expectedDigest) return false;
  const review = node.metadata?.['pre_publish_review'];
  return isRecord(review) && isRecord(review['invalidated_approval']);
}

function staleApprovalRequestedAt(
  node: WorkflowRunRecord['nodes'][string],
  decidedAt: string | null | undefined,
): boolean {
  if (!decidedAt || !node.approval?.requestedAt) return false;
  const decidedAtMs = Date.parse(decidedAt);
  return Number.isFinite(decidedAtMs) && decidedAtMs < node.approval.requestedAt;
}

function approvalSubjectDigest(node: WorkflowRunRecord['nodes'][string]): unknown {
  if (node.type === 'action' && isRecord(node.metadata?.['action'])) {
    return node.metadata['action']['digest'];
  }

  if (node.type === 'git_publish' && isRecord(node.metadata?.['pre_publish_review'])) {
    const facts = node.metadata['pre_publish_review']['facts'];
    if (isRecord(facts)) return facts['diffDigest'];
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
