import { sanitizeActionInput } from './action-digest.js';
import {
  approvalDecision,
  arrayValue,
  excerpt,
  iso,
  numberValue,
  payloadDigest,
  proposalKey,
  readString,
  recordValue,
  sanitizeSyncPayload,
  stringValue,
} from './platform-sync-format.js';
import type {
  WorkflowInputValue,
  WorkflowNodeRunState,
  WorkflowRunArtifactRecord,
  WorkflowRunEvent,
  WorkflowRunRecord,
} from './types.js';

type UsageCostSource =
  | 'customer_byok'
  | 'viewport_key'
  | 'runner_local'
  | 'runtime'
  | 'storage'
  | 'egress'
  | 'provider_action'
  | 'unknown';

export interface WorkflowRunSyncPayloadOptions {
  events?: WorkflowRunEvent[];
  enforceDataCapturePolicy?: boolean;
  includeApprovalDecisions?: boolean;
}

export function workflowRunToSyncPayload(
  run: WorkflowRunRecord,
  options: WorkflowRunSyncPayloadOptions = {},
): Record<string, unknown> {
  const policy = dataCapturePolicy(run);
  const enforcePolicy = options.enforceDataCapturePolicy === true;
  const events = options.events ?? run.events;
  const usage = aggregateRunUsage(run);

  return {
    runtime_run_id: run.id,
    status: run.status,
    data_capture_policy: policy,
    ...(usage ? { usage } : {}),
    output_snapshot: formatRunOutputSnapshot(run, enforcePolicy, usage ?? undefined),
    error_summary: run.error ?? null,
    started_at: iso(run.startedAt),
    completed_at: iso(run.completedAt),
    nodes: Object.values(run.nodes).map((node) => formatNode(node, policy, enforcePolicy)),
    artifacts: run.artifacts.map((artifact) => formatArtifact(artifact, policy, enforcePolicy)),
    events: events.map((event) =>
      formatEvent(
        event,
        policy,
        enforcePolicy,
        event.nodeId ? run.nodes[event.nodeId]?.type : undefined,
      ),
    ),
    evidence_packets: Object.values(run.nodes).flatMap(formatEvidencePacket),
    action_proposals: Object.values(run.nodes).flatMap(formatActionProposal),
    approval_decisions:
      options.includeApprovalDecisions === false
        ? []
        : Object.values(run.nodes).flatMap(formatApprovalDecision),
    execution_receipts: run.events.flatMap(formatExecutionReceipt),
    audit_receipts: run.events.flatMap(formatAuditReceipt),
    ...(run.contextReceipts ? { context_receipts_snapshot: run.contextReceipts } : {}),
  };
}

export function dataCapturePolicy(run: WorkflowRunRecord) {
  return (
    run.dataCapturePolicy ?? {
      transcripts: 'none',
      logs: 'metadata',
      artifacts: 'metadata',
    }
  );
}

function formatNode(
  node: WorkflowNodeRunState,
  policy: ReturnType<typeof dataCapturePolicy>,
  enforcePolicy: boolean,
): Record<string, unknown> {
  const contextNode = enforcePolicy && node.type === 'context';
  const usage = normalizeUsageLedger(node.metadata?.['usage']);

  return {
    node_key: node.id,
    title: node.title ?? node.id,
    type: node.type,
    status: node.status,
    session_id: node.sessionId ?? null,
    worktree_path: enforcePolicy ? null : (node.worktreePath ?? null),
    output: contextNode
      ? 'Context node output redacted by workflow data capture policy.'
      : (node.output ?? null),
    output_snapshot: contextNode ? redactedContextOutputSnapshot(node) : (node.outputs ?? null),
    transcript_excerpt:
      enforcePolicy && policy.transcripts === 'none' ? null : (node.transcriptExcerpt ?? null),
    error: node.error ?? null,
    ...(usage ? { usage } : {}),
    started_at: iso(node.startedAt),
    completed_at: iso(node.completedAt),
    metadata: formatNodeMetadata(node, contextNode, usage),
  };
}

function formatNodeMetadata(
  node: WorkflowNodeRunState,
  redactedContextNode: boolean,
  usage: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    ...(redactedContextNode ? { context: { redacted: true } } : (node.metadata ?? {})),
    ...(usage ? { usage } : {}),
    approval: node.approval ?? null,
    inlineAgents: node.inlineAgents ?? null,
    nativeSessionId: node.nativeSessionId ?? null,
    exitCode: node.exitCode ?? null,
    skipReason: node.skipReason ?? null,
  };
}

function formatArtifact(
  artifact: WorkflowRunArtifactRecord,
  policy: ReturnType<typeof dataCapturePolicy>,
  enforcePolicy: boolean,
): Record<string, unknown> {
  return {
    node_key: artifact.nodeId,
    name: artifact.name,
    kind: artifact.kind ?? null,
    path: enforcePolicy && policy.artifacts !== 'local_reference' ? artifact.name : artifact.path,
    uri: null,
    mime_type: null,
    digest: artifact.digest ?? readString(artifact.metadata?.['digest']),
    metadata: {
      ...(artifact.metadata ?? {}),
      description: artifact.description ?? null,
      sizeBytes: artifact.sizeBytes ?? null,
    },
  };
}

function formatEvent(
  event: WorkflowRunEvent,
  policy: ReturnType<typeof dataCapturePolicy>,
  enforcePolicy: boolean,
  nodeType?: string,
): Record<string, unknown> {
  const redactedLog = enforcePolicy && event.type === 'node-log' && policy.logs === 'metadata';
  const redactedContextOutput =
    enforcePolicy && nodeType === 'context' && event.type === 'node-output';

  return {
    runtime_event_id: event.id,
    node_key: event.nodeId ?? null,
    type: event.type,
    severity: eventSeverity(event),
    message: redactedContextOutput
      ? 'Context node output metadata redacted by workflow data capture policy.'
      : redactedLog
        ? 'Node log content redacted by workflow data capture policy.'
        : event.message,
    payload: redactedContextOutput
      ? redactedContextEventPayload(event)
      : redactedLog
        ? redactedLogPayload(event)
        : (event.data ?? null),
    occurred_at: iso(event.timestamp),
  };
}

function formatActionProposal(node: WorkflowNodeRunState): Array<Record<string, unknown>> {
  const action = recordValue(node.metadata?.['action']);
  if (!action) return [];
  const adapter = stringValue(action['adapter']);
  const actionName = stringValue(action['action']);
  if (!adapter || !actionName) return [];
  const key = proposalKey(node.id, action['proposalKey']);

  return [
    {
      proposal_key: key,
      node_key: node.id,
      adapter,
      action: actionName,
      state: stringValue(action['status']) ?? 'proposed',
      idempotency_key: stringValue(action['idempotencyKey']),
      proposal_digest: stringValue(action['digest']),
      evidence_refs: arrayValue(action['evidenceRefs']),
      policy_evaluation: recordValue(action['policyReason'])
        ? { reason: action['policyReason'] }
        : stringValue(action['policyReason'])
          ? { reason: action['policyReason'] }
          : null,
      payload: recordValue(action['input'])
        ? sanitizeActionInput(action['input'] as Record<string, WorkflowInputValue>)
        : null,
      proposed_at: iso(node.startedAt ?? node.completedAt),
      expires_at: null,
    },
  ];
}

function formatEvidencePacket(node: WorkflowNodeRunState): Array<Record<string, unknown>> {
  if (node.type === 'context') return [];
  if (node.status !== 'completed') return [];
  const output = typeof node.output === 'string' ? node.output.trim() : '';
  if (!output) return [];

  const payload = {
    nodeId: node.id,
    nodeType: node.type,
    outputExcerpt: excerpt(output),
    outputs: node.outputs ?? null,
    exitCode: node.exitCode ?? null,
  };

  return [
    {
      evidence_key: `node:${node.id}:output`,
      node_key: node.id,
      kind: node.type === 'shell' ? 'command_output' : 'node_output',
      title: node.title ?? node.id,
      summary: excerpt(output),
      confidence: 'observed',
      visibility: 'team',
      digest: payloadDigest(payload),
      payload,
      occurred_at: iso(node.completedAt ?? node.startedAt),
    },
  ];
}

function formatRunOutputSnapshot(
  run: WorkflowRunRecord,
  enforcePolicy: boolean,
  usage?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    inputs: run.inputs,
    ...(usage ? { usage } : {}),
    nodes: Object.fromEntries(
      Object.entries(run.nodes).map(([key, node]) => [
        key,
        {
          status: node.status,
          output:
            enforcePolicy && node.type === 'context'
              ? 'Context node output redacted by workflow data capture policy.'
              : node.output,
          outputs:
            enforcePolicy && node.type === 'context'
              ? redactedContextOutputSnapshot(node)
              : (node.outputs ?? null),
        },
      ]),
    ),
  };
}

function aggregateRunUsage(run: WorkflowRunRecord): Record<string, unknown> | null {
  const ledgers = Object.values(run.nodes)
    .map((node) => normalizeUsageLedger(node.metadata?.['usage']))
    .filter((usage): usage is Record<string, unknown> => Boolean(usage));
  if (ledgers.length === 0) return null;

  const available = ledgers.filter((usage) => usage['available'] === true);
  if (available.length === 0) {
    return {
      schema: 'viewport.usage_ledger/v1',
      available: false,
      reason: firstString(ledgers.map((usage) => usage['reason'])) ?? 'adapter_no_usage',
      cost_source: 'unknown',
      billable_to_workspace: false,
      estimated: false,
      node_count: ledgers.length,
    };
  }

  const inputTokens = sumNumbers(available.map((usage) => usage['input_tokens']));
  const rawProviderInput = available.some((usage) => usage['input_token_scope'] === 'raw_provider');
  const outputTokens = sumNumbers(available.map((usage) => usage['output_tokens']));
  const billableInputTokens = sumNumbers(available.map((usage) => usage['billable_input_tokens']));
  const budgetedTotalTokens = sumNumbers(available.map((usage) => usage['budgeted_total_tokens']));
  const costUsd = sumNumbers(available.map((usage) => usage['cost_usd']));
  return {
    schema: 'viewport.usage_ledger/v1',
    available: true,
    input_tokens: inputTokens,
    input_token_scope: rawProviderInput ? 'raw_provider' : 'billable',
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    billable_input_tokens: billableInputTokens,
    budgeted_total_tokens: budgetedTotalTokens,
    cost_usd: roundCost(costUsd),
    total_cost_usd: roundCost(costUsd),
    llm_cost_usd: roundCost(costUsd),
    runtime_cost_usd: 0,
    storage_cost_usd: 0,
    egress_cost_usd: 0,
    provider_action_cost_usd: 0,
    cost_source: mergedCostSource(available),
    billable_to_workspace: false,
    estimated: false,
    node_count: available.length,
    unavailable_node_count: ledgers.length - available.length,
  };
}

function normalizeUsageLedger(value: unknown): Record<string, unknown> | null {
  const usage = recordValue(value);
  if (!usage) return null;
  const available = usage['available'] === true;
  if (!available) {
    return {
      schema: 'viewport.usage_ledger/v1',
      available: false,
      reason: stringValue(usage['reason']) ?? 'adapter_no_usage',
      cost_source: 'unknown',
      billable_to_workspace: false,
      estimated: usage['estimated'] === true,
    };
  }

  const inputTokens = numberValue(usage['input_tokens']) ?? numberValue(usage['inputTokens']) ?? 0;
  const inputTokenScope =
    stringValue(usage['input_token_scope']) ?? stringValue(usage['inputTokenScope']);
  const outputTokens =
    numberValue(usage['output_tokens']) ?? numberValue(usage['outputTokens']) ?? 0;
  const totalTokens =
    numberValue(usage['total_tokens']) ??
    numberValue(usage['totalTokens']) ??
    inputTokens + outputTokens;
  const cacheReadInputTokens =
    numberValue(usage['cache_read_input_tokens']) ?? numberValue(usage['cacheReadInputTokens']);
  const cacheCreationInputTokens =
    numberValue(usage['cache_creation_input_tokens']) ??
    numberValue(usage['cacheCreationInputTokens']);
  const billableInputTokens =
    numberValue(usage['billable_input_tokens']) ??
    numberValue(usage['billableInputTokens']) ??
    (inputTokenScope === 'raw_provider'
      ? 0
      : Math.max(0, inputTokens - (cacheReadInputTokens ?? 0)));
  const budgetedTotalTokens =
    numberValue(usage['budgeted_total_tokens']) ??
    numberValue(usage['budgetedTotalTokens']) ??
    billableInputTokens + outputTokens;
  const costUsd =
    numberValue(usage['cost_usd']) ??
    numberValue(usage['costUsd']) ??
    numberValue(usage['total_cost_usd']) ??
    numberValue(usage['totalCostUsd']) ??
    0;

  return {
    schema: 'viewport.usage_ledger/v1',
    available: true,
    input_tokens: inputTokens,
    input_token_scope: inputTokenScope === 'raw_provider' ? 'raw_provider' : 'billable',
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cache_read_input_tokens: cacheReadInputTokens ?? 0,
    cache_creation_input_tokens: cacheCreationInputTokens ?? 0,
    billable_input_tokens: billableInputTokens,
    budgeted_total_tokens: budgetedTotalTokens,
    cost_usd: roundCost(costUsd),
    total_cost_usd: roundCost(costUsd),
    llm_cost_usd: roundCost(costUsd),
    runtime_cost_usd: 0,
    storage_cost_usd: 0,
    egress_cost_usd: 0,
    provider_action_cost_usd: 0,
    cost_source: usageCostSource(usage['cost_source']) ?? 'runner_local',
    billable_to_workspace: usage['billable_to_workspace'] === true,
    estimated: usage['estimated'] === true,
    ...(usage['modelUsage'] ? { model_usage: usage['modelUsage'] } : {}),
    ...(usage['durationMs'] ? { duration_ms: usage['durationMs'] } : {}),
    ...(usage['numTurns'] ? { num_turns: usage['numTurns'] } : {}),
  };
}

function usageCostSource(value: unknown): UsageCostSource | null {
  if (typeof value !== 'string') return null;
  const allowed: UsageCostSource[] = [
    'customer_byok',
    'viewport_key',
    'runner_local',
    'runtime',
    'storage',
    'egress',
    'provider_action',
    'unknown',
  ];
  return allowed.includes(value as UsageCostSource) ? (value as UsageCostSource) : null;
}

function mergedCostSource(usage: Array<Record<string, unknown>>): UsageCostSource {
  const sources = new Set(usage.map((entry) => usageCostSource(entry['cost_source']) ?? 'unknown'));
  return sources.size === 1 ? ([...sources][0] ?? 'unknown') : 'unknown';
}

function sumNumbers(values: unknown[]): number {
  return values.reduce<number>((sum, value) => sum + (numberValue(value) ?? 0), 0);
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function redactedContextOutputSnapshot(node: WorkflowNodeRunState): Record<string, unknown> {
  const itemCount = numberValue(node.outputs?.['itemCount']);
  return {
    redacted: true,
    itemCount: itemCount ?? null,
  };
}

function redactedContextEventPayload(event: WorkflowRunEvent): Record<string, unknown> {
  const payload = recordValue(event.data);
  return {
    redacted: true,
    providerCount: numberValue(payload?.['providerCount']) ?? null,
    itemCount: numberValue(payload?.['itemCount']) ?? null,
  };
}

function formatApprovalDecision(node: WorkflowNodeRunState): Array<Record<string, unknown>> {
  if (!node.approval?.resolvedAt) return [];
  const action = recordValue(node.metadata?.['action']);
  const actionDigest = stringValue(action?.['digest']);
  const key = action ? proposalKey(node.id, action['proposalKey']) : null;

  return [
    {
      decision_key: `approval:${node.id}:${node.approval.resolvedAt}`,
      proposal_key: key,
      node_key: node.id,
      actor_user_id: null,
      subject_type: action ? 'action_proposal' : 'workflow_node',
      subject_id: node.id,
      subject_digest: actionDigest,
      decision: approvalDecision(
        node.approval.decision ?? (node.approval.approved ? 'approve' : 'reject'),
      ),
      reason: node.approval.message ?? null,
      actor_snapshot: node.approval.actor ?? null,
      payload: {
        approved: node.approval.approved,
        feedback: node.approval.feedback ?? null,
        ...(node.approval.executionGrant ? { execution_grant: node.approval.executionGrant } : {}),
      },
      decided_at: iso(node.approval.resolvedAt),
    },
  ];
}

function formatExecutionReceipt(event: WorkflowRunEvent): Array<Record<string, unknown>> {
  if (
    ![
      'action-executed',
      'action-failed',
      'action-dead-letter',
      'action-duplicate-suppressed',
    ].includes(event.type)
  ) {
    return [];
  }
  const action = recordValue(event.data?.['action']);
  const adapter = stringValue(action?.['adapter']);
  const actionName = stringValue(action?.['action']);
  const providerResponse = recordValue(action?.['response']);
  const receiptProviderResponse = compactProviderResponse(providerResponse);
  const executionGrant =
    recordValue(action?.['execution_grant']) ?? recordValue(action?.['executionGrant']);
  if (!action || !adapter || !actionName) return [];
  const receiptPayload = executionReceiptPayload(action, receiptProviderResponse);

  return [
    {
      receipt_key: `execution:${event.id}`,
      proposal_key: event.nodeId ? proposalKey(event.nodeId, action?.['proposalKey']) : null,
      approval_decision_key: stringValue(executionGrant?.['approval_decision_key']),
      adapter,
      action: actionName,
      status:
        event.type === 'action-executed'
          ? 'executed'
          : event.type === 'action-failed'
            ? 'failed'
            : event.type === 'action-dead-letter'
              ? 'dead_letter'
              : 'duplicate_suppressed',
      provider_reference:
        stringValue(providerResponse?.['number']) ??
        stringValue(providerResponse?.['ts']) ??
        stringValue(providerResponse?.['id']),
      provider_url:
        stringValue(providerResponse?.['htmlUrl']) ?? stringValue(providerResponse?.['apiUrl']),
      idempotency_key: stringValue(action?.['idempotencyKey']),
      payload_digest: stringValue(action?.['digest']) ?? payloadDigest(action),
      provider_response_digest: receiptProviderResponse
        ? payloadDigest(receiptProviderResponse)
        : null,
      payload: receiptPayload,
      provider_reconciliation:
        recordValue(action?.['provider_reconciliation']) ??
        recordValue(action?.['providerReconciliation']),
      executed_at: iso(event.timestamp),
    },
  ];
}

function compactProviderResponse(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const response = recordValue(sanitizeSyncPayload(value));
  if (!response) return null;

  const compact: Record<string, unknown> = {};
  for (const key of [
    'status',
    'ok',
    'htmlUrl',
    'apiUrl',
    'number',
    'channel',
    'ts',
    'id',
    'error',
  ]) {
    if (Object.prototype.hasOwnProperty.call(response, key)) {
      compact[key] = response[key];
    }
  }

  return Object.keys(compact).length > 0 ? compact : response;
}

function executionReceiptPayload(
  action: Record<string, unknown>,
  providerResponse: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const payload = recordValue(sanitizeSyncPayload(action));
  if (!payload || !providerResponse) return payload;

  return {
    ...payload,
    response: providerResponse,
    provider_response: providerResponse,
  };
}

function formatAuditReceipt(event: WorkflowRunEvent): Array<Record<string, unknown>> {
  if (
    ![
      'approval-requested',
      'approval-resolved',
      'action-executed',
      'action-failed',
      'action-dead-letter',
      'action-duplicate-suppressed',
    ].includes(event.type)
  ) {
    return [];
  }
  const payload = sanitizeSyncPayload(event.data);

  return [
    {
      receipt_key: `audit:${event.id}`,
      event_type: event.type,
      actor_type: event.type.startsWith('approval') ? 'human_or_platform' : 'runner',
      actor_id: null,
      payload_digest: payloadDigest(payload),
      payload,
      occurred_at: iso(event.timestamp),
    },
  ];
}

function redactedLogPayload(event: WorkflowRunEvent): Record<string, unknown> {
  return {
    source: readString(event.data?.['source']) ?? undefined,
    stream: readString(event.data?.['stream']) ?? undefined,
    redacted: true,
    reason: 'workflow_data_capture_policy',
  };
}

function eventSeverity(event: WorkflowRunEvent): 'debug' | 'info' | 'warning' | 'error' {
  if (event.type.includes('failed')) return 'error';
  if (event.type.includes('warning')) return 'warning';
  return 'info';
}
