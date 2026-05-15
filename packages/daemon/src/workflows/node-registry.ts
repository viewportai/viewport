import { executeLoopNode } from './loop-executor.js';
import { executeActionAdapter } from './action-adapters.js';
import {
  addEvent,
  renderOptionalTemplate,
  renderTemplate,
  resolveNodeCwd,
  runShellNode,
} from './runtime-helpers.js';
import { executeSubflowNode } from './subflow-executor.js';
import type { WorkflowNodeExecutorContext } from './node-executor.js';
import type { WorkflowNode, WorkflowRunRecord } from './types.js';
import { sanitizePlanProposalMetadata } from '../hooks/plan-extractor.js';

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
  shell: async (context, run, nodeId, node) => {
    if (node.type !== 'shell') return { result: 'completed' };
    const state = run.nodes[nodeId];
    const artifactCwd = resolveNodeCwd(
      run.directoryPath,
      await renderOptionalTemplate(node.cwd, run),
    );
    const abort = context.shellAbortRegistry.create(run.id, `node:${nodeId}`);
    let result;
    try {
      result = await runShellNode(await renderTemplate(node.command, run), {
        cwd: artifactCwd,
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
    return { result: 'completed' };
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
    return { result: 'completed' };
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
    const state = run.nodes[nodeId];
    const refs = node.refs ?? [];
    const output = JSON.stringify({
      query: node.query ?? null,
      refs,
      refresh: node.refresh ?? 'before_run',
      status: 'declared',
    });
    if (state) state.output = output;
    addEvent(
      run,
      'node-output',
      `Context node ${nodeId} declared context requirements`,
      { query: node.query ?? null, refs, refresh: node.refresh ?? null },
      nodeId,
    );
    return { result: 'completed' };
  },

  condition: async (_context, run, nodeId, node) => {
    if (node.type !== 'condition') return { result: 'completed' };
    const state = run.nodes[nodeId];
    if (state) state.output = node.expression;
    addEvent(
      run,
      'node-output',
      `Condition node ${nodeId} recorded expression`,
      { expression: node.expression, then: node.then ?? [], else: node.else ?? [] },
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

    const action = await executeActionAdapter(run, nodeId, node, {
      approved: state?.approval?.approved === true,
    });
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

// Seed the mutable registry with built-ins. Plugin entries register at boot.
for (const [type, executor] of Object.entries(BUILTIN_NODE_EXECUTORS)) {
  NODE_EXECUTORS.set(type, executor);
}
