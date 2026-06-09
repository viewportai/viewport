export interface PlatformContextSourcePolicy {
  schema: 'viewport.context_source_policy/v1';
  policy_receipt_id: string;
  node_id: string;
  context_source_id: string;
  context_source_name: string;
  provider_type: string;
  external_ref: string;
  source_url?: string | null;
  execution_mode: 'customer_managed_context_worker' | string;
  content_storage: 'none_metadata_only' | string;
  query: string;
  max_snippets?: number | null;
  scope_config?: Record<string, unknown> | null;
  receipt_requirements?: {
    plaintext_snippets_required?: boolean;
    required_fields?: string[];
  };
}

export interface PlatformContextResolution {
  schema: 'viewport.node_context_resolution/v1';
  node_id: string;
  query: string;
  source_policies: PlatformContextSourcePolicy[];
  warnings?: Array<Record<string, unknown>>;
}

export interface PlatformSessionMemoryRetrieval {
  schema: 'viewport.agent_session_memory_retrieval/v1';
  receipt?: Record<string, unknown> | null;
  retrieval?: Record<string, unknown> | null;
}

export interface PlatformSessionCollaborationMailboxRetrieval {
  schema: 'viewport.agent_session_collaboration_mailbox_retrieval/v1';
  agent_session_id?: string;
  workflow_run_id?: string;
  recipient?: Record<string, unknown> | null;
  mailboxes?: Array<Record<string, unknown>>;
  source?: Record<string, unknown> | null;
  redaction?: Record<string, unknown> | null;
}
