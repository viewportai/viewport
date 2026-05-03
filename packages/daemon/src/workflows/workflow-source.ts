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
  return parseWorkflowFile(workflowPath);
}
