import { createHash } from 'node:crypto';
import { sanitizeActionInput } from './action-digest.js';
import type { WorkflowInputValue } from './types.js';

export function iso(value: number | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function proposalKey(nodeId: string): string {
  return `action:${nodeId}`;
}

export function approvalDecision(decision: string): 'approve' | 'deny' | 'request_changes' {
  if (decision === 'approve' || decision === 'request_changes') return decision;
  return 'deny';
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function stringValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function excerpt(value: string): string {
  return value.length <= 1_000 ? value : `${value.slice(0, 1_000)}...`;
}

export function sanitizeSyncPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value ?? null;
  return sanitizeActionInput(value as WorkflowInputValue | Record<string, WorkflowInputValue>);
}

export function payloadDigest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(stableJson(value ?? null))
    .digest('hex')}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortKeys(entry));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortKeys(entry)]),
  );
}
