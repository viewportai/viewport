import type { WorkflowHookRules } from './hook-types.js';
import type { WorkflowInlineAgentDefinition } from './inline-agent-types.js';
import type { WorkflowInputValue } from './run-types.js';
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
  WorkflowApprovalActor,
  WorkflowApprovalDecision,
  WorkflowContractBinding,
  WorkflowContractBindingInput,
  WorkflowContractDigestStatus,
  WorkflowContractStatus,
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
  | 'approval'
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

export type WorkflowExecutorTargetKind =
  | 'local_private'
  | 'local_sandbox'
  | 'managed'
  | 'self_hosted'
  | 'ci';

export type WorkflowExecutorCapability =
  | 'agent.prompt'
  | 'artifacts'
  | 'cancel'
  | 'files.read'
  | 'files.write'
  | 'network.egress'
  | 'resume'
  | 'secrets'
  | 'shell'
  | 'worktree';

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

export type WorkflowTriggerDefinition =
  | {
      type: 'manual';
      title?: string;
      description?: string;
      inputs?: Record<string, WorkflowInputValue>;
    }
  | {
      type: 'webhook';
      title?: string;
      provider?: string;
      route?: string;
      eventTypes?: string[];
      signature?: {
        algorithm: 'hmac-sha256';
        header: string;
        timestampHeader?: string;
        toleranceSeconds?: number;
      };
      map?: Record<string, string>;
    }
  | {
      type: 'schedule';
      title?: string;
      cron: string;
      timezone?: string;
      missedRun?: 'skip' | 'catch_up_once' | 'route_to_inbox';
    };

export interface WorkflowRunnerRequirementV2 {
  kind?: 'paired_daemon' | 'self_hosted_runner';
  target?: WorkflowExecutorTargetKind;
  capabilities?: WorkflowExecutorCapability[];
  labels?: string[];
  profile?: string;
  leaseSeconds?: number;
}

export interface WorkflowPolicyDefinition {
  run?: {
    allowed?: string[];
    requireOnlineRunner?: boolean;
  };
  approve?: {
    allowed?: string[];
    minApprovals?: number;
  };
  sideEffects?: {
    requireApproval?: boolean;
    allowedAdapters?: string[];
  };
  maxDurationSeconds?: number;
}

export interface WorkflowNotificationDefinition {
  inbox?: Array<'approval_requested' | 'run_failed' | 'runner_offline' | 'action_failed'>;
  email?: Array<'approval_requested' | 'run_failed' | 'run_completed'>;
  webhook?: string[];
}

export interface WorkflowDataCaptureDefinition {
  logs?: 'compact' | 'full' | 'off';
  artifacts?: boolean;
  contextEvidence?: boolean;
  approvalPackets?: boolean;
}

export interface WorkflowContextReference {
  ref: string;
  as?: string;
  required?: boolean;
  description?: string;
  refresh?: 'manual' | 'before_run' | 'on_demand';
}

export type WorkflowContext = Array<string | WorkflowContextReference>;

export interface WorkflowOutputDefinition {
  type: 'string' | 'number' | 'boolean' | 'json' | 'file' | 'artifact';
  description?: string;
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
  artifacts?: Record<string, WorkflowArtifactDefinition>;
  env?: Record<string, WorkflowEnvValue>;
}

export interface WorkflowPromptNode extends WorkflowNodeBase {
  type: 'prompt';
  prompt: string;
  agent?: string;
  provider?: string;
  model?: string;
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
  command: string;
  cwd?: string;
}

export interface WorkflowApprovalNode extends WorkflowNodeBase {
  type: 'approval';
  prompt: string;
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
  | WorkflowApprovalNode
  | WorkflowPlanNode
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
  inputs?: Record<string, WorkflowInputDefinition>;
  triggers?: WorkflowTriggerDefinition[];
  context?: WorkflowContext;
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
