import crypto from 'node:crypto';
import type { SessionResourceManifest } from '../config-resolution/types.js';
import type { WorkflowContractBinding } from '../workflows/types.js';

export interface WorkflowRunJsonInput {
  id: string;
  workflowName: string;
  workflowTitle?: string;
  sourceType?: string;
  sourcePath?: string;
  digest: string;
  status: string;
  error?: string;
  resourceManifest?: SessionResourceManifest;
  workflowContract?: WorkflowContractBinding;
  nodes?: Record<
    string,
    {
      id?: string;
      type?: string;
      title?: string;
      status?: string;
      sessionId?: string;
      nativeSessionId?: string;
      outputs?: Record<string, unknown>;
      output?: string;
      error?: string;
      approval?: {
        prompt?: string;
        requestedAt?: number;
        resolvedAt?: number;
        approved?: boolean;
        message?: string;
      };
    }
  >;
}

export function buildWorkflowRunJsonOutput(run: WorkflowRunJsonInput): Record<string, unknown> {
  return {
    schema_version: 'viewport.cli.workflow_run/v1',
    command: 'workflow run',
    ok: run.status === 'completed',
    run_id: run.id,
    workflow: {
      id: run.workflowName,
      name: run.workflowTitle ?? run.workflowName,
      digest: run.digest,
      ...(run.sourceType ? { source: run.sourceType } : {}),
      ...(run.sourcePath ? { path: run.sourcePath } : {}),
    },
    ...(run.workflowContract ? { workflow_contract: workflowContractSummary(run) } : {}),
    status: run.status,
    manifest_digest: run.resourceManifest?.manifestDigest ?? run.digest,
    ...(run.resourceManifest
      ? { resource_manifest: summarizeResourceManifest(run.resourceManifest) }
      : {}),
    steps: workflowRunSteps(run),
    errors: run.error ? [{ code: 'workflow_run_error', message: run.error }] : [],
    run,
  };
}

function workflowContractSummary(run: WorkflowRunJsonInput): Record<string, unknown> {
  const contract = run.workflowContract;
  if (!contract) return {};
  return {
    status: contract.status,
    digest_status: contract.digestStatus,
    actual_digest: contract.actualDigest,
    ...(contract.id ? { id: contract.id } : {}),
    ...(contract.sourceConfigPath ? { source_config_path: contract.sourceConfigPath } : {}),
    ...(contract.declaredPath ? { declared_path: contract.declaredPath } : {}),
    ...(contract.resource ? { resource: contract.resource } : {}),
    ...(contract.version ? { version: contract.version } : {}),
    ...(contract.declaredDigest ? { declared_digest: contract.declaredDigest } : {}),
    ...(contract.reason ? { reason: contract.reason } : {}),
  };
}

function summarizeResourceManifest(manifest: SessionResourceManifest): Record<string, unknown> {
  return {
    schema: manifest.schema,
    manifest_digest: manifest.manifestDigest,
    working_directory: manifest.workingDirectory,
    config_files: manifest.configSources.map((source) => source.path),
    resources: manifest.resources,
    providers: manifest.contract.contextProviders.map((provider) => ({
      id: provider.id,
      provider: provider.provider,
      privacy: provider.privacy,
      capabilities: provider.capabilities,
      status: provider.resolution,
      required: provider.required,
      ...(provider.vault ? { vault: provider.vault } : {}),
      ...(provider.paths ? { paths: provider.paths } : {}),
      ...(provider.notebook ? { notebook: provider.notebook } : {}),
      ...(provider.credentialRef ? { credential_ref: provider.credentialRef } : {}),
      source_config_path: provider.sourceConfigPath,
    })),
    context_resolution: manifest.contract.contextResolution,
    workflows: manifest.contract.workflows.map((workflow) => ({
      id: workflow.id,
      required: workflow.required,
      status: workflow.resolution,
      source_config_path: workflow.sourceConfigPath,
      ...(workflow.path ? { path: workflow.path } : {}),
      ...(workflow.resource ? { resource: workflow.resource } : {}),
      ...(workflow.version ? { version: workflow.version } : {}),
      ...(workflow.digest ? { digest: workflow.digest } : {}),
    })),
    approvals: manifest.contract.riskyPathRules.map((rule) => ({
      id: rule.id,
      path: rule.path,
      require: rule.require,
      checks: rule.checks,
      source_config_path: rule.sourceConfigPath,
    })),
    warnings: manifest.warnings,
    conflicts: manifest.conflicts,
  };
}

function workflowRunSteps(run: WorkflowRunJsonInput): Array<Record<string, unknown>> {
  return Object.entries(run.nodes ?? {}).map(([nodeKey, node]) => ({
    id: node.id ?? nodeKey,
    type: node.type,
    name: node.title ?? node.id ?? nodeKey,
    status: node.status,
    ...(node.sessionId ? { session_id: node.sessionId } : {}),
    ...(node.nativeSessionId ? { native_session_id: node.nativeSessionId } : {}),
    ...(node.outputs ? { outputs: node.outputs } : {}),
    ...(node.output ? { output_digest: digestString(node.output) } : {}),
    ...(node.error ? { error: node.error } : {}),
    ...(node.approval
      ? {
          approval: {
            ...(node.approval.prompt ? { prompt: node.approval.prompt } : {}),
            ...(node.approval.requestedAt !== undefined
              ? { requested_at: node.approval.requestedAt }
              : {}),
            ...(node.approval.resolvedAt !== undefined
              ? { resolved_at: node.approval.resolvedAt }
              : {}),
            ...(typeof node.approval.approved === 'boolean'
              ? { approved: node.approval.approved }
              : {}),
            ...(node.approval.message ? { message: node.approval.message } : {}),
          },
        }
      : {}),
  }));
}

function digestString(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
