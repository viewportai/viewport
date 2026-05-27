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
