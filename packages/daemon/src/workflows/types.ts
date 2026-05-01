import type { WorkflowHookRules } from './hook-types.js';
import type { WorkflowInlineAgentDefinition } from './inline-agent-types.js';
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
  WorkflowDataCapturePolicy,
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
