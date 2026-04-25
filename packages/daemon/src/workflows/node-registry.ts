import { executeLoopNode } from './loop-executor.js';
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
 * Lookup table mapping `node.type` to its executor. Today we register the
 * built-in node types here; the daemon's plugin loader will extend this
 * registry with `defineNode()` registrations from `~/.viewport/plugins.json`
 * once the loader ships. Keeping this surface small and table-driven is the
 * whole point — adding a node type should be one entry, not five files.
 */
export const BUILTIN_NODE_EXECUTORS: Record<WorkflowNode['type'], BuiltinNodeExecutor> = {
  shell: async (context, run, nodeId, node) => {
    if (node.type !== 'shell') return { result: 'completed' };
    const state = run.nodes[nodeId];
    const artifactCwd = resolveNodeCwd(
      run.directoryPath,
      await renderOptionalTemplate(node.cwd, run),
    );
    const result = await runShellNode(await renderTemplate(node.command, run), {
      cwd: artifactCwd,
      timeoutSeconds: node.timeoutSeconds,
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
};
