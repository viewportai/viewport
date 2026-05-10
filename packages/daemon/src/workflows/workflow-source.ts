import path from 'node:path';
import { parseWorkflow, parseWorkflowFile } from './parser.js';
import type { ParsedWorkflow, WorkflowRunRequest } from './types.js';

export async function resolveWorkflowSource(
  request: WorkflowRunRequest,
  directoryPath: string,
): Promise<ParsedWorkflow> {
  if (request.workflowYaml) {
    return parseWorkflow(
      request.workflowYaml,
      request.workflowSourceRef?.trim() || 'viewport://workflow/inline',
    );
  }

  if (!request.workflowPath) {
    throw new Error('Workflow run requires a workflow file path or YAML snapshot');
  }

  const workflowPath = path.isAbsolute(request.workflowPath)
    ? request.workflowPath
    : path.join(directoryPath, request.workflowPath);
  const parsed = await parseWorkflowFile(workflowPath);
  assertDeclaredDigestMatches(request, parsed.digest);
  return parsed;
}

function assertDeclaredDigestMatches(request: WorkflowRunRequest, actualDigest: string): void {
  const declaredDigest = request.workflowContract?.declaredDigest;
  if (!declaredDigest) return;
  if (normalizeDigest(declaredDigest) === normalizeDigest(actualDigest)) return;
  const contract = request.workflowContract;
  throw new Error(
    `Workflow digest mismatch for ${contract?.id ?? request.workflowPath}: expected ${declaredDigest}, got sha256:${actualDigest}`,
  );
}

function normalizeDigest(value: string): string {
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}
