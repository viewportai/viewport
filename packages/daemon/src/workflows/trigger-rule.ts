import type { WorkflowNodeRunState, WorkflowRunRecord, WorkflowTriggerRule } from './types.js';

export interface TriggerEvaluation {
  ready: boolean;
  /** When `ready` is false, why — used for `node-skipped` events. */
  reason?: string;
}

/**
 * Decide whether a node may run given its parents' current states.
 *
 * Rules:
 *   - `all_success` (default): every parent must be `completed`. If any parent
 *     is `failed`, `skipped`, or `canceled`, the node is permanently
 *     unsatisfiable and should be skipped. If parents are still in flight, the
 *     node is not ready yet (but the runner currently runs in topological
 *     order, so by the time we evaluate a node every parent is terminal).
 *   - `all_done`: every parent must be in any terminal state.
 *   - `one_success`: at least one parent must be `completed`.
 */
export function evaluateTriggerRule(
  rule: WorkflowTriggerRule | undefined,
  parents: WorkflowNodeRunState[],
): TriggerEvaluation {
  const effective = rule ?? 'all_success';
  if (parents.length === 0) return { ready: true };

  const successes = parents.filter((parent) => parent.status === 'completed').length;
  const terminals = parents.filter((parent) =>
    ['completed', 'failed', 'skipped', 'canceled'].includes(parent.status),
  ).length;

  if (effective === 'all_success') {
    if (successes === parents.length) return { ready: true };
    const failedParent = parents.find((parent) => parent.status !== 'completed');
    return {
      ready: false,
      reason: `triggerRule=all_success: parent ${failedParent?.id ?? 'unknown'} is ${
        failedParent?.status ?? 'not completed'
      }`,
    };
  }

  if (effective === 'all_done') {
    if (terminals === parents.length) return { ready: true };
    return {
      ready: false,
      reason: 'triggerRule=all_done: not all parents reached a terminal state',
    };
  }

  if (effective === 'one_success') {
    if (successes >= 1) return { ready: true };
    return {
      ready: false,
      reason: 'triggerRule=one_success: no parent reached completed',
    };
  }

  return { ready: false, reason: `Unknown triggerRule: ${effective satisfies never}` };
}

const TRIGGER_PREFIX = 'triggerRule=';

export function isTriggerSkipReason(reason: string | undefined): boolean {
  return Boolean(reason?.startsWith(TRIGGER_PREFIX));
}

export function getNodeParents(
  run: WorkflowRunRecord,
  needs: string[] | undefined,
): WorkflowNodeRunState[] {
  if (!needs || needs.length === 0) return [];
  return needs
    .map((parentId) => run.nodes[parentId])
    .filter((parent): parent is WorkflowNodeRunState => Boolean(parent));
}
