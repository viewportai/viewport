export interface WorkflowPermissionHookDecision {
  behavior: 'allow' | 'deny';
  message?: string;
}

export type WorkflowPermissionHookRule =
  | WorkflowPermissionHookDecision
  | {
      default?: WorkflowPermissionHookDecision;
      tools?: Record<string, WorkflowPermissionHookDecision>;
    };

export interface WorkflowHookRules {
  PreToolUse?: { record?: boolean };
  PostToolUse?: { record?: boolean };
  PostToolUseFailure?: { record?: boolean };
  PermissionRequest?: WorkflowPermissionHookRule;
}
