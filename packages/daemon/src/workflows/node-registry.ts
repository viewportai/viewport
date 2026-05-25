import { createHash } from 'node:crypto';
import { executeLoopNode } from './loop-executor.js';
import { executeContextNode } from './context-node-resolver.js';
import { executeActionAdapter, WorkflowActionError } from './action-adapters.js';
import {
  addEvent,
  renderOptionalTemplate,
  renderTemplate,
  resolveNodeCwd,
  runShellNode,
} from './runtime-helpers.js';
import { envNameForCredentialRef } from './action-provider-utils.js';
import { executeSubflowNode } from './subflow-executor.js';
import { buildExpressionContext, evaluateConditionExpression } from './expression.js';
import type { WorkflowNodeExecutorContext } from './node-executor.js';
import type { WorkflowNode, WorkflowRunRecord } from './types.js';
import { sanitizePlanProposalMetadata } from '../hooks/plan-extractor.js';
import { readPromptNodeOutput } from './prompt-output.js';
import { shellAuthorityDenial } from './workflow-authority-contract.js';
import { checkoutAuthorityDenial, executeCheckoutNode } from './checkout-node.js';
import { executeGitPublishNode, gitPublishAuthorityDenial } from './git-publish-node.js';

/**
 * Outcome of a per-type executor handler. The orchestrator in
 * `executeWorkflowNode` reads this to decide whether to record artifacts and
 * mark the node complete, or to leave the run in a blocked state waiting on
 * an external event.
 */
export interface NodeExecutorOutcome {
  /** 'completed' lets the orchestrator finish bookkeeping; 'blocked' returns early. */
  result: 'completed' | 'blocked';
  /**
   * Working directory used for artifact collection. Defaults to the run's
   * directory; shell nodes override based on their `cwd` field.
   */
  artifactCwd?: string;
}

export type BuiltinNodeExecutor = (
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowNode,
  helpers: BuiltinExecutorHelpers,
) => Promise<NodeExecutorOutcome>;

/**
 * Helpers the orchestrator hands every executor. Plugins (Phase 5) will
 * receive an analogous, more constrained surface so they cannot mutate the
 * run record directly.
 */
export interface BuiltinExecutorHelpers {
  executePromptNode: (
    context: WorkflowNodeExecutorContext,
    run: WorkflowRunRecord,
    nodeId: string,
    node: Extract<WorkflowNode, { type: 'prompt' }>,
  ) => Promise<void>;
  executeGateNode: (
    context: WorkflowNodeExecutorContext,
    run: WorkflowRunRecord,
    nodeId: string,
    node: Extract<WorkflowNode, { type: 'gate' }>,
  ) => Promise<'completed' | 'blocked'>;
  blockForApproval: (
    context: WorkflowNodeExecutorContext,
    run: WorkflowRunRecord,
    nodeId: string,
    prompt: string,
  ) => Promise<void>;
}

/**
 * Mutable registry of node executors keyed by `node.type`. Built-ins are
 * registered at module load (immediately below); the plugin loader extends
 * this map at daemon boot with `defineNode()` entries from
 * `~/.viewport/plugins.json`. Keep this table-driven so adding a node type
 * is one entry, not five files.
 */
export const NODE_EXECUTORS = new Map<string, BuiltinNodeExecutor>();

export function registerNodeExecutor(type: string, executor: BuiltinNodeExecutor): void {
  NODE_EXECUTORS.set(type, executor);
}

const BUILTIN_NODE_EXECUTORS: Record<WorkflowNode['type'], BuiltinNodeExecutor> = {
  checkout: async (context, run, nodeId, node) => {
    if (node.type !== 'checkout') return { result: 'completed' };
    const state = run.nodes[nodeId];
    const denial = checkoutAuthorityDenial(run, nodeId, node);
    if (denial) {
      addEvent(run, 'checkout-blocked', denial.detail, { workflow_authority_denial: denial }, nodeId);
      throw new Error(denial.detail);
    }

    const credentialRef = node.credentialRef;
    const credential =
      credentialRef && credentialRef.trim() !== ''
        ? {
            envName: envNameForCredentialRef(credentialRef),
            secret:
              context.runtimeSecretEnv?.[envNameForCredentialRef(credentialRef)] ??
              process.env[envNameForCredentialRef(credentialRef)],
          }
        : undefined;
    const result = await executeCheckoutNode(run, node, credential);
    if (state) {
      state.output = JSON.stringify(result);
      state.worktreePath = result.path;
      state.outputs = {
        ...(state.outputs ?? {}),
        repository: result.repository,
        path: result.path,
        ref: result.ref,
        branch: result.branch,
        commit: result.commit,
      };
      state.metadata = {
        ...(state.metadata ?? {}),
        checkout: {
          schema: 'viewport.checkout_receipt/v1',
          repository: result.repository,
          remote: result.remote,
          ref: result.ref,
          branch: result.branch,
          commit: result.commit,
          credentialMode: result.credentialMode,
          credentialRef: result.credentialRef,
        },
      };
    }
    addEvent(
      run,
      'checkout-completed',
      `Checked out ${result.repository}`,
      {
        repository: result.repository,
        remote: result.remote,
        ref: result.ref,
        branch: result.branch,
        commit: result.commit,
      },
      nodeId,
    );

    return { result: 'completed', artifactCwd: result.path };
  },

  git_publish: async (context, run, nodeId, node) => {
    if (node.type !== 'git_publish') return { result: 'completed' };
    const state = run.nodes[nodeId];
    const input = {
      cwd: resolveNodeCwd(run.directoryPath, await renderOptionalTemplate(node.cwd, run)),
      branch: await renderTemplate(node.branch, run),
      message: await renderTemplate(node.message, run),
    };
    const denial = await gitPublishAuthorityDenial(run, nodeId, node, input);
    if (denial) {
      addEvent(run, 'git-publish-blocked', denial.detail, { workflow_authority_denial: denial }, nodeId);
      throw new Error(denial.detail);
    }

    const credentialRef = node.credentialRef;
    const credential =
      credentialRef && credentialRef.trim() !== ''
        ? {
            envName: envNameForCredentialRef(credentialRef),
            secret:
              context.runtimeSecretEnv?.[envNameForCredentialRef(credentialRef)] ??
              process.env[envNameForCredentialRef(credentialRef)],
          }
        : undefined;
    const result = await executeGitPublishNode(node, input, credential);
    if (state) {
      state.output = JSON.stringify(result);
      state.outputs = {
        ...(state.outputs ?? {}),
        repository: result.repository,
        branch: result.branch,
        commit: result.commit,
        pushed: result.pushed,
        changed: result.changed,
      };
      state.metadata = {
        ...(state.metadata ?? {}),
        git_publish: {
          schema: 'viewport.git_publish_receipt/v1',
          repository: result.repository,
          branch: result.branch,
          commit: result.commit,
          pushed: result.pushed,
          changed: result.changed,
          credentialMode: result.credentialMode,
          credentialRef: result.credentialRef,
        },
      };
    }
    addEvent(
      run,
      'git-publish-completed',
      `Published ${result.repository} branch ${result.branch}`,
      { ...result },
      nodeId,
    );

    return { result: 'completed', artifactCwd: input.cwd };
  },

  shell: async (context, run, nodeId, node) => {
    if (node.type !== 'shell') return { result: 'completed' };
    const state = run.nodes[nodeId];
    const artifactCwd = resolveNodeCwd(
      run.directoryPath,
      await renderOptionalTemplate(node.cwd, run),
    );
    const command = await renderTemplate(node.command, run);
    const denial = shellAuthorityDenial(run, nodeId, command, artifactCwd);
    if (denial) {
      addEvent(run, 'shell-blocked', denial.detail, { workflow_authority_denial: denial }, nodeId);
      throw new Error(denial.detail);
    }
    const abort = context.shellAbortRegistry.create(run.id, `node:${nodeId}`);
    let result;
    try {
      result = await runShellNode(command, {
        cwd: artifactCwd,
        env: await resolveNodeEnv(context, run, node),
        timeoutSeconds: node.timeoutSeconds,
        signal: abort.signal,
        onOutput: ({ source, chunk, output }) => {
          addEvent(
            run,
            'node-log',
            `Node ${nodeId} wrote ${source}`,
            { source, chunk, output },
            nodeId,
          );
          run.updatedAt = Date.now();
          void context.saveAndEmit(run);
        },
      });
    } finally {
      abort.dispose();
    }
    if (state) {
      state.output = result.output;
      state.exitCode = result.exitCode;
    }
    addEvent(
      run,
      'node-output',
      `Node ${nodeId} produced shell output`,
      { output: result.output, exitCode: result.exitCode },
      nodeId,
    );
    return { result: 'completed', artifactCwd };
  },

  prompt: async (context, run, nodeId, node, helpers) => {
    if (node.type !== 'prompt') return { result: 'completed' };
    await helpers.executePromptNode(context, run, nodeId, node);
    const artifactCwd = run.nodes[nodeId]?.worktreePath;

    return artifactCwd ? { result: 'completed', artifactCwd } : { result: 'completed' };
  },

  agent: async (context, run, nodeId, node, helpers) => {
    if (node.type !== 'agent') return { result: 'completed' };
    const promptNode: Extract<WorkflowNode, { type: 'prompt' }> = {
      ...node,
      type: 'prompt',
    };
    await helpers.executePromptNode(context, run, nodeId, promptNode);
    if (node.handoff) {
      addEvent(
        run,
        'node-output',
        `Agent node ${nodeId} prepared handoff metadata`,
        { handoff: node.handoff },
        nodeId,
      );
    }
    const artifactCwd = run.nodes[nodeId]?.worktreePath;

    return artifactCwd ? { result: 'completed', artifactCwd } : { result: 'completed' };
  },

  approval: async (context, run, nodeId, node, helpers) => {
    if (node.type !== 'approval') return { result: 'completed' };
    await helpers.blockForApproval(context, run, nodeId, await renderTemplate(node.prompt, run));
    return { result: 'blocked' };
  },

  gate: async (context, run, nodeId, node, helpers) => {
    if (node.type !== 'gate') return { result: 'completed' };
    const gateResult = await helpers.executeGateNode(context, run, nodeId, node);
    return { result: gateResult };
  },

  context: async (_context, run, nodeId, node) => {
    if (node.type !== 'context') return { result: 'completed' };
    await executeContextNode(run, nodeId, node);
    return { result: 'completed' };
  },

  context_update: async (context, run, nodeId, node) => {
    if (node.type !== 'context_update') return { result: 'completed' };
    const state = run.nodes[nodeId];
    const targetRef = await renderTemplate(node.targetRef, run);
    const title = await renderTemplate(node.title, run);
    const summary = await renderOptionalTemplate(node.summary, run);
    const idempotencyKey = await renderOptionalTemplate(node.idempotencyKey, run);
    const patch = await renderContextUpdatePatch(node.patch, run);

    try {
      const proposal = await context.platformContextClient?.proposeContextUpdate({
        run,
        nodeId,
        targetRef,
        title,
        summary,
        patch,
        idempotencyKey,
      });
      const output = proposal?.proposalId
        ? `Context update proposal ${proposal.proposalId}`
        : `Context update proposal prepared for ${targetRef}`;
      if (state) {
        state.output = output;
        state.outputs = {
          ...(state.outputs ?? {}),
          target_ref: targetRef,
          proposal_id: proposal?.proposalId ?? null,
          inbox_item_id: proposal?.inboxItemId ?? null,
          status: proposal?.status ?? 'prepared',
        };
        state.metadata = {
          ...(state.metadata ?? {}),
          context_update: {
            target_ref: targetRef,
            title,
            summary: summary ?? null,
            patch_digest: patchDigest(patch),
            idempotency_key: idempotencyKey ?? null,
            proposal_id: proposal?.proposalId ?? null,
            inbox_item_id: proposal?.inboxItemId ?? null,
            status: proposal?.status ?? 'prepared',
            plaintext_patch_persisted: false,
          },
        };
      }
      addEvent(
        run,
        'context-update-proposed',
        proposal?.proposalId
          ? `Context update proposal ${proposal.proposalId} created for ${targetRef}`
          : `Context update proposal prepared for ${targetRef}`,
        {
          targetRef,
          title,
          proposalId: proposal?.proposalId ?? null,
          inboxItemId: proposal?.inboxItemId ?? null,
          status: proposal?.status ?? 'prepared',
          patchDigest: patchDigest(patch),
        },
        nodeId,
      );
      return { result: 'completed' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (state) {
        state.output = `Context update proposal failed: ${message}`;
        state.metadata = {
          ...(state.metadata ?? {}),
          context_update: {
            target_ref: targetRef,
            title,
            status: 'failed',
            error: message,
            patch_digest: patchDigest(patch),
            plaintext_patch_persisted: false,
          },
        };
      }
      addEvent(
        run,
        'context-update-proposal-failed',
        `Context update proposal failed for ${targetRef}: ${message}`,
        { targetRef, title, error: message, patchDigest: patchDigest(patch) },
        nodeId,
      );
      throw error;
    }
  },

  condition: async (_context, run, nodeId, node) => {
    if (node.type !== 'condition') return { result: 'completed' };
    const state = run.nodes[nodeId];
    const matched = await evaluateConditionExpression(node.expression, buildExpressionContext(run));
    const selected = matched ? (node.then ?? []) : (node.else ?? []);
    const skipped = matched ? (node.else ?? []) : (node.then ?? []);
    const branch = matched ? 'then' : 'else';
    if (state) {
      state.output = matched ? 'true' : 'false';
      state.outputs = {
        ...(state.outputs ?? {}),
        result: matched,
        branch,
        selected,
        skipped,
      };
    }
    for (const branchNodeId of skipped) {
      const branchState = run.nodes[branchNodeId];
      if (!branchState || branchState.status !== 'queued') continue;
      branchState.status = 'skipped';
      branchState.skipReason = `condition:${nodeId}:${branch}`;
      branchState.completedAt = Date.now();
      addEvent(
        run,
        'node-skipped',
        `Node ${branchNodeId} skipped by condition ${nodeId}`,
        { conditionNodeId: nodeId, branch, expression: node.expression },
        branchNodeId,
      );
    }
    addEvent(
      run,
      'condition-evaluated',
      `Condition node ${nodeId} selected ${branch}`,
      { expression: node.expression, result: matched, branch, selected, skipped },
      nodeId,
    );
    return { result: 'completed' };
  },

  artifact: async (_context, run, nodeId, node) => {
    if (node.type !== 'artifact') return { result: 'completed' };
    const state = run.nodes[nodeId];
    const output = node.path ?? node.from ?? node.name;
    if (state) state.output = output;
    addEvent(
      run,
      'node-output',
      `Artifact node ${nodeId} recorded ${node.name}`,
      {
        name: node.name,
        from: node.from ?? null,
        path: node.path ?? null,
        kind: node.kind ?? null,
      },
      nodeId,
    );
    return { result: 'completed' };
  },

  action: async (context, run, nodeId, node, helpers) => {
    if (node.type !== 'action') return { result: 'completed' };
    const state = run.nodes[nodeId];
    if (node.requiresApproval === true && state?.approval?.approved !== true) {
      const action = await executeActionAdapter(run, nodeId, node);
      if (state) {
        state.output = action.output;
        state.metadata = {
          ...(state.metadata ?? {}),
          ...action.metadata,
        };
      }
      await helpers.blockForApproval(
        context,
        run,
        nodeId,
        `Approve ${node.adapter}.${node.action} side effect?`,
      );
      return { result: 'blocked' };
    }

    let action;
    try {
      action = await executeActionAdapter(run, nodeId, node, {
        approved: state?.approval?.approved === true,
      });
    } catch (error) {
      if (error instanceof WorkflowActionError && state) {
        state.output = error.result.output;
        state.metadata = {
          ...(state.metadata ?? {}),
          ...error.result.metadata,
        };
      }
      throw error;
    }
    if (state) {
      state.output = action.output;
      state.metadata = {
        ...(state.metadata ?? {}),
        ...action.metadata,
      };
    }
    addEvent(
      run,
      'node-output',
      `Action node ${nodeId} handled ${node.adapter}.${node.action}`,
      {
        adapter: node.adapter,
        action: node.action,
        idempotencyKey: node.idempotencyKey ?? null,
        requiresApproval: node.requiresApproval === true,
      },
      nodeId,
    );
    return { result: 'completed' };
  },

  loop: async (context, run, nodeId, node) => {
    if (node.type !== 'loop') return { result: 'completed' };
    await executeLoopNode(context, run, nodeId, node);
    return { result: 'completed' };
  },

  subflow: async (context, run, nodeId, node) => {
    if (node.type !== 'subflow') return { result: 'completed' };
    await executeSubflowNode(context, run, nodeId, node);
    return { result: 'completed' };
  },

  plan: async (context, run, nodeId, node, helpers) => {
    if (node.type !== 'plan') return { result: 'completed' };
    const state = run.nodes[nodeId];
    await backfillPromptDependencyOutputs(run, node.needs);
    const title = await renderTemplate(node.title ?? nodeId, run);
    const body = await renderTemplate(node.body, run);
    const summary = await renderOptionalTemplate(node.summary, run);
    const sourceRef = await renderOptionalTemplate(node.sourceRef, run);
    if (state) {
      state.output = body;
      state.metadata = {
        ...(state.metadata ?? {}),
        plan: {
          title,
          summary,
          body,
          source: node.source ?? 'workflow',
          sourceRef: sourceRef || `viewport://workflow-runs/${run.id}/nodes/${nodeId}`,
          ...(node.recipients ? { recipients: node.recipients } : {}),
          ...(node.revision ? { revision: node.revision } : {}),
        },
      };
    }
    context.daemon.emit('hook:plan-proposed', {
      sessionId: `${run.id}:${nodeId}`,
      adapter: 'viewport-workflow',
      cwd: run.directoryPath,
      title,
      summary,
      body,
      source: node.source ?? 'workflow',
      sourceRef: sourceRef || `viewport://workflow-runs/${run.id}/nodes/${nodeId}`,
      metadata: sanitizePlanProposalMetadata({
        workflowRunId: run.id,
        workflowNodeId: nodeId,
        resourceId: run.resourceId ?? null,
      }),
    });
    addEvent(
      run,
      'plan-proposed',
      `Plan node ${nodeId} proposed ${title}`,
      { title, summary, sourceRef: sourceRef || null },
      nodeId,
    );
    if (node.waitForApproval === false) {
      return { result: 'completed' };
    }
    await helpers.blockForApproval(context, run, nodeId, `Approve plan: ${title}`);
    return { result: 'blocked' };
  },
};

async function backfillPromptDependencyOutputs(
  run: WorkflowRunRecord,
  needs: string[] | undefined,
): Promise<void> {
  for (const dependencyId of needs ?? []) {
    const dependency = run.nodes[dependencyId];
    if (!dependency || dependency.type !== 'prompt' || dependency.output) continue;
    const output = await readPromptNodeOutput(run, dependency);
    if (output) dependency.output = output;
  }
}

// Seed the mutable registry with built-ins. Plugin entries register at boot.
for (const [type, executor] of Object.entries(BUILTIN_NODE_EXECUTORS)) {
  NODE_EXECUTORS.set(type, executor);
}

async function resolveNodeEnv(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  node: WorkflowNode,
): Promise<Record<string, string> | undefined> {
  if (!node.env || Object.keys(node.env).length === 0) return undefined;

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(node.env)) {
    if (value.value !== undefined) {
      env[name] = await renderTemplate(value.value, run);
      continue;
    }
    if (!value.secret) continue;

    const envName = envNameForCredentialRef(value.secret);
    const material = context.runtimeSecretEnv?.[envName] ?? process.env[envName];
    if (!material) {
      throw new Error(
        `Secret binding ${value.secret} was not materialized for env ${name}. Select it in the workflow/profile and keep runner-local material in ${envName} when using BYO secrets.`,
      );
    }
    env[name] = material;
  }

  return env;
}

async function renderContextUpdatePatch(
  patch: Extract<WorkflowNode, { type: 'context_update' }>['patch'],
  run: WorkflowRunRecord,
): Promise<Record<string, unknown> | undefined> {
  if (!patch) return undefined;
  return {
    ...(patch.mode ? { mode: patch.mode } : {}),
    ...(patch.text ? { text_digest: digest(await renderTemplate(patch.text, run)) } : {}),
    ...(patch.digest ? { digest: await renderTemplate(patch.digest, run) } : {}),
  };
}

function patchDigest(patch: Record<string, unknown> | undefined): string | null {
  if (!patch) return null;
  return digest(JSON.stringify(patch));
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
