import type { WorkflowRunEvent } from './event-types.js';
import type { WorkflowInlineAgentRunState } from './inline-agent-types.js';
import type {
  WorkflowArtifactDefinition,
  WorkflowExecutionPolicy,
  WorkflowNodeType,
} from './types.js';

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
  transcriptExcerpt?: WorkflowTranscriptExcerptMessage[];
  /**
   * Structured outputs declared by the node, populated after the node runs.
   * Keys correspond to entries in `WorkflowNodeBase.outputs`. Values are
   * coerced based on declared `type` (string, json, number, boolean): text
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

export interface WorkflowTranscriptExcerptMessage {
  role: 'user' | 'assistant';
  text: string;
}

export type WorkflowInputValue =
  | string
  | number
  | boolean
  | null
  | WorkflowInputValue[]
  | { [key: string]: WorkflowInputValue };

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

export interface WorkflowDataCapturePolicy {
  /**
   * Controls whether prompt-node transcript previews leave the machine.
   * Full native agent transcripts are intentionally not part of v1 sync.
   */
  transcripts: 'none' | 'excerpt';
  /**
   * `metadata` preserves event timing/source without stdout/stderr content.
   */
  logs: 'metadata' | 'content';
  /**
   * `local_reference` stores local path metadata only; it never uploads bytes.
   */
  artifacts: 'metadata' | 'local_reference';
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
  dataCapturePolicy?: WorkflowDataCapturePolicy;
  initiation: 'cli' | 'browser' | 'agent_skill';
  status: WorkflowRunStatus;
  inputs: Record<string, WorkflowInputValue>;
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
  inputs?: Record<string, WorkflowInputValue>;
  projectId?: string;
  projectMachineBindingId?: string;
  platformRunId?: string;
  rerunOfWorkflowRunId?: string;
  executionPolicy?: WorkflowExecutionPolicy;
  dataCapturePolicy?: WorkflowDataCapturePolicy;
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
