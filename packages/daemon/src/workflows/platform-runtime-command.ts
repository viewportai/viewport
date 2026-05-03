export interface WorkflowRuntimeCommand {
  id: string;
  type: 'workflow.approval_decision';
  workflow_run_id?: string | null;
  workflow_node_id: string;
  approved: boolean;
  message?: string | null;
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

    return [
      {
        id,
        type: 'workflow.approval_decision',
        workflow_run_id: readString(value['workflow_run_id']),
        workflow_node_id: workflowNodeId,
        approved: value['approved'],
        message: readString(value['message']),
        actor: readRecord(value['actor']),
        feedback: readRecord(value['feedback']),
      },
    ];
  });
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
