export interface WorkflowRuntimeCommand {
  id: string;
  type: 'workflow.approval_decision';
  workflow_run_id?: string | null;
  workflow_node_id: string;
  approved: boolean;
  decision?: 'approve' | 'request_changes' | 'reject';
  message?: string | null;
  expected_action_digest?: string | null;
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

export function runtimeCommands(body: unknown): WorkflowRuntimeCommand[] {
  if (!body || typeof body !== 'object') return [];
  const commands = (body as { runtime_commands?: unknown }).runtime_commands;
  if (!Array.isArray(commands)) return [];

  return commands.flatMap((command): WorkflowRuntimeCommand[] => {
    if (!command || typeof command !== 'object') return [];
    const value = command as Record<string, unknown>;
    if (value['type'] !== 'workflow.approval_decision') return [];
    const id = readString(value['id']);
    const workflowNodeId = readString(value['workflow_node_id']);
    if (!id || !workflowNodeId || typeof value['approved'] !== 'boolean') return [];

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
        ...(executionGrant ? { execution_grant: executionGrant } : {}),
        actor: readRecord(value['actor']),
        feedback: readRecord(value['feedback']),
      },
    ];
  });
}

function readExecutionGrant(value: unknown): WorkflowRuntimeCommand['execution_grant'] {
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
