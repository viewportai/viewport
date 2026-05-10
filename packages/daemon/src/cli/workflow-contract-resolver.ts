import fs from 'node:fs';
import path from 'node:path';
import {
  resolveSessionResourceManifestSync,
  type SessionResourceManifest,
  type SessionWorkflowManifest,
} from '../config-resolution/index.js';
import type { WorkflowContractBindingInput } from '../workflows/types.js';

export interface ResolvedWorkflowRunTarget {
  workflowPath: string;
  workflowContract: WorkflowContractBindingInput;
  resourceManifest: SessionResourceManifest;
}

export function resolveWorkflowRunTarget(input: {
  workflowTarget: string;
  directoryPath: string;
  cwd?: string;
}): ResolvedWorkflowRunTarget {
  const directoryPath = path.resolve(input.directoryPath);
  const resourceManifest = resolveSessionResourceManifestSync({
    workingDirectory: directoryPath,
  });
  const byId = resourceManifest.contract.workflows.find(
    (workflow) => workflow.id === input.workflowTarget,
  );
  if (byId) {
    if (!byId.path) {
      throw new Error(
        `Workflow ${byId.id} is declared as a server workflow resource. Local execution is not available yet.`,
      );
    }
    return {
      workflowPath: resolveWorkflowPath(byId),
      workflowContract: workflowContractInput(byId),
      resourceManifest,
    };
  }

  const workflowPath = resolveWorkflowPathFromUserInput({
    workflowTarget: input.workflowTarget,
    directoryPath,
    cwd: input.cwd ?? process.cwd(),
  });
  const declared = resourceManifest.contract.workflows.find(
    (workflow) => workflow.path && resolveWorkflowPath(workflow) === workflowPath,
  );

  return {
    workflowPath,
    workflowContract: declared
      ? workflowContractInput(declared)
      : {
          status: 'undeclared',
          reason: 'workflow target is not declared in .viewport/config.yaml',
        },
    resourceManifest,
  };
}

function workflowContractInput(workflow: SessionWorkflowManifest): WorkflowContractBindingInput {
  return {
    id: workflow.id,
    sourceConfigPath: workflow.sourceConfigPath,
    declaredPath: workflow.path,
    resource: workflow.resource,
    version: workflow.version,
    declaredDigest: workflow.digest,
    status: 'verified',
  };
}

function resolveWorkflowPath(workflow: SessionWorkflowManifest): string {
  if (!workflow.path) {
    throw new Error(`Workflow ${workflow.id} does not declare a local path.`);
  }
  if (path.isAbsolute(workflow.path)) return path.resolve(workflow.path);
  return path.resolve(configRoot(workflow.sourceConfigPath), workflow.path);
}

function configRoot(sourceConfigPath: string): string {
  const configDir = path.dirname(sourceConfigPath);
  return path.basename(configDir) === '.viewport' ? path.dirname(configDir) : configDir;
}

function resolveWorkflowPathFromUserInput(input: {
  workflowTarget: string;
  directoryPath: string;
  cwd: string;
}): string {
  if (path.isAbsolute(input.workflowTarget)) return path.resolve(input.workflowTarget);
  const cwdRelative = path.resolve(input.cwd, input.workflowTarget);
  if (fs.existsSync(cwdRelative)) return cwdRelative;
  return path.resolve(input.directoryPath, input.workflowTarget);
}
