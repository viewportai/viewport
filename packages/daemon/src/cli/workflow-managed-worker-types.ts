import type { WorkflowInputValue } from '../workflows/types.js';

export interface ManagedWorkerOptions {
  server: string;
  workspaceId: string;
  executorId: string;
  credential: string;
  accessMode: ManagedWorkerAccessMode;
  runnerProfile?: string;
  workdir?: string;
  leaseSeconds: number;
  sleepSeconds: number;
  maxRuns?: number;
  once: boolean;
  capabilities: ManagedWorkerCapabilities;
}

export type ManagedWorkerAccessMode = 'relay' | 'polling' | 'direct';

export interface ManagedWorkerCapabilities {
  agentCommand?: string;
  agents: string[];
  models: string[];
  integrations: string[];
  secrets: string[];
}

export interface ManagedAssignment {
  id: string;
  assignment_claim_token?: string | null;
  schema_versions?: Record<string, unknown> | null;
  route_snapshot?: Record<string, unknown> | null;
  execution_profile_snapshot?: Record<string, unknown> | null;
  workflow_snapshot?: Record<string, unknown> | null;
  runner_workspace_snapshot?: Record<string, unknown> | null;
  context_receipts_snapshot?: unknown[] | Record<string, unknown> | null;
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

export interface DirectoryInfo {
  id: string;
  path: string;
}

export interface WorkerStats {
  claimed: number;
  completed: number;
  blocked: number;
  failed: number;
}
