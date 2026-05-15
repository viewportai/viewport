import type { WorkflowRuntimeCommand } from './platform-runtime-command.js';
import type { WorkflowRunStore } from './store.js';
import type {
  WorkflowApprovalActor,
  WorkflowApprovalDecision,
  WorkflowRunRecord,
} from './types.js';

export type WorkflowApprovalDecider = (
  runId: string,
  nodeId: string,
  decision: WorkflowApprovalDecision,
) => Promise<WorkflowRunRecord>;

export class WorkflowRuntimeCommandApplier {
  constructor(
    private readonly store: WorkflowRunStore,
    private readonly decideApproval: WorkflowApprovalDecider,
  ) {}

  async apply(command: WorkflowRuntimeCommand, syncedRunId?: string): Promise<boolean> {
    if (command.type !== 'workflow.approval_decision') return true;

    const targetRunId = command.workflow_run_id ?? syncedRunId;
    if (!targetRunId) return false;

    const run = await this.store.get(targetRunId);
    if (!run || run.status !== 'blocked') return false;

    const node = run.nodes[command.workflow_node_id];
    if (!node || node.status !== 'blocked') return false;

    await this.decideApproval(run.id, command.workflow_node_id, {
      approved: command.approved,
      ...(command.decision ? { decision: command.decision } : {}),
      ...(command.message ? { message: command.message } : {}),
      ...(command.expected_action_digest
        ? { expectedActionDigest: command.expected_action_digest }
        : {}),
      ...(command.feedback ? { feedback: command.feedback } : {}),
      ...approvalActor(command.actor),
    });
    return true;
  }
}

function approvalActor(
  actor: Record<string, unknown> | null | undefined,
): { actor: WorkflowApprovalActor } | Record<string, never> {
  if (!actor) return {};

  const allowed: WorkflowApprovalActor = {};
  for (const key of ['id', 'name', 'email', 'source'] as const) {
    const value = actor[key];
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      allowed[key] = String(value);
    }
  }

  return Object.keys(allowed).length > 0 ? { actor: allowed } : {};
}
