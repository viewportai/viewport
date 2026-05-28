import type { SessionExecutionMode } from '../core/types.js';

export const WORKFLOW_SESSION_TIMEOUT_DEFAULTS_SECONDS: Record<SessionExecutionMode, number> = {
  plan: 600,
  read_only: 900,
  review: 900,
  implement: 1800,
};

export interface ResolvedWorkflowSessionPolicy {
  executionMode: SessionExecutionMode;
  timeoutSeconds: number;
  executionModeDefaulted: boolean;
  timeoutDefaulted: boolean;
}

export interface WorkflowSessionBudget {
  maxTokens?: number;
  maxCostUsd?: number;
  maxTurns?: number;
}

export function resolveWorkflowSessionPolicy(input: {
  executionMode?: SessionExecutionMode;
  timeoutSeconds?: number;
  defaultExecutionMode?: SessionExecutionMode;
}): ResolvedWorkflowSessionPolicy {
  const executionMode = input.executionMode ?? input.defaultExecutionMode ?? 'implement';
  return {
    executionMode,
    timeoutSeconds:
      input.timeoutSeconds ?? WORKFLOW_SESSION_TIMEOUT_DEFAULTS_SECONDS[executionMode],
    executionModeDefaulted: input.executionMode === undefined,
    timeoutDefaulted: input.timeoutSeconds === undefined,
  };
}

export function resolveInlineAgentExecutionMode(input: {
  explicitExecutionMode?: SessionExecutionMode;
  parentExecutionMode?: SessionExecutionMode;
}): SessionExecutionMode {
  if (input.explicitExecutionMode) return input.explicitExecutionMode;
  switch (input.parentExecutionMode) {
    case 'plan':
      return 'plan';
    case 'read_only':
      return 'read_only';
    case 'review':
      return 'review';
    case 'implement':
    case undefined:
      return 'review';
  }
}

export function resolveWorkflowSessionBudget(
  input:
    | {
        maxTokens?: number;
        tokens?: number;
        maxCostUsd?: number;
        usd?: number;
        maxTurns?: number;
      }
    | undefined,
): WorkflowSessionBudget | undefined {
  const maxTokens = positiveNumber(input?.maxTokens ?? input?.tokens);
  const maxCostUsd = positiveNumber(input?.maxCostUsd ?? input?.usd);
  const maxTurns = positiveNumber(input?.maxTurns);
  const budget: WorkflowSessionBudget = {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
  return Object.keys(budget).length > 0 ? budget : undefined;
}

export function resolveWorkflowAuthoritySessionBudget(
  contract: Record<string, unknown> | null | undefined,
): WorkflowSessionBudget | undefined {
  const budget = recordValue(contract?.['budget'] ?? contract?.['budgets']);
  const maxInputTokens = positiveNumber(
    budget?.['maxInputTokens'] ?? budget?.['max_input_tokens'] ?? budget?.['input_tokens'],
  );
  const maxOutputTokens = positiveNumber(
    budget?.['maxOutputTokens'] ?? budget?.['max_output_tokens'] ?? budget?.['output_tokens'],
  );
  const tokenCap =
    positiveNumber(
      budget?.['maxTokens'] ??
        budget?.['max_tokens'] ??
        budget?.['tokens'] ??
        budget?.['maxTotalTokens'] ??
        budget?.['max_total_tokens'],
    ) ??
    (maxInputTokens !== undefined || maxOutputTokens !== undefined
      ? (maxInputTokens ?? 0) + (maxOutputTokens ?? 0)
      : undefined);

  return resolveWorkflowSessionBudget({
    ...(tokenCap !== undefined ? { maxTokens: tokenCap } : {}),
    maxCostUsd: positiveNumber(
      budget?.['maxCostUsd'] ??
        budget?.['max_cost_usd'] ??
        budget?.['costUsd'] ??
        budget?.['cost_usd'] ??
        budget?.['usd'],
    ),
    maxTurns: positiveNumber(budget?.['maxTurns'] ?? budget?.['max_turns']),
  });
}

export function mergeWorkflowSessionBudgets(
  ...budgets: Array<WorkflowSessionBudget | undefined>
): WorkflowSessionBudget | undefined {
  const merged: WorkflowSessionBudget = {};
  for (const budget of budgets) {
    if (!budget) continue;
    merged.maxTokens = stricterPositiveNumber(merged.maxTokens, budget.maxTokens);
    merged.maxCostUsd = stricterPositiveNumber(merged.maxCostUsd, budget.maxCostUsd);
    merged.maxTurns = stricterPositiveNumber(merged.maxTurns, budget.maxTurns);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveWorkflowRunSessionBudget(
  workflowBudget:
    | {
        maxTokens?: number;
        tokens?: number;
        maxCostUsd?: number;
        usd?: number;
        maxTurns?: number;
      }
    | undefined,
  authorityContract: Record<string, unknown> | null | undefined,
): WorkflowSessionBudget | undefined {
  return mergeWorkflowSessionBudgets(
    resolveWorkflowSessionBudget(workflowBudget),
    resolveWorkflowAuthoritySessionBudget(authorityContract),
  );
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function stricterPositiveNumber(current: number | undefined, candidate: number | undefined) {
  if (candidate === undefined) return current;
  if (current === undefined) return candidate;
  return Math.min(current, candidate);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
