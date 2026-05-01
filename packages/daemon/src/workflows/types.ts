import type { WorkflowHookRules } from './hook-types.js';
import type { WorkflowRunEvent } from './event-types.js';
import type {
  WorkflowInlineAgentDefinition,
  WorkflowInlineAgentRunState,
} from './inline-agent-types.js';
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

export type WorkflowNodeType = 'prompt' | 'shell' | 'approval' | 'gate' | 'loop' | 'subflow';

/**
 * Join semantics when a node has multiple `needs`. Default is `all_success`.
 *
 * - `all_success`: every parent must reach `completed` for this node to run.
 * - `all_done`: every parent must reach a terminal state (completed, failed, skipped).
 * - `one_success`: at least one parent must `completed`.
 */
export type WorkflowTriggerRule = 'all_success' | 'all_done' | 'one_success';

export interface WorkflowInputDefinition {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  description?: string;
}

export interface WorkflowRequires {
  agents?: string[];
  tools?: string[];
  integrations?: string[];
  secrets?: string[];
}

export interface WorkflowOutputDefinition {
  type: 'string' | 'number' | 'boolean' | 'json' | 'file' | 'artifact';
  description?: string;
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

export interface WorkflowGateNode extends WorkflowNodeBase {
  type: 'gate';
  gate: WorkflowGateDefinition;
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
  | WorkflowPromptNode
  | WorkflowShellNode
  | WorkflowApprovalNode
  | WorkflowGateNode
  | WorkflowLoopNode
  | WorkflowSubflowNode;

export interface WorkflowDefinition {
  schema: 'viewport.workflow/v1';
  name: string;
  title?: string;
  description?: string;
  inputs?: Record<string, WorkflowInputDefinition>;
  requires?: WorkflowRequires;
  nodes: Record<string, WorkflowNode>;
}

export interface ParsedWorkflow {
  definition: WorkflowDefinition;
  digest: string;
  sourcePath: string;
  sourceText: string;
  normalizedJson: string;
}

export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'canceled';
export type WorkflowNodeStatus =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'canceled';

export interface WorkflowNodeRunState {
  id: string;
  type: WorkflowNodeType;
  title?: string;
  status: WorkflowNodeStatus;
  startedAt?: number;
  completedAt?: number;
  sessionId?: string;
  nativeSessionId?: string;
  worktreePath?: string;
  output?: string;
  /**
   * Structured outputs declared by the node, populated after the node runs.
   * Keys correspond to entries in `WorkflowNodeBase.outputs`. Values are
   * coerced based on declared `type` (string, json, number, boolean) — text
   * passthrough for `string`, `JSON.parse` for `json` (best-effort).
   */
  outputs?: Record<string, unknown>;
  exitCode?: number;
  error?: string;
  /**
   * Set when the node was skipped because its `when` expression resolved
   * falsy or its `triggerRule` was unsatisfied.
   */
  skipReason?: string;
  metadata?: Record<string, unknown>;
  approval?: {
    prompt: string;
    requestedAt: number;
    resolvedAt?: number;
    approved?: boolean;
    message?: string;
    actor?: WorkflowApprovalActor;
  };
  /**
   * Per-iteration records for `loop` nodes. Each entry captures one body run.
   * The aggregate `output` of a loop node is `iterations.map(it => it.output)`
   * encoded as JSON, so `{{ nodes.<id>.output }}` yields the full series.
   */
  iterations?: WorkflowLoopIterationRecord[];
  /**
   * Number of attempts the runner made for this node, including retries. 1
   * for the common single-attempt path; > 1 only when `retry.maxAttempts > 1`
   * and at least one transient failure was reclassified as retryable.
   */
  attempts?: number;
  inlineAgents?: Record<string, WorkflowInlineAgentRunState>;
}

export interface WorkflowLoopIterationRecord {
  index: number;
  status: 'running' | 'completed' | 'failed' | 'skipped' | 'canceled';
  startedAt: number;
  completedAt?: number;
  sessionId?: string;
  nativeSessionId?: string;
  worktreePath?: string;
  output?: string;
  exitCode?: number;
  error?: string;
  /** The `$loop.item` value (foreach mode only). Stored for replay/inspection. */
  item?: unknown;
}

export interface WorkflowRunArtifactRecord {
  id: string;
  runId: string;
  nodeId: string;
  name: string;
  kind: WorkflowArtifactDefinition['type'];
  path: string;
  digest?: string;
  description?: string;
  sizeBytes?: number;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface WorkflowRunRecord {
  id: string;
  workflowName: string;
  workflowTitle?: string;
  sourceType: 'local_file' | 'viewport_snapshot' | 'local_modified';
  sourcePath?: string;
  digest: string;
  schema: string;
  yamlSnapshot: string;
  directoryId: string;
  directoryPath: string;
  projectId?: string;
  projectMachineBindingId?: string;
  platformRunId?: string;
  rerunOfWorkflowRunId?: string;
  machineId: string;
  executionPolicy?: WorkflowExecutionPolicy;
  initiation: 'cli' | 'browser' | 'agent_skill';
  status: WorkflowRunStatus;
  inputs: Record<string, string | number | boolean>;
  preflight: WorkflowPreflightResult;
  nodes: Record<string, WorkflowNodeRunState>;
  artifacts: WorkflowRunArtifactRecord[];
  events: WorkflowRunEvent[];
  createdAt: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
}

export interface WorkflowPreflightIssue {
  kind: 'agent' | 'tool' | 'node';
  name: string;
  message: string;
}

export interface WorkflowPreflightResult {
  ok: boolean;
  issues: WorkflowPreflightIssue[];
}

export interface WorkflowRunRequest {
  workflowPath?: string;
  workflowYaml?: string;
  workflowSourceRef?: string;
  directoryId: string;
  inputs?: Record<string, string | number | boolean>;
  projectId?: string;
  projectMachineBindingId?: string;
  platformRunId?: string;
  rerunOfWorkflowRunId?: string;
  executionPolicy?: WorkflowExecutionPolicy;
  initiation: WorkflowRunRecord['initiation'];
}

export interface WorkflowApprovalDecision {
  approved: boolean;
  message?: string;
  actor?: WorkflowApprovalActor;
}

export interface WorkflowApprovalActor {
  id?: string;
  name?: string;
  email?: string;
  source?: string;
}
