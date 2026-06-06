import { createHash } from 'node:crypto';
import type { ConfigManager } from '../core/config.js';
import { transportFetch } from '../cli/network.js';
import { resolveConfiguredWorkspaceSyncTarget } from '../cli/context-sync-target.js';
import type { ContextProviderResult } from '../context-providers/types.js';
import type { WorkflowRunRecord } from './types.js';

type Fetcher = typeof transportFetch;

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

export class WorkflowPlatformContextClient {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly fetcher: Fetcher = transportFetch,
  ) {}

  async resolveNodePolicy(input: {
    run: WorkflowRunRecord;
    nodeId: string;
    query: string;
    maxSnippets?: number | null;
  }): Promise<PlatformContextResolution | null> {
    const target = this.targetFor(input.run, 'context/resolve', input.nodeId);
    if (!target) return null;

    const res = await this.fetcher(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credential: target.issueToken,
        runtime_target_id: target.runtimeTargetId,
        query: input.query,
        mode: 'pre_node',
        ...(input.maxSnippets ? { max_snippets: input.maxSnippets } : {}),
      }),
      timeoutMs: 5_000,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    });

    if (!res.ok) {
      throw new Error(`workflow context policy resolve failed: HTTP ${res.status}`);
    }

    const body = (await readResponseJson(res)) as Partial<PlatformContextResolution> | null;
    if (!body || body.schema !== 'viewport.node_context_resolution/v1') return null;

    return {
      schema: body.schema,
      node_id: String(body.node_id ?? input.nodeId),
      query: String(body.query ?? input.query),
      source_policies: Array.isArray(body.source_policies)
        ? body.source_policies.filter(isPlatformContextSourcePolicy)
        : [],
      warnings: Array.isArray(body.warnings) ? body.warnings : [],
    };
  }

  async reportCustomerManagedReceipt(input: {
    run: WorkflowRunRecord;
    nodeId: string;
    policy: PlatformContextSourcePolicy;
    query: string;
    items: ContextProviderResult[];
  }): Promise<void> {
    const target = this.targetFor(input.run, 'context/receipts', input.nodeId);
    if (!target) return;

    const selectedAt = new Date().toISOString();
    const res = await this.fetcher(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credential: target.issueToken,
        runtime_target_id: target.runtimeTargetId,
        context_source_id: input.policy.context_source_id,
        policy_receipt_id: input.policy.policy_receipt_id,
        query_digest: digest(input.query),
        snippet_count: input.items.length,
        citations: input.items.map((item) => ({
          citation_id: item.id,
          source_ref: input.policy.external_ref,
          citation_url: safeCitationUrl(input.policy.source_url),
          content_digest: item.digest ?? digest(item.body),
          snippet_digest: digest(item.body),
          retrieval_query_digest: digest(input.query),
          selected_at: selectedAt,
          node_id: input.nodeId,
        })),
      }),
      timeoutMs: 5_000,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    });

    if (!res.ok) {
      throw new Error(`workflow context receipt report failed: HTTP ${res.status}`);
    }
  }

  async reportContextWritebackReceipt(input: {
    run: WorkflowRunRecord;
    proposalId: string;
    status: 'succeeded' | 'failed';
    providerReference?: string | null;
    providerUrl?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    const target = this.workspaceTargetFor(input.run);
    if (!target) return;

    const res = await this.fetcher(
      `${target.baseUrl}/api/runtime/workspaces/${encodeURIComponent(target.resourceId)}/context-update-proposals/${encodeURIComponent(input.proposalId)}/writeback-receipt`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          credential: target.issueToken,
          runtime_target_id: target.runtimeTargetId,
          status: input.status,
          ...(input.providerReference ? { provider_reference: input.providerReference } : {}),
          ...(input.providerUrl ? { provider_url: input.providerUrl } : {}),
          payload: input.payload ?? {},
        }),
        timeoutMs: 5_000,
        tlsVerify: target.tlsVerify,
        caCertPath: target.caCertPath,
        tlsPins: target.tlsPins,
      },
    );

    if (!res.ok) {
      throw new Error(`workflow context writeback receipt report failed: HTTP ${res.status}`);
    }
  }

  async proposeContextUpdate(input: {
    run: WorkflowRunRecord;
    nodeId: string;
    targetRef: string;
    title: string;
    summary?: string | null;
    patch?: Record<string, unknown>;
    idempotencyKey?: string | null;
  }): Promise<{ proposalId?: string; status?: string; inboxItemId?: string } | null> {
    const target = this.targetFor(input.run, 'context/proposals', input.nodeId);
    if (!target) return null;

    const res = await this.fetcher(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credential: target.issueToken,
        runtime_target_id: target.runtimeTargetId,
        target_ref: input.targetRef,
        title: input.title,
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.patch ? { patch: input.patch } : {}),
        ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
      }),
      timeoutMs: 5_000,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    });

    if (!res.ok) {
      throw new Error(`workflow context update proposal failed: HTTP ${res.status}`);
    }

    const body = (await readResponseJson(res)) as { data?: Record<string, unknown> } | null;
    const data = body?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const inbox = data['inbox_item'];
    return {
      proposalId: stringValue(data['id']),
      status: stringValue(data['status']),
      inboxItemId:
        inbox && typeof inbox === 'object' && !Array.isArray(inbox)
          ? stringValue((inbox as Record<string, unknown>)['id'])
          : undefined,
    };
  }

  async retrieveSessionMemory(input: {
    run: WorkflowRunRecord;
    query: string;
    limit?: number | null;
    contextSourceIds?: string[] | null;
  }): Promise<PlatformSessionMemoryRetrieval | null> {
    const target = this.workspaceTargetFor(input.run);
    const agentSessionId = agentSessionIdForRun(input.run);
    if (!target || !input.run.platformRunId || !agentSessionId) return null;

    const res = await this.fetcher(
      `${target.baseUrl}/api/runtime/workspaces/${encodeURIComponent(target.resourceId)}/workflow-runs/${encodeURIComponent(input.run.platformRunId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/memory-retrieval`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          credential: target.issueToken,
          runtime_target_id: target.runtimeTargetId,
          query: input.query,
          ...(input.limit ? { limit: input.limit } : {}),
          ...(input.contextSourceIds ? { context_source_ids: input.contextSourceIds } : {}),
        }),
        timeoutMs: 5_000,
        tlsVerify: target.tlsVerify,
        caCertPath: target.caCertPath,
        tlsPins: target.tlsPins,
      },
    );

    if (!res.ok) {
      throw new Error(`session memory retrieval failed: HTTP ${res.status}`);
    }

    const body = (await readResponseJson(res)) as {
      data?: Partial<PlatformSessionMemoryRetrieval>;
    } | null;
    const data = body?.data;
    if (!data || data.schema !== 'viewport.agent_session_memory_retrieval/v1') return null;

    return {
      schema: data.schema,
      receipt: objectValue(data.receipt),
      retrieval: objectValue(data.retrieval),
    };
  }

  async retrieveSessionMailbox(input: {
    run: WorkflowRunRecord;
    agentId: string;
  }): Promise<PlatformSessionCollaborationMailboxRetrieval | null> {
    const target = this.workspaceTargetFor(input.run);
    const agentSessionId = agentSessionIdForRun(input.run);
    if (!target || !input.run.platformRunId || !agentSessionId) return null;

    const res = await this.fetcher(
      `${target.baseUrl}/api/runtime/workspaces/${encodeURIComponent(target.resourceId)}/workflow-runs/${encodeURIComponent(input.run.platformRunId)}/agent-sessions/${encodeURIComponent(agentSessionId)}/collaboration-mailbox`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          credential: target.issueToken,
          runtime_target_id: target.runtimeTargetId,
          recipient_actor_type: 'agent',
          recipient_actor_id: input.agentId,
        }),
        timeoutMs: 5_000,
        tlsVerify: target.tlsVerify,
        caCertPath: target.caCertPath,
        tlsPins: target.tlsPins,
      },
    );

    if (!res.ok) {
      throw new Error(`session collaboration mailbox retrieval failed: HTTP ${res.status}`);
    }

    const body = (await readResponseJson(res)) as {
      data?: Partial<PlatformSessionCollaborationMailboxRetrieval>;
    } | null;
    const data = body?.data;
    if (!data || data.schema !== 'viewport.agent_session_collaboration_mailbox_retrieval/v1') {
      return null;
    }

    return {
      schema: data.schema,
      agent_session_id: stringValue(data.agent_session_id),
      workflow_run_id: stringValue(data.workflow_run_id),
      recipient: objectValue(data.recipient),
      mailboxes: Array.isArray(data.mailboxes)
        ? data.mailboxes.filter(
            (mailbox): mailbox is Record<string, unknown> =>
              !!mailbox && typeof mailbox === 'object' && !Array.isArray(mailbox),
          )
        : [],
      source: objectValue(data.source),
      redaction: objectValue(data.redaction),
    };
  }

  private targetFor(
    run: WorkflowRunRecord,
    action: 'context/resolve' | 'context/receipts' | 'context/proposals',
    nodeId: string,
  ): {
    url: string;
    issueToken: string;
    runtimeTargetId: string;
    tlsVerify?: 'auto' | '0' | '1';
    caCertPath?: string;
    tlsPins?: string[];
  } | null {
    const resourceId = run.resourceId;
    const runtimeTargetId = run.runtimeTargetId;
    if (!resourceId || !runtimeTargetId || !run.platformRunId) return null;

    const daemonConfig = this.configManager.getDaemonConfig();
    if (!daemonConfig) return null;
    const target = resolveConfiguredWorkspaceSyncTarget(daemonConfig, {
      requestedWorkspaceId: resourceId,
    });
    if (!target) return null;
    if (target.runtimeTargetId && target.runtimeTargetId !== runtimeTargetId) {
      return null;
    }

    return {
      url: `${target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(resourceId)}/workflow-runs/${encodeURIComponent(run.platformRunId)}/nodes/${encodeURIComponent(nodeId)}/${action}`,
      issueToken: target.credential,
      runtimeTargetId,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    };
  }

  private workspaceTargetFor(run: WorkflowRunRecord): {
    baseUrl: string;
    resourceId: string;
    issueToken: string;
    runtimeTargetId: string;
    tlsVerify?: 'auto' | '0' | '1';
    caCertPath?: string;
    tlsPins?: string[];
  } | null {
    const resourceId = run.resourceId;
    const runtimeTargetId = run.runtimeTargetId;
    if (!resourceId || !runtimeTargetId) return null;

    const runScopedTarget = runtimeContextTargetForRun(run, resourceId, runtimeTargetId);
    if (runScopedTarget) return runScopedTarget;

    const daemonConfig = this.configManager.getDaemonConfig();
    const target = daemonConfig
      ? resolveConfiguredWorkspaceSyncTarget(daemonConfig, {
          requestedWorkspaceId: resourceId,
        })
      : null;
    if (target) {
      if (target.runtimeTargetId && target.runtimeTargetId !== runtimeTargetId) {
        return null;
      }

      return {
        baseUrl: target.serverUrl.replace(/\/+$/, ''),
        resourceId,
        issueToken: target.credential,
        runtimeTargetId,
        tlsVerify: target.tlsVerify,
        caCertPath: target.caCertPath,
        tlsPins: target.tlsPins,
      };
    }

    return null;
  }
}

function runtimeContextTargetForRun(
  run: WorkflowRunRecord,
  resourceId: string,
  runtimeTargetId: string,
): {
  baseUrl: string;
  resourceId: string;
  issueToken: string;
  runtimeTargetId: string;
  tlsVerify?: 'auto' | '0' | '1';
  caCertPath?: string;
  tlsPins?: string[];
} | null {
  const target = objectValue(pathValue(run.inputs, ['viewport', 'runtimeContextTarget']));
  if (!target) return null;

  const targetResourceId = stringValue(target['workspaceId'] ?? target['workspace_id']);
  const targetRuntimeId = stringValue(target['runtimeTargetId'] ?? target['runtime_target_id']);
  const serverUrl = stringValue(target['serverUrl'] ?? target['server_url']);
  const credential = stringValue(target['credential']);
  if (!serverUrl || !credential) return null;
  if (targetResourceId && targetResourceId !== resourceId) return null;
  if (targetRuntimeId && targetRuntimeId !== runtimeTargetId) return null;

  const tlsPins = Array.isArray(target['tlsPins'])
    ? target['tlsPins'].filter((value): value is string => typeof value === 'string')
    : undefined;

  return {
    baseUrl: serverUrl.replace(/\/+$/, ''),
    resourceId,
    issueToken: credential,
    runtimeTargetId,
    tlsVerify: stringValue(target['tlsVerify']) as 'auto' | '0' | '1' | undefined,
    caCertPath: stringValue(target['caCertPath'] ?? target['ca_cert_path']),
    tlsPins,
  };
}

function isPlatformContextSourcePolicy(value: unknown): value is PlatformContextSourcePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row['schema'] === 'viewport.context_source_policy/v1' &&
    typeof row['policy_receipt_id'] === 'string' &&
    typeof row['context_source_id'] === 'string' &&
    typeof row['external_ref'] === 'string'
  );
}

async function readResponseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function safeCitationUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function agentSessionIdForRun(run: WorkflowRunRecord): string | null {
  return (
    stringValue(run.agentSessionId) ??
    stringValue(pathValue(run, ['agent_session_id'])) ??
    stringValue(
      pathValue(run.inputs, ['viewport', 'workflow', 'product20_policy_pin', 'agent_session_id']),
    ) ??
    stringValue(pathValue(run.inputs, ['viewport', 'agentSessionId'])) ??
    null
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pathValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}
