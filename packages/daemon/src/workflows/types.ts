import type { WorkflowHookRules } from './hook-types.js';
import type { WorkflowInlineAgentDefinition } from './inline-agent-types.js';
import type { WorkflowInputValue } from './run-types.js';
import type {
  WorkflowContext,
  WorkflowDataCaptureDefinition,
  WorkflowExecutorCapability,
  WorkflowExecutorTargetKind,
  WorkflowNotificationDefinition,
  WorkflowPolicyDefinition,
  WorkflowRunnerRequirementV2,
  WorkflowTriggerDefinition,
} from './workflow-production-types.js';
export type { WorkflowRunEvent } from './event-types.js';
export type {
  WorkflowHookRules,
  WorkflowPermissionHookDecision,
  WorkflowPermissionHookRule,
} from './hook-types.js';
export type {
  WorkflowInlineAgentDefinition,
  WorkflowInlineAgentRunState,
} from './inline-agent-types.js';
export type {
  WorkflowContext,
  WorkflowContextReference,
  WorkflowDataCaptureDefinition,
  WorkflowExecutorCapability,
  WorkflowExecutorTargetKind,
  WorkflowNotificationDefinition,
  WorkflowPolicyDefinition,
  WorkflowRunnerRequirementV2,
  WorkflowTriggerDefinition,
} from './workflow-production-types.js';
export type {
  WorkflowApprovalActor,
  WorkflowApprovalDecision,
  WorkflowContractBinding,
  WorkflowContractBindingInput,
  WorkflowContractDigestStatus,
  WorkflowContractStatus,
  WorkflowContextReceiptRecord,
  WorkflowDataCapturePolicy,
  WorkflowInputValue,
  WorkflowLoopIterationRecord,
  WorkflowNodeRunState,
  WorkflowNodeStatus,
  WorkflowPreflightIssue,
  WorkflowPreflightResult,
  WorkflowRunArtifactRecord,
  WorkflowRunRecord,
  WorkflowRunRequest,
  WorkflowRunStatus,
  WorkflowTranscriptExcerptMessage,
} from './run-types.js';

export type WorkflowNodeType =
  | 'agent'
  | 'prompt'
  | 'shell'
  | 'checkout'
  | 'git_publish'
  | 'approval'
  | 'context_update'
  | 'context'
  | 'condition'
  | 'artifact'
  | 'action'
  | 'gate'
  | 'loop'
  | 'subflow'
  | 'plan';

/**
 * Join semantics when a node has multiple `needs`. Default is `all_success`.
 *
 * - `all_success`: every parent must reach `completed` for this node to run.
 * - `all_done`: every parent must reach a terminal state (completed, failed, skipped).
 * - `one_success`: at least one parent must `completed`.
 */
export type WorkflowTriggerRule = 'all_success' | 'all_done' | 'one_success';

export interface WorkflowInputDefinition {
  type: 'string' | 'number' | 'boolean' | 'json';
  required?: boolean;
  default?: WorkflowInputValue;
  description?: string;
}

export interface WorkflowRequires {
  agents?: string[];
  tools?: string[];
  integrations?: string[];
  secrets?: string[];
}

export interface WorkflowExecutorRequirement {
  targets?: WorkflowExecutorTargetKind[];
  defaultTarget?: WorkflowExecutorTargetKind;
  capabilities?: WorkflowExecutorCapability[];
}

export type WorkflowCapabilityRequest =
  | { type: 'secret'; ref: string; reason: string }
  | { type: 'network_egress'; host: string; reason: string }
  | { type: 'write_scope'; path: string; reason: string }
  | { type: 'repo_access'; ref: string; reason: string }
  | { type: 'context'; ref: string; reason: string };

export interface WorkflowOutputDefinition {
  type: 'string' | 'number' | 'boolean' | 'json' | 'file' | 'artifact';
  requirement?: 'required' | 'optional' | 'unsupported';
  description?: string;
  outputSchema?: Record<string, unknown>;
  /**
   * Optional JSONata expression evaluated against `{ output, json }`, where
   * `output` is the bulk text and `json` is the parsed bulk output when valid.
   */
  extract?: string;
}

export interface WorkflowArtifactDefinition {
  path: string;
  type?: 'file' | 'directory' | 'patch' | 'report' | 'log';
  description?: string;
}

export interface WorkflowRetryPolicy {
  maxAttempts: number;
  backoffSeconds?: number;
  transient?: string[];
  fatal?: string[];
}

export interface WorkflowNodePolicy {
  onFailure?: 'halt' | 'continue' | 'skip_dependents';
  approvalRequired?: boolean;
  reason?: string;
}

export type WorkflowGateDefinition =
  | { type: 'check'; expression: string; description?: string }
  | { type: 'policy'; expression: string; description?: string }
  | { type: 'human_review'; prompt: string; description?: string }
  | { type: 'schedule'; waitUntil: string; description?: string };

export interface WorkflowExecutionPolicy {
  mode: 'current_tree' | 'isolated_worktree' | 'named_branch';
  branch?: string;
}

export interface WorkflowEnvValue {
  value?: string;
  secret?: string;
}

export interface WorkflowNodeBase {
  type: WorkflowNodeType;
  title?: string;
  needs?: string[];
  /**
   * JSONata expression evaluated against the run context before this node runs.
   * If the expression resolves to a falsy value the node is marked `skipped` and
   * its outputs are unavailable to downstream references.
   */
  when?: string;
  /**
   * How to react to the `needs` set when one or more parents are non-success.
   * Defaults to `all_success`.
   */
  triggerRule?: WorkflowTriggerRule;
  timeoutSeconds?: number;
  retry?: WorkflowRetryPolicy;
  policy?: WorkflowNodePolicy;
  outputs?: Record<string, WorkflowOutputDefinition>;
  outputSchema?: Record<string, WorkflowOutputDefinition>;
  artifacts?: Record<string, WorkflowArtifactDefinition>;
  env?: Record<string, WorkflowEnvValue>;
  context?: WorkflowNodeContextEnvelope;
}

export interface WorkflowPromptNode extends WorkflowNodeBase {
  type: 'prompt';
  prompt: string;
  cwd?: string;
  /**
   * Files that must exist after the prompt node completes. Paths are resolved
   * relative to the node cwd/run directory and must stay inside that directory.
   */
  requiredFiles?: string[];
  agent?: string;
  provider?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  executionMode?: 'plan' | 'read_only' | 'implement' | 'review';
  allowedTools?: string[];
  hooks?: WorkflowHookRules;
  agents?: Record<string, WorkflowInlineAgentDefinition>;
  inlineAgentFailurePolicy?: 'fail' | 'continue';
}

export interface WorkflowAgentNode extends WorkflowNodeBase {
  type: 'agent';
  prompt: string;
  agent: string;
  provider?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  executionMode?: 'plan' | 'read_only' | 'implement' | 'review';
  allowedTools?: string[];
  session?: {
    resume?: boolean;
    title?: string;
  };
  handoff?: {
    artifact?: string;
    summary?: string;
  };
  hooks?: WorkflowHookRules;
}

export interface WorkflowShellNode extends WorkflowNodeBase {
  type: 'shell';
  command?: string;
  argv?: string[];
  cwd?: string;
}

export interface WorkflowCheckoutNode extends WorkflowNodeBase {
  type: 'checkout';
  repository: string;
  remote?: string;
  ref?: string;
  branch?: string;
  path?: string;
  credentialMode?: 'runner_local' | 'run_scoped_grant';
  credentialRef?: string;
}

export interface WorkflowGitPublishNode extends WorkflowNodeBase {
  type: 'git_publish';
  repository: string;
  cwd: string;
  branch: string;
  message: string;
  paths?: string[];
  allowEmpty?: boolean;
  push?: boolean;
  credentialMode?: 'runner_local' | 'run_scoped_grant';
  credentialRef?: string;
  // Policy blast-radius fences (composed from .viewport/policy.yaml repos[].branches/paths).
  // Tier-1 advisory enforcement: the daemon refuses to publish to a restricted branch.
  restrictedBranches?: string[];
  restrictedPaths?: string[];
}

export interface WorkflowApprovalRecipient {
  role?: string;
  tag?: string;
  user?: string;
  label?: string;
}

export interface WorkflowApprovalNode extends WorkflowNodeBase {
  type: 'approval';
  prompt: string;
  recipients?: WorkflowApprovalRecipient[];
  /** When true, the approver's message becomes the node's output. */
  captureResponse?: boolean;
  /**
   * Optional follow-up run when approval is denied, before the run fails.
   * Useful for notifications, audit log writes, rollbacks, or agent-authored
   * rejection summaries.
   */
  onReject?:
    | {
        command: string;
        cwd?: string;
        timeoutSeconds?: number;
      }
    | {
        prompt: string;
        agent?: string;
        model?: string;
        effort?: 'low' | 'medium' | 'high' | 'xhigh';
      };
}

export interface WorkflowPlanNode extends WorkflowNodeBase {
  type: 'plan';
  title?: string;
  body: string;
  summary?: string;
  source?: string;
  sourceRef?: string;
  waitForApproval?: boolean;
  recipients?: WorkflowApprovalRecipient[];
  revision?: {
    onRequestChanges?: 'revise_with_agent' | 'wait_for_new_plan';
    prompt?: string;
    agent?: string;
    model?: string;
    timeoutSeconds?: number;
  };
}

export interface WorkflowContextUpdateNode extends WorkflowNodeBase {
  type: 'context_update';
  targetRef: string;
  title: string;
  summary?: string;
  patch?: {
    mode?: 'append' | 'replace' | 'patch';
    text?: string;
    digest?: string;
    operation?: string;
    files?: Array<{
      path: string;
      operation?: string;
      patch_digest?: string;
      artifact_ref?: string;
      before_digest?: string;
      after_digest?: string;
    }>;
  };
  idempotencyKey?: string;
}

export interface WorkflowGateNode extends WorkflowNodeBase {
  type: 'gate';
  gate: WorkflowGateDefinition;
}

export interface WorkflowContextNode extends WorkflowNodeBase {
  type: 'context';
  refs?: WorkflowContext;
  query?: string;
  refresh?: 'manual' | 'before_run' | 'on_demand';
}

export type WorkflowContextWriteTarget =
  | string
  | {
      ref?: string;
      kind?: 'team_memory' | 'org_rule' | 'repo_pr' | 'context_vault' | 'vector_store' | 'external';
      path?: string;
      collection?: string;
      provider?: string;
      name?: string;
      approval?: 'required' | 'optional' | 'not_required';
    };

export interface WorkflowNodeContextEnvelope {
  include?: WorkflowContext;
  exclude?: WorkflowContext;
  max_items?: number;
  maxItems?: number;
  query?: string;
  write_targets?: WorkflowContextWriteTarget[];
  writeTargets?: WorkflowContextWriteTarget[];
  allow_expansion?: boolean;
  allowExpansion?: boolean;
}

export interface WorkflowContextDefaults {
  sources?: WorkflowContext;
  update_targets?: WorkflowContextWriteTarget[];
  updateTargets?: WorkflowContextWriteTarget[];
}

export interface WorkflowConditionNode extends WorkflowNodeBase {
  type: 'condition';
  expression: string;
  then?: string[];
  else?: string[];
}

export interface WorkflowArtifactNode extends WorkflowNodeBase {
  type: 'artifact';
  name: string;
  from?: string;
  path?: string;
  kind?: 'file' | 'directory' | 'patch' | 'report' | 'log' | 'url';
  description?: string;
}

export interface WorkflowActionNode extends WorkflowNodeBase {
  type: 'action';
  adapter: string;
  action: string;
  with?: Record<string, WorkflowInputValue>;
  proposalKey?: string;
  idempotencyKey?: string;
  requiresApproval?: boolean;
}

export type WorkflowLoopBody =
  | {
      type: 'shell';
      command: string;
      cwd?: string;
      timeoutSeconds?: number;
    }
  | {
      type: 'prompt';
      prompt: string;
      agent?: string;
      model?: string;
      effort?: 'low' | 'medium' | 'high' | 'xhigh';
    };

export interface WorkflowLoopNode extends WorkflowNodeBase {
  type: 'loop';
  foreach?: string;
  while?: string;
  until?: string;
  maxIterations: number;
  body: WorkflowLoopBody;
}

export type WorkflowSubflowChild = {
  type: 'shell';
  title?: string;
  needs?: string[];
  when?: string;
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
  outputs?: Record<string, WorkflowOutputDefinition>;
};

export interface WorkflowSubflowNode extends WorkflowNodeBase {
  type: 'subflow';
  inline: { nodes: Record<string, WorkflowSubflowChild> };
  inputs?: Record<string, string>;
}

export type WorkflowNode =
  | WorkflowAgentNode
  | WorkflowPromptNode
  | WorkflowShellNode
  | WorkflowCheckoutNode
  | WorkflowGitPublishNode
  | WorkflowApprovalNode
  | WorkflowPlanNode
  | WorkflowContextUpdateNode
  | WorkflowGateNode
  | WorkflowContextNode
  | WorkflowConditionNode
  | WorkflowArtifactNode
  | WorkflowActionNode
  | WorkflowLoopNode
  | WorkflowSubflowNode;

export interface WorkflowDefinition {
  schema: 'viewport.workflow/v1';
  name: string;
  title?: string;
  description?: string;
  scope?: {
    repos?: string[];
  };
  inputs?: Record<string, WorkflowInputDefinition>;
  triggers?: WorkflowTriggerDefinition[];
  context?: WorkflowContext | WorkflowContextDefaults;
  requires?: WorkflowRequires;
  executor?: WorkflowExecutorRequirement;
  runner?: WorkflowRunnerRequirementV2;
  policies?: WorkflowPolicyDefinition;
  notifications?: WorkflowNotificationDefinition;
  dataCapture?: WorkflowDataCaptureDefinition;
  capabilityRequests?: WorkflowCapabilityRequest[];
  nodes: Record<string, WorkflowNode>;
}

export interface ParsedWorkflow {
  definition: WorkflowDefinition;
  digest: string;
  sourcePath: string;
  sourceText: string;
  normalizedJson: string;
}
