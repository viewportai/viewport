import type { WorkflowApprovalActor } from './types.js';

const APPROVAL_ACTOR_KEYS = ['id', 'name', 'email', 'source'] as const;

export function sanitizeWorkflowApprovalActor(actor: unknown): WorkflowApprovalActor | undefined {
  if (!actor || typeof actor !== 'object') return undefined;

  const record = actor as Record<string, unknown>;
  const sanitized: WorkflowApprovalActor = {};

  for (const key of APPROVAL_ACTOR_KEYS) {
    const value = record[key];
    if (!['string', 'number', 'boolean'].includes(typeof value)) continue;

    const normalized = String(value).trim();
    if (normalized === '') continue;
    if (key === 'email' && !looksLikeEmail(normalized)) continue;

    sanitized[key] = normalized;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function workflowApprovalActorPayload(
  actor: unknown,
): { actor: WorkflowApprovalActor } | Record<string, never> {
  const sanitized = sanitizeWorkflowApprovalActor(actor);
  return sanitized ? { actor: sanitized } : {};
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
