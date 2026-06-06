import type { SessionResourceManifest } from '../config-resolution/index.js';
import type { WorkflowInputValue } from '../workflows/types.js';

export interface ManagedWorkerOptions {
  server: string;
  serverId?: string;
  workspaceId: string;
  executorId: string;
  credential: string;
  accessMode: ManagedWorkerAccessMode;
  runnerProfile?: string;
  runnerPosture?: Record<string, unknown>;
  workerSessionId: string;
  runnerKeyPair: ManagedWorkerRunnerKeyPair;
  signingIdentity?: ManagedWorkerSigningIdentity;
  runnerPool?: string;
  workdir?: string;
  leaseSeconds: number;
  sleepSeconds: number;
  commandSleepSeconds: number;
  maxRuns?: number;
  once: boolean;
  capabilities: ManagedWorkerCapabilities;
}

export interface ManagedWorkerRunnerKeyPair {
  schema: 'viewport.runner_keypair/v1';
  algorithm: 'RSA-OAEP-256';
  publicKeyPem: string;
  privateKeyPem: string;
  fingerprint: string;
  path: string;
}

export interface ManagedWorkerSigningIdentity {
  algorithm: 'ed25519';
  publicKeyPem: string;
  privateKeyPem: string;
  fingerprint: string;
  serverId?: string;
  path: string;
}

export type ManagedWorkerAccessMode = 'relay' | 'polling' | 'direct';

export interface ManagedWorkerCapabilities {
  runnerPool?: string;
  agentCommand?: string;
  actionCommand?: string;
  providerActions: boolean;
  tools: string[];
  agents: string[];
  models: string[];
  agentModels?: Record<string, string[]>;
  integrations: string[];
  secrets: string[];
}

export interface ManagedAssignment {
  id: string;
  assignment_claim_token?: string | null;
  runtime_commands?: Array<Record<string, unknown>> | null;
  session_verification_contract?: ManagedSessionVerificationContract | null;
  sessionVerificationContract?: ManagedSessionVerificationContract | null;
  schema_versions?: Record<string, unknown> | null;
  target_snapshot?: Record<string, unknown> | null;
  targetSnapshot?: Record<string, unknown> | null;
  route_snapshot?: Record<string, unknown> | null;
  routeSnapshot?: Record<string, unknown> | null;
  execution_profile_snapshot?: Record<string, unknown> | null;
  executionProfileSnapshot?: Record<string, unknown> | null;
  workflow_snapshot?: Record<string, unknown> | null;
  workflowSnapshot?: Record<string, unknown> | null;
  runner_workspace_snapshot?: Record<string, unknown> | null;
  runnerWorkspaceSnapshot?: Record<string, unknown> | null;
  resource_manifest?: SessionResourceManifest | null;
  resourceManifest?: SessionResourceManifest | null;
  workflow_authority_contract?: Record<string, unknown> | null;
  workflowAuthorityContract?: Record<string, unknown> | null;
  context_receipts_snapshot?: unknown[] | Record<string, unknown> | null;
  contextReceiptsSnapshot?: unknown[] | Record<string, unknown> | null;
  yaml_snapshot?: string | null;
  source_ref?: string | null;
  directory_path?: string | null;
  runtime_run_id?: string | null;
  runtime_target_id?: string | null;
  input_snapshot?: Record<string, WorkflowInputValue> | null;
  data_capture_policy?: {
    transcripts?: 'none' | 'excerpt';
    logs?: 'metadata' | 'content';
    artifacts?: 'metadata' | 'local_reference';
  } | null;
  status?: string | null;
  nodes?: Array<{
    node_key: string;
    type?: string | null;
    status?: string | null;
    output?: string | null;
    error?: string | null;
    metadata?: Record<string, unknown> | null;
  }>;
}

export interface ManagedSessionVerificationContract {
  schema?: string | null;
  agent_session_id?: string | null;
  agentSessionId?: string | null;
  workspace_id?: string | null;
  workspaceId?: string | null;
  workflow_run_id?: string | null;
  workflowRunId?: string | null;
  status?: string | null;
  commands?: ManagedSessionVerificationCommand[] | null;
  required_artifacts?: string[] | null;
  requiredArtifacts?: string[] | null;
  repair_policy?: Record<string, unknown> | null;
  repairPolicy?: Record<string, unknown> | null;
  review_policy?: Record<string, unknown> | null;
  reviewPolicy?: Record<string, unknown> | null;
  runtime_tool?: ManagedSessionVerificationRuntimeTool | null;
  runtimeTool?: ManagedSessionVerificationRuntimeTool | null;
  access_model?: ManagedSessionVerificationAccessModel | null;
  accessModel?: ManagedSessionVerificationAccessModel | null;
  [key: string]: unknown;
}

export interface ManagedSessionVerificationCommand {
  schema?: string | null;
  name?: string | null;
  command?: string | null;
  required?: boolean | null;
  timeout?: string | null;
  working_directory?: string | null;
  workingDirectory?: string | null;
  source?: string | null;
  [key: string]: unknown;
}

export interface ManagedSessionVerificationRuntimeTool {
  name?: string | null;
  runtime_endpoint?: string | null;
  runtimeEndpoint?: string | null;
  method?: string | null;
  [key: string]: unknown;
}

export interface ManagedSessionVerificationAccessModel {
  runner_may_execute_commands?: boolean | null;
  runnerMayExecuteCommands?: boolean | null;
  [key: string]: unknown;
}

export interface DirectoryInfo {
  id: string;
  path: string;
}

export interface ManagedActionReplayAssignment {
  id: string;
  claim_token?: string | null;
  resource_id?: string | null;
  workflow_run_id?: string | null;
  workflow_run_node_id?: string | null;
  workflow_action_proposal_id?: string | null;
  source_execution_receipt_id?: string | null;
  workflow_inbox_item_id?: string | null;
  managed_executor_id?: string | null;
  status?: string | null;
  adapter: string;
  action: string;
  idempotency_key?: string | null;
  action_digest?: string | null;
  source_runtime_event_id?: string | null;
  payload?: Record<string, unknown> | null;
  provider_response?: Record<string, unknown> | null;
  error?: string | null;
  action_proposal?: {
    id?: string | null;
    node_key?: string | null;
    proposal_key?: string | null;
    adapter?: string | null;
    action?: string | null;
    idempotency_key?: string | null;
    proposal_digest?: string | null;
    payload?: Record<string, unknown> | null;
  } | null;
}

export interface WorkerStats {
  claimed: number;
  actionReplaysClaimed: number;
  actionReplaysCompleted: number;
  completed: number;
  blocked: number;
  failed: number;
}
