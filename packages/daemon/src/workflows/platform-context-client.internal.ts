import { createHash } from 'node:crypto';
import type { WorkflowRunRecord } from './types.js';
import type { PlatformContextSourcePolicy } from './platform-context-client.types.js';

export function runtimeContextTargetForRun(
  run: WorkflowRunRecord,
  resourceId?: string,
  runtimeTargetId?: string,
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
  if (resourceId && targetResourceId && targetResourceId !== resourceId) return null;
  if (runtimeTargetId && targetRuntimeId && targetRuntimeId !== runtimeTargetId) return null;
  const effectiveResourceId = resourceId ?? targetResourceId;
  const effectiveRuntimeTargetId = runtimeTargetId ?? targetRuntimeId;
  if (!effectiveResourceId || !effectiveRuntimeTargetId) return null;

  const tlsPins = Array.isArray(target['tlsPins'])
    ? target['tlsPins'].filter((value): value is string => typeof value === 'string')
    : undefined;

  return {
    baseUrl: serverUrl.replace(/\/+$/, ''),
    resourceId: effectiveResourceId,
    issueToken: credential,
    runtimeTargetId: effectiveRuntimeTargetId,
    tlsVerify: stringValue(target['tlsVerify']) as 'auto' | '0' | '1' | undefined,
    caCertPath: stringValue(target['caCertPath'] ?? target['ca_cert_path']),
    tlsPins,
  };
}

export function isPlatformContextSourcePolicy(
  value: unknown,
): value is PlatformContextSourcePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row['schema'] === 'viewport.context_source_policy/v1' &&
    typeof row['policy_receipt_id'] === 'string' &&
    typeof row['context_source_id'] === 'string' &&
    typeof row['external_ref'] === 'string'
  );
}

export async function readResponseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function jsonHeaders(): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
  };
}

export function describeUnexpectedResponse(body: unknown): string {
  const root = objectValue(body);
  if (!root) return 'body=null';
  const data = objectValue(root['data']);
  const parts = [
    `top_level_keys=${Object.keys(root).sort().join(',') || 'none'}`,
    `data_keys=${data ? Object.keys(data).sort().join(',') || 'none' : 'none'}`,
  ];

  const schema = data ? stringValue(data['schema']) : undefined;
  if (schema) parts.push(`data_schema=${schema}`);
  const message = stringValue(root['message']);
  if (message) parts.push(`message=${message.slice(0, 160)}`);
  const reason = stringValue(root['reason']);
  if (reason) parts.push(`reason=${reason.slice(0, 120)}`);

  return parts.join(' ');
}

export function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function safeCitationUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function agentSessionIdForRun(run: WorkflowRunRecord): string | null {
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

export function missingSessionMemoryPrerequisites(
  run: WorkflowRunRecord,
  target: unknown,
  agentSessionId: string | null,
): string[] {
  const missing: string[] = [];
  if (!target) missing.push('runtime_context_target');
  if (!run.platformRunId) missing.push('platform_run_id');
  if (!agentSessionId) missing.push('agent_session_id');
  return missing.length > 0 ? missing : ['unknown'];
}

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function pathValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}
