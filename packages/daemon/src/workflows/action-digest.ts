import { createHash } from 'node:crypto';
import type { WorkflowActionNode, WorkflowInputValue } from './types.js';

const SECRET_KEY_PATTERN = /(authorization|token|secret|password|api[_-]?key|private[_-]?key)/i;

export interface WorkflowActionProposalDigestInput {
  idempotencyKey?: string;
  input?: Record<string, WorkflowInputValue>;
}

export function workflowActionProposalDigest(
  node: WorkflowActionNode,
  options: WorkflowActionProposalDigestInput = {},
): string {
  return `sha256:${createHash('sha256')
    .update(
      stableJson({
        adapter: node.adapter,
        action: node.action,
        idempotencyKey: options.idempotencyKey ?? null,
        requiresApproval: node.requiresApproval === true,
        input: sanitizeActionInput(options.input ?? {}),
      }),
    )
    .digest('hex')}`;
}

export function sanitizeActionInput(
  value: WorkflowInputValue | Record<string, WorkflowInputValue>,
): WorkflowInputValue | Record<string, WorkflowInputValue> {
  if (Array.isArray(value)) return value.map((entry) => sanitizeActionInput(entry));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? '[redacted]' : sanitizeActionInput(entry),
    ]),
  );
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
