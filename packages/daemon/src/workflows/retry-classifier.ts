import type { WorkflowRetryPolicy } from './types.js';

/**
 * Decide whether an error message should trigger another attempt under the
 * node's retry policy. The classifier is purely string-based — workflow
 * authors declare patterns up front so the runner doesn't need to introspect
 * stack traces or process state.
 *
 * Rules:
 *  - If `fatal` matches, skip retries entirely. `fatal` always wins over
 *    `transient`, even if both lists overlap.
 *  - If `transient` is set, only retry when the message matches one of those
 *    substrings.
 *  - If neither list is set, every error is retryable up to `maxAttempts`.
 *
 * Patterns are case-insensitive substring matches on the error message.
 */
export function classifyRetry(
  message: string,
  policy: WorkflowRetryPolicy | undefined,
): 'retry' | 'fatal' {
  if (!policy) return 'fatal';
  const lower = message.toLowerCase();

  if (policy.fatal && policy.fatal.some((pattern) => lower.includes(pattern.toLowerCase()))) {
    return 'fatal';
  }

  if (policy.transient) {
    return policy.transient.some((pattern) => lower.includes(pattern.toLowerCase()))
      ? 'retry'
      : 'fatal';
  }

  return 'retry';
}
