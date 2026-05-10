import type { WorkflowContractBinding, WorkflowContractBindingInput } from './types.js';

export function buildWorkflowContractBinding(
  input: WorkflowContractBindingInput | undefined,
  actualDigest: string,
): WorkflowContractBinding | undefined {
  if (!input) return undefined;
  const digestStatus = input.declaredDigest
    ? normalizeDigest(input.declaredDigest) === normalizeDigest(actualDigest)
      ? 'matched'
      : 'mismatch'
    : 'unpinned';
  return {
    ...input,
    status: digestStatus === 'mismatch' ? 'digest_mismatch' : input.status,
    actualDigest: `sha256:${normalizeDigest(actualDigest)}`,
    digestStatus,
  };
}

function normalizeDigest(value: string): string {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}
