import { parseGitContextUpdateTargetRef } from './context-update-targets.js';
import { renderTemplate } from './runtime-helpers.js';
import type {
  ParsedWorkflow,
  WorkflowActionNode,
  WorkflowContext,
  WorkflowContextDefaults,
  WorkflowContextReference,
  WorkflowContextWriteTarget,
  WorkflowNodeContextEnvelope,
} from './types.js';
import type { WorkflowRunRecord } from './run-types.js';

export interface WorkflowRunPreparation {
  schema: 'viewport.run_preparation/v1';
  operating_repos: Array<Record<string, unknown>>;
  context_sources: Array<Record<string, unknown>>;
  update_targets: Array<Record<string, unknown>>;
  side_effects: Array<Record<string, unknown>>;
  credentials: Array<Record<string, unknown>>;
  note: string;
}

export interface WorkflowRunPreparationReceipt {
  schema: 'viewport.run_preparation_receipt/v1';
  kind:
    | 'operating_repo_prepared'
    | 'context_source_prepared'
    | 'context_update_target_prepared'
    | 'credential_binding_verified'
    | 'side_effect_prepared';
  ref: string;
  reason: string;
  node_id?: string;
  details?: Record<string, unknown>;
}

export async function buildRunPreparation(
  parsed: ParsedWorkflow,
  run: WorkflowRunRecord,
): Promise<{ preparation: WorkflowRunPreparation; receipts: WorkflowRunPreparationReceipt[] }> {
  const operatingRepos: Array<Record<string, unknown>> = [];
  const contextSources: Array<Record<string, unknown>> = [];
  const updateTargets: Array<Record<string, unknown>> = [];
  const sideEffects: Array<Record<string, unknown>> = [];
  const credentials: Array<Record<string, unknown>> = [];
  const receipts: WorkflowRunPreparationReceipt[] = [];
  const seen = new Set<string>();

  const pushReceipt = (receipt: WorkflowRunPreparationReceipt): void => {
    const key = `${receipt.kind}:${receipt.node_id ?? ''}:${receipt.ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    receipts.push(receipt);
  };

  for (const [nodeId, node] of Object.entries(parsed.definition.nodes)) {
    if (node.type === 'checkout') {
      const repository = await renderTemplate(node.repository, run);
      const item = {
        repository,
        reason: `checkout node ${nodeId}`,
        mode: 'checkout',
        credential_mode: node.credentialMode ?? 'runner_local',
        node_id: nodeId,
      };
      operatingRepos.push(item);
      pushReceipt({
        schema: 'viewport.run_preparation_receipt/v1',
        kind: 'operating_repo_prepared',
        ref: repository,
        reason: `checkout node ${nodeId}`,
        node_id: nodeId,
        details: item,
      });
      if (node.credentialRef) {
        const credential = await renderTemplate(node.credentialRef, run);
        const details = { credential_ref: credential, node_id: nodeId, use_for: 'checkout' };
        credentials.push(details);
        pushReceipt({
          schema: 'viewport.run_preparation_receipt/v1',
          kind: 'credential_binding_verified',
          ref: credential,
          reason: `checkout node ${nodeId}`,
          node_id: nodeId,
          details,
        });
      }
    }

    if (node.type === 'git_publish') {
      const repository = await renderTemplate(node.repository, run);
      const item = {
        repository,
        reason: `git_publish node ${nodeId}`,
        mode: 'publish',
        credential_mode: node.credentialMode ?? 'runner_local',
        node_id: nodeId,
      };
      operatingRepos.push(item);
      pushReceipt({
        schema: 'viewport.run_preparation_receipt/v1',
        kind: 'operating_repo_prepared',
        ref: repository,
        reason: `git_publish node ${nodeId}`,
        node_id: nodeId,
        details: item,
      });
      if (node.credentialRef) {
        const credential = await renderTemplate(node.credentialRef, run);
        const details = { credential_ref: credential, node_id: nodeId, use_for: 'git_publish' };
        credentials.push(details);
        pushReceipt({
          schema: 'viewport.run_preparation_receipt/v1',
          kind: 'credential_binding_verified',
          ref: credential,
          reason: `git_publish node ${nodeId}`,
          node_id: nodeId,
          details,
        });
      }
    }

    for (const source of await contextRefs(node.context?.include, run)) {
      const item = {
        ref: source,
        reason: `node ${nodeId} include`,
        mode: 'read',
        node_id: nodeId,
      };
      contextSources.push(item);
      pushReceipt({
        schema: 'viewport.run_preparation_receipt/v1',
        kind: 'context_source_prepared',
        ref: source,
        reason: `node ${nodeId} include`,
        node_id: nodeId,
        details: item,
      });
    }

    for (const target of await writeTargetRefs(node.context, run)) {
      const item = updateTargetItem(target, `node ${nodeId} write target`, nodeId);
      updateTargets.push(item);
      pushReceipt({
        schema: 'viewport.run_preparation_receipt/v1',
        kind: 'context_update_target_prepared',
        ref: target,
        reason: `node ${nodeId} write target`,
        node_id: nodeId,
        details: item,
      });
    }

    if (node.type === 'context_update') {
      const target = await renderTemplate(node.targetRef, run);
      const item = updateTargetItem(target, `context_update node ${nodeId}`, nodeId);
      updateTargets.push(item);
      pushReceipt({
        schema: 'viewport.run_preparation_receipt/v1',
        kind: 'context_update_target_prepared',
        ref: target,
        reason: `context_update node ${nodeId}`,
        node_id: nodeId,
        details: item,
      });
    }

    if (node.type === 'action') {
      const action = await sideEffectItem(nodeId, node, run);
      sideEffects.push(action);
      pushReceipt({
        schema: 'viewport.run_preparation_receipt/v1',
        kind: 'side_effect_prepared',
        ref: `${action.adapter}.${action.action}`,
        reason: `action node ${nodeId}`,
        node_id: nodeId,
        details: action,
      });
      if (typeof action.credential_ref === 'string') {
        credentials.push({
          credential_ref: action.credential_ref,
          node_id: nodeId,
          use_for: `${action.adapter}.${action.action}`,
        });
        pushReceipt({
          schema: 'viewport.run_preparation_receipt/v1',
          kind: 'credential_binding_verified',
          ref: action.credential_ref,
          reason: `action node ${nodeId}`,
          node_id: nodeId,
          details: { credential_ref: action.credential_ref, node_id: nodeId },
        });
      }
    }
  }

  const workflowContext = parsed.definition.context;
  const workflowSources = Array.isArray(workflowContext)
    ? workflowContext
    : (workflowContext?.sources ?? []);
  const workflowUpdateTargets = !Array.isArray(workflowContext)
    ? (workflowContext?.update_targets ?? workflowContext?.updateTargets ?? [])
    : [];

  for (const source of await contextRefs(workflowSources, run)) {
    const item = { ref: source, reason: 'workflow default context', mode: 'available' };
    contextSources.push(item);
    pushReceipt({
      schema: 'viewport.run_preparation_receipt/v1',
      kind: 'context_source_prepared',
      ref: source,
      reason: 'workflow default context',
      details: item,
    });
  }

  for (const target of await writeTargetListRefs(workflowUpdateTargets, run)) {
    const item = updateTargetItem(target, 'workflow default update target', 'workflow');
    updateTargets.push(item);
    pushReceipt({
      schema: 'viewport.run_preparation_receipt/v1',
      kind: 'context_update_target_prepared',
      ref: target,
      reason: 'workflow default update target',
      details: item,
    });
  }

  return {
    preparation: {
      schema: 'viewport.run_preparation/v1',
      operating_repos: operatingRepos,
      context_sources: contextSources,
      update_targets: updateTargets,
      side_effects: sideEffects,
      credentials,
      note: 'Run preparation makes authorized repos, context sources, update targets, credentials, and side effects available. It does not inject prepared context into every node; node policy still decides actual access.',
    },
    receipts,
  };
}

async function contextRefs(
  context: WorkflowContext | undefined,
  run: WorkflowRunRecord,
): Promise<string[]> {
  if (!Array.isArray(context)) return [];
  const refs: string[] = [];
  for (const entry of context) {
    const ref = contextRef(entry);
    if (ref) refs.push(await renderTemplate(ref, run));
  }
  return refs;
}

function contextRef(entry: WorkflowContext[number]): string | null {
  if (typeof entry === 'string') return entry;
  const candidate = entry as WorkflowContextReference;
  return candidate.ref ?? candidate.source ?? candidate.package ?? candidate.artifact ?? null;
}

async function writeTargetRefs(
  context: WorkflowNodeContextEnvelope | undefined,
  run: WorkflowRunRecord,
): Promise<string[]> {
  const targets = context?.write_targets ?? context?.writeTargets ?? [];
  return writeTargetListRefs(targets, run);
}

async function writeTargetListRefs(
  targets: WorkflowContextDefaults['update_targets'],
  run: WorkflowRunRecord,
): Promise<string[]> {
  const refs: string[] = [];
  if (!targets) return refs;
  for (const target of targets) {
    const ref = writeTargetRef(target);
    if (ref) refs.push(await renderTemplate(ref, run));
  }
  return refs;
}

function writeTargetRef(target: WorkflowContextWriteTarget): string | null {
  if (typeof target === 'string') return target;
  return target.ref ?? target.path ?? target.collection ?? null;
}

function updateTargetItem(target: string, reason: string, nodeId: string): Record<string, unknown> {
  const parsed = parseGitContextUpdateTargetRef(target);
  return {
    ref: target,
    reason,
    node_id: nodeId,
    provider: parsed?.provider ?? 'unknown',
    repository: parsed?.repository ?? null,
    path: parsed?.path ?? null,
    scope: parsed?.scope ?? null,
    apply_mode: parsed?.provider === 'git' ? 'pull_request' : 'provider_writeback_after_approval',
    approval: 'required',
  };
}

async function sideEffectItem(
  nodeId: string,
  node: WorkflowActionNode,
  run: WorkflowRunRecord,
): Promise<Record<string, unknown>> {
  const credentialRef =
    typeof node.with?.credential_ref === 'string'
      ? await renderTemplate(node.with.credential_ref, run)
      : null;

  return {
    adapter: node.adapter,
    action: node.action,
    node_id: nodeId,
    credential_ref: credentialRef,
    requires_approval: node.requiresApproval ?? false,
  };
}
