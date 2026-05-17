import { addEvent } from './runtime-helpers.js';
import { sanitizeActionInput, workflowActionProposalDigest } from './action-digest.js';
import { actionPolicyReason } from './action-policy.js';
import type { ActionResult } from './action-provider-adapters.js';
import type { WorkflowActionNode, WorkflowInputValue, WorkflowRunRecord } from './types.js';

export function suppressDuplicateAction(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  idempotencyKey: string | undefined,
  actionInput: Record<string, WorkflowInputValue>,
): ActionResult | null {
  const key = actionLedgerKey(idempotencyKey);
  if (!key) return null;

  const digest = workflowActionProposalDigest(node, { idempotencyKey, input: actionInput });
  const existing = run.actionLedger?.[key];
  if (!existing) return null;
  if (existing.digest !== digest) {
    throw new Error(
      `Action idempotency key '${idempotencyKey}' was already used with a different proposed action in this run.`,
    );
  }

  const metadata = {
    action: {
      adapter: node.adapter,
      action: node.action,
      idempotencyKey,
      requiresApproval: node.requiresApproval === true,
      policyReason: actionPolicyReason(node),
      status: 'already_executed',
      digest,
      input: sanitizeActionInput(actionInput),
      duplicateOfNodeId: existing.nodeId,
      executedAt: existing.executedAt,
      response: existing.response,
      ...approvedExecutionGrant(run, nodeId, node.requiresApproval === true),
    },
  };
  addEvent(
    run,
    'action-duplicate-suppressed',
    `Action node ${nodeId} reused idempotency key ${idempotencyKey}; prior side effect kept.`,
    metadata,
    nodeId,
  );

  return {
    output: existing.output,
    metadata,
  };
}

export function rememberExecutedAction(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  idempotencyKey: string | undefined,
  actionInput: Record<string, WorkflowInputValue>,
  execution: { output: string; response?: Record<string, unknown> },
): void {
  const key = actionLedgerKey(idempotencyKey);
  if (!key || !idempotencyKey) return;
  run.actionLedger ??= {};
  run.actionLedger[key] = {
    nodeId,
    adapter: node.adapter,
    action: node.action,
    idempotencyKey,
    digest: workflowActionProposalDigest(node, { idempotencyKey, input: actionInput }),
    output: execution.output,
    executedAt: Date.now(),
    ...(execution.response ? { response: execution.response } : {}),
  };
}

function actionLedgerKey(idempotencyKey: string | undefined): string | null {
  if (!idempotencyKey) return null;
  return `idempotency:${idempotencyKey}`;
}

function approvedExecutionGrant(
  run: WorkflowRunRecord,
  nodeId: string,
  requiresApproval: boolean,
): Record<string, unknown> {
  if (!requiresApproval) return {};
  const grant = run.nodes[nodeId]?.approval?.executionGrant;
  return grant ? { executionGrant: grant, execution_grant: grant } : {};
}
