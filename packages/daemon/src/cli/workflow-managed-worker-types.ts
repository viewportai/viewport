import type { WorkflowInputValue } from '../workflows/types.js';

export interface ManagedWorkerOptions {
  server: string;
  workspaceId: string;
  executorId: string;
  credential: string;
  workdir?: string;
  leaseSeconds: number;
  sleepSeconds: number;
  maxRuns?: number;
  once: boolean;
  capabilities: ManagedWorkerCapabilities;
}

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
  yaml_snapshot?: string | null;
  source_ref?: string | null;
  directory_path?: string | null;
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
