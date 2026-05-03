import type { ParsedWorkflow, WorkflowRunRecord } from './types.js';

export const TERMINAL_NODE_STATUSES = new Set(['completed', 'failed', 'skipped', 'canceled']);

/**
 * Find every queued node whose `needs` set has fully terminated. The runner
 * launches these as the next layer; classification (when/triggerRule) decides
 * whether each one actually executes or gets skipped.
 */
export function findReadyNodeIds(run: WorkflowRunRecord, parsed: ParsedWorkflow): string[] {
  const ready: string[] = [];
  for (const [nodeId, node] of Object.entries(parsed.definition.nodes)) {
    const state = run.nodes[nodeId];
    if (!state || state.status !== 'queued') continue;
    const needs = node.needs ?? [];
    const allParentsTerminal = needs.every((parentId) => {
      const parent = run.nodes[parentId];
      return parent ? TERMINAL_NODE_STATUSES.has(parent.status) : true;
    });
    if (allParentsTerminal) ready.push(nodeId);
  }
  return ready;
}

export function workflowNodeMetadata(
  node: ParsedWorkflow['definition']['nodes'][string],
): Record<string, unknown> {
  return {
    needs: node.needs ?? [],
    outputs: node.outputs ?? {},
    artifacts: node.artifacts ?? {},
    retry: node.retry ?? null,
    policy: node.policy ?? null,
    timeoutSeconds: node.timeoutSeconds ?? null,
    ...(node.type === 'prompt'
      ? {
          agent: node.agent ?? null,
          provider: node.provider ?? null,
          model: node.model ?? null,
          hooks: node.hooks ?? null,
          agents: node.agents ?? null,
        }
      : {}),
    ...(node.type === 'gate' ? { gate: node.gate } : {}),
    ...(node.type === 'plan'
      ? {
          title: node.title,
          summary: node.summary ?? null,
          source: node.source ?? 'workflow',
          waitForApproval: node.waitForApproval ?? true,
        }
      : {}),
  };
}

export function formatExecutionPolicy(
  policy: NonNullable<WorkflowRunRecord['executionPolicy']>,
): string {
  if (policy.mode === 'named_branch') {
    return `named branch${policy.branch ? ` ${policy.branch}` : ''}`;
  }
  if (policy.mode === 'current_tree') return 'selected working tree';
  return 'isolated agent worktree';
}

/**
 * Callbacks the internal helpers need from the orchestrating WorkflowRunner.
 * Passed via constructor to avoid circular imports between the helper modules
 * and WorkflowRunner.
 */
export interface RunnerOps {
  requireRun(runId: string): Promise<WorkflowRunRecord>;
  saveAndEmit(run: WorkflowRunRecord): Promise<void>;
  failRun(runId: string, message: string): Promise<void>;
}
