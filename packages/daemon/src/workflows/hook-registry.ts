import type { HookEventKind, HookResponse } from '../hooks/types.js';
import type { WorkflowHookRules, WorkflowPermissionHookDecision } from './types.js';

export type WorkflowHookEventKind = Extract<
  HookEventKind,
  'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PermissionRequest'
>;

export interface WorkflowHookRegistration {
  sessionId: string;
  workflowRunId: string;
  workflowNodeId: string;
  hooks: WorkflowHookRules;
}

export interface WorkflowHookMatch {
  registration: WorkflowHookRegistration;
  hookKind: WorkflowHookEventKind;
  response?: HookResponse;
}

class WorkflowHookRegistry {
  private readonly registrations = new Map<string, WorkflowHookRegistration>();

  register(registration: WorkflowHookRegistration): void {
    this.registrations.set(registration.sessionId, registration);
  }

  unregister(sessionId: string): void {
    this.registrations.delete(sessionId);
  }

  clear(): void {
    this.registrations.clear();
  }

  resolve(
    sessionId: string,
    hookKind: HookEventKind,
    data: Record<string, unknown>,
  ): WorkflowHookMatch | null {
    const registration = this.registrations.get(sessionId);
    if (!registration) return null;

    if (hookKind === 'PermissionRequest') {
      const decision = selectPermissionDecision(registration.hooks.PermissionRequest, data);
      if (!decision) return null;
      return {
        registration,
        hookKind,
        response: {
          passthrough: false,
          decision: {
            behavior: decision.behavior,
            ...(decision.message ? { message: decision.message } : {}),
          },
        },
      };
    }

    if (!isWorkflowHookEventKind(hookKind)) return null;
    const rule = registration.hooks[hookKind];
    if (!rule || rule.record === false) return null;
    return { registration, hookKind };
  }
}

export const workflowHookRegistry = new WorkflowHookRegistry();

function selectPermissionDecision(
  rule: WorkflowHookRules['PermissionRequest'],
  data: Record<string, unknown>,
): WorkflowPermissionHookDecision | null {
  if (!rule) return null;
  if ('behavior' in rule) return rule;

  const toolName = typeof data.tool_name === 'string' ? data.tool_name : 'unknown';
  return rule.tools?.[toolName] ?? rule.default ?? null;
}

function isWorkflowHookEventKind(kind: HookEventKind): kind is WorkflowHookEventKind {
  return kind === 'PreToolUse' || kind === 'PostToolUse' || kind === 'PostToolUseFailure';
}
