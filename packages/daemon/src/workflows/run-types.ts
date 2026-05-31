import type { WorkflowRunEvent } from './event-types.js';
import type { SessionResourceManifest } from '../config-resolution/index.js';
import type { WorkflowInlineAgentRunState } from './inline-agent-types.js';
import type {
  WorkflowArtifactDefinition,
  WorkflowExecutionPolicy,
  WorkflowNodeType,
} from './types.js';
import type { WorkflowRunPreparation } from './run-preparation.js';

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
    decision?: 'approve' | 'request_changes' | 'reject';
    message?: string;
    expectedActionDigest?: string;
    actor?: WorkflowApprovalActor;
    feedback?: Record<string, unknown>;
    executionGrant?: WorkflowExecutionGrant;
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

export interface WorkflowContextReceiptRecord {
  schema: 'viewport.context_receipt/v1';
  package: string;
  requested: string;
  resolvedVersion: string;
  provider: string;
  digest: string;
  freshness: string;
  usedBy: {
    runId: string;
    nodeId?: string;
    providerId?: string;
    itemId?: string;
    alias?: string | null;
    title?: string;
  };
  resolvedAt: string;
}

export interface WorkflowActionExecutionLedgerEntry {
  nodeId: string;
  adapter: string;
  action: string;
  idempotencyKey: string;
  digest: string;
  output: string;
  executedAt: number;
  response?: Record<string, unknown>;
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
  resourceId?: string;
  resourceManifest?: SessionResourceManifest;
  workflowContract?: WorkflowContractBinding;
  workflowAuthorityContract?: Record<string, unknown>;
  runPreparation?: WorkflowRunPreparation;
  runtimeTargetId?: string;
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
  contextReceipts?: WorkflowContextReceiptRecord[];
  /**
   * Local trusted-edge ledger of side effects that have already executed for
   * this run. The runner only keys this by explicit idempotency keys. Actions
   * without idempotency keys are never guessed as duplicate-safe.
   */
  actionLedger?: Record<string, WorkflowActionExecutionLedgerEntry>;
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
  workflowContract?: WorkflowContractBindingInput;
  workflowAuthorityContract?: Record<string, unknown>;
  directoryId: string;
  inputs?: Record<string, WorkflowInputValue>;
  /**
   * Transient, run-scoped secret material keyed by environment variable name.
   * This is intentionally request-only: it must never be copied to
   * WorkflowRunRecord, synced to the control plane, or written to run inputs.
   */
  runtimeSecretEnv?: Record<string, string>;
  /**
   * Transient, run-scoped secret file paths keyed by environment variable
   * name. These paths are process-local handoff references for worker/daemon
   * boundaries and must never be copied to WorkflowRunRecord, synced to the
   * control plane, or written to run inputs.
   */
  runtimeSecretFiles?: Record<string, string>;
  resourceId?: string;
  runtimeTargetId?: string;
  platformRunId?: string;
  rerunOfWorkflowRunId?: string;
  resourceManifest?: SessionResourceManifest;
  executionPolicy?: WorkflowExecutionPolicy;
  dataCapturePolicy?: WorkflowDataCapturePolicy;
  initiation: WorkflowRunRecord['initiation'];
}

export type WorkflowContractStatus = 'verified' | 'undeclared' | 'digest_mismatch';
export type WorkflowContractDigestStatus = 'matched' | 'unpinned' | 'mismatch';

export interface WorkflowContractBindingInput {
  id?: string;
  sourceConfigPath?: string;
  declaredPath?: string;
  resource?: string;
  version?: string;
  declaredDigest?: string;
  status: WorkflowContractStatus;
  reason?: string;
}

export interface WorkflowContractBinding extends WorkflowContractBindingInput {
  actualDigest: string;
  digestStatus: WorkflowContractDigestStatus;
}

export interface WorkflowApprovalDecision {
  approved: boolean;
  decision?: 'approve' | 'request_changes' | 'reject';
  message?: string;
  expectedActionDigest?: string;
  runtimeSecretEnv?: Record<string, string>;
  runtimeSecretFiles?: Record<string, string>;
  actor?: WorkflowApprovalActor;
  feedback?: Record<string, unknown>;
  executionGrant?: WorkflowExecutionGrant;
}

export interface WorkflowApprovalActor {
  id?: string;
  name?: string;
  email?: string;
  source?: string;
}

export interface WorkflowExecutionGrant {
  schema?: string;
  digest: string;
  proposal_key?: string;
  approval_decision_key?: string;
  issued_at?: string;
}
