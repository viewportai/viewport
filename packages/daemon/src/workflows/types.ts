export type WorkflowNodeType = 'prompt' | 'shell' | 'approval';

export interface WorkflowInputDefinition {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  description?: string;
}

export interface WorkflowRequires {
  agents?: string[];
  tools?: string[];
}

export interface WorkflowNodeBase {
  type: WorkflowNodeType;
  title?: string;
  needs?: string[];
}

export interface WorkflowPromptNode extends WorkflowNodeBase {
  type: 'prompt';
  prompt: string;
  agent?: string;
  model?: string;
}

export interface WorkflowShellNode extends WorkflowNodeBase {
  type: 'shell';
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
}

export interface WorkflowApprovalNode extends WorkflowNodeBase {
  type: 'approval';
  prompt: string;
}

export type WorkflowNode = WorkflowPromptNode | WorkflowShellNode | WorkflowApprovalNode;

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
  | 'skipped';

export interface WorkflowNodeRunState {
  id: string;
  type: WorkflowNodeType;
  title?: string;
  status: WorkflowNodeStatus;
  startedAt?: number;
  completedAt?: number;
  sessionId?: string;
  worktreePath?: string;
  output?: string;
  error?: string;
}

export interface WorkflowRunEvent {
  id: string;
  runId: string;
  timestamp: number;
  type:
    | 'run-created'
    | 'run-started'
    | 'run-blocked'
    | 'run-completed'
    | 'run-failed'
    | 'node-started'
    | 'node-output'
    | 'node-completed'
    | 'node-failed'
    | 'session-started'
    | 'session-idle'
    | 'session-ended';
  nodeId?: string;
  message: string;
  data?: Record<string, unknown>;
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
  machineId: string;
  initiation: 'cli' | 'browser' | 'agent_skill';
  status: WorkflowRunStatus;
  inputs: Record<string, string | number | boolean>;
  preflight: WorkflowPreflightResult;
  nodes: Record<string, WorkflowNodeRunState>;
  events: WorkflowRunEvent[];
  createdAt: number;
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
  initiation: WorkflowRunRecord['initiation'];
}
