export type WorkflowRuntimeCommand =
  | WorkflowApprovalDecisionCommand
  | WorkflowActionCompletedCommand;

export interface WorkflowApprovalDecisionCommand {
  id: string;
  type: 'workflow.approval_decision';
  workflow_run_id?: string | null;
  workflow_node_id: string;
  approved: boolean;
  decision?: 'approve' | 'request_changes' | 'reject';
  message?: string | null;
  expected_action_digest?: string | null;
  approval_requested_at?: string | null;
  decided_at?: string | null;
  execution_grant?: {
    schema?: string;
    digest: string;
    proposal_key?: string;
    approval_decision_key?: string;
    issued_at?: string;
  } | null;
  actor?: Record<string, unknown> | null;
  feedback?: Record<string, unknown> | null;
}

export interface WorkflowActionCompletedCommand {
  id: string;
  type: 'workflow.action_completed';
  workflow_run_id?: string | null;
  workflow_node_id: string;
  proposal_key?: string | null;
  receipt_key: string;
  receipt_digest?: string | null;
  provider_reference?: string | null;
  provider_url?: string | null;
  adapter: string;
  action: string;
  status: 'succeeded' | 'failed' | 'dead_lettered';
  executed_at?: string | null;
  message?: string | null;
}

export function runtimeCommands(body: unknown): WorkflowRuntimeCommand[] {
  if (!body || typeof body !== 'object') return [];
  const commands = (body as { runtime_commands?: unknown }).runtime_commands;
  if (!Array.isArray(commands)) return [];

  return commands.flatMap((command): WorkflowRuntimeCommand[] => {
    if (!command || typeof command !== 'object') return [];
    const value = command as Record<string, unknown>;
    const id = readString(value['id']);
    const workflowNodeId = readString(value['workflow_node_id']);
    if (!id || !workflowNodeId) return [];

    if (value['type'] === 'workflow.action_completed') {
      const receiptKey = readString(value['receipt_key']);
      const adapter = readString(value['adapter']);
      const action = readString(value['action']);
      const status = readActionCompletedStatus(value['status']);
      if (!receiptKey || !adapter || !action || !status) return [];

      return [
        {
          id,
          type: 'workflow.action_completed',
          workflow_run_id: readString(value['workflow_run_id']),
          workflow_node_id: workflowNodeId,
          proposal_key: readString(value['proposal_key']),
          receipt_key: receiptKey,
          receipt_digest: readString(value['receipt_digest']),
          provider_reference: readString(value['provider_reference']),
          provider_url: readString(value['provider_url']),
          adapter,
          action,
          status,
          executed_at: readString(value['executed_at']),
          message: readString(value['message']),
        },
      ];
    }

    if (value['type'] !== 'workflow.approval_decision') return [];
    if (typeof value['approved'] !== 'boolean') return [];

    const decision = readDecision(value['decision']);
    const expectedActionDigest = readString(value['expected_action_digest']);
    const executionGrant = readExecutionGrant(value['execution_grant']);

    return [
      {
        id,
        type: 'workflow.approval_decision',
        workflow_run_id: readString(value['workflow_run_id']),
        workflow_node_id: workflowNodeId,
        approved: value['approved'],
        ...(decision ? { decision } : {}),
        message: readString(value['message']),
        ...(expectedActionDigest ? { expected_action_digest: expectedActionDigest } : {}),
        approval_requested_at: readString(value['approval_requested_at']),
        decided_at: readString(value['decided_at']),
        ...(executionGrant ? { execution_grant: executionGrant } : {}),
        actor: readRecord(value['actor']),
        feedback: readRecord(value['feedback']),
      },
    ];
  });
}

function readExecutionGrant(value: unknown): WorkflowApprovalDecisionCommand['execution_grant'] {
  const record = readRecord(value);
  if (!record) return null;
  const digest = readString(record['digest']);
  if (!digest) return null;

  return {
    ...(readString(record['schema']) ? { schema: readString(record['schema']) as string } : {}),
    digest,
    ...(readString(record['proposal_key'])
      ? { proposal_key: readString(record['proposal_key']) as string }
      : {}),
    ...(readString(record['approval_decision_key'])
      ? { approval_decision_key: readString(record['approval_decision_key']) as string }
      : {}),
    ...(readString(record['issued_at'])
      ? { issued_at: readString(record['issued_at']) as string }
      : {}),
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readDecision(value: unknown): 'approve' | 'request_changes' | 'reject' | undefined {
  return value === 'approve' || value === 'request_changes' || value === 'reject'
    ? value
    : undefined;
}

function readActionCompletedStatus(
  value: unknown,
): 'succeeded' | 'failed' | 'dead_lettered' | undefined {
  return value === 'succeeded' || value === 'failed' || value === 'dead_lettered'
    ? value
    : undefined;
}
