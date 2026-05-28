import {
  buildExpressionContext,
  evaluateConditionExpression,
  evaluateExpression,
  renderTemplateString,
  WorkflowExpressionError,
  type ExpressionContext,
} from './expression.js';
import { addEvent, resolveNodeCwd, runShellNode, ShellNodeError } from './runtime-helpers.js';
import type { WorkflowNodeExecutorContext } from './node-executor.js';
import type { WorkflowRunRecord, WorkflowSubflowChild, WorkflowSubflowNode } from './types.js';

interface SubflowChildState {
  status: 'completed' | 'failed' | 'skipped';
  output?: string;
  exitCode?: number;
  error?: string;
}

/**
 * Run a `subflow` node by walking its inline child workflow's topological
 * order. The first cut supports shell-only children; child nodes can declare
 * `needs`, `when`, and `outputs` and reference each other via the same
 * JSONata template surface as the parent — but in a private context where
 * `inputs` is the resolved subflow input map and `nodes.<id>` is restricted
 * to children that have already run.
 *
 * The aggregate parent output is `{ "<child-id>": "<output>", ... }` encoded
 * as JSON so downstream parent nodes can read named child outputs.
 */
export async function executeSubflowNode(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowSubflowNode,
): Promise<void> {
  const state = run.nodes[nodeId];
  if (!state) return;

  const resolvedInputs = await resolveSubflowInputs(node, run, nodeId);
  const order = topologicalOrder(node.inline.nodes, nodeId);
  const childStates = new Map<string, SubflowChildState>();

  for (const childId of order) {
    const child = node.inline.nodes[childId];
    if (!child) continue;

    const guards = await evaluateChildGuards(child, resolvedInputs, childStates);
    if (guards.skip) {
      childStates.set(childId, { status: 'skipped' });
      addEvent(
        run,
        'subflow-child-skipped',
        `Subflow ${nodeId}: child ${childId} skipped — ${guards.reason}`,
        { childId, reason: guards.reason },
        nodeId,
      );
      continue;
    }

    addEvent(
      run,
      'subflow-child-started',
      `Subflow ${nodeId}: child ${childId} started`,
      { childId },
      nodeId,
    );
    await context.saveAndEmit(run);

    const result = await runChild(
      context,
      run,
      nodeId,
      childId,
      child,
      resolvedInputs,
      childStates,
    );
    childStates.set(childId, result);

    if (result.status === 'failed') {
      addEvent(
        run,
        'subflow-child-failed',
        `Subflow ${nodeId}: child ${childId} failed: ${result.error}`,
        { childId, error: result.error },
        nodeId,
      );
      throw new Error(result.error ?? `Subflow ${nodeId}: child ${childId} failed`);
    }

    addEvent(
      run,
      'subflow-child-completed',
      `Subflow ${nodeId}: child ${childId} completed`,
      { childId, exitCode: result.exitCode, output: result.output },
      nodeId,
    );
    await context.saveAndEmit(run);
  }

  const aggregate: Record<string, string> = {};
  for (const [childId, childState] of childStates.entries()) {
    if (childState.status === 'completed' && childState.output !== undefined) {
      aggregate[childId] = childState.output;
    }
  }
  state.output = JSON.stringify(aggregate);
  addEvent(
    run,
    'node-output',
    `Subflow ${nodeId} aggregated ${Object.keys(aggregate).length} child output(s)`,
    { children: Object.keys(aggregate).length, output: state.output },
    nodeId,
  );
}

async function resolveSubflowInputs(
  node: WorkflowSubflowNode,
  run: WorkflowRunRecord,
  nodeId: string,
): Promise<Record<string, unknown>> {
  if (!node.inputs) return {};
  const context = buildExpressionContext(run);
  const resolved: Record<string, unknown> = {};
  for (const [key, expression] of Object.entries(node.inputs)) {
    try {
      resolved[key] = await evaluateExpression(expression, context);
    } catch (error) {
      if (error instanceof WorkflowExpressionError) {
        throw new Error(`Subflow ${nodeId} input '${key}' failed: ${error.message}`);
      }
      throw error;
    }
  }
  return resolved;
}

function topologicalOrder(
  children: Record<string, WorkflowSubflowChild>,
  nodeId: string,
): string[] {
  const ids = Object.keys(children);
  const remaining = new Set(ids);
  const ordered: string[] = [];
  const completed = new Set<string>();

  while (remaining.size > 0) {
    const ready = [...remaining].filter((candidate) => {
      const needs = children[candidate]?.needs ?? [];
      return needs.every((dep) => completed.has(dep));
    });

    if (ready.length === 0) {
      throw new Error(`Subflow ${nodeId} contains a dependency cycle.`);
    }

    ready.sort((a, b) => a.localeCompare(b));
    for (const id of ready) {
      remaining.delete(id);
      completed.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

async function evaluateChildGuards(
  child: WorkflowSubflowChild,
  resolvedInputs: Record<string, unknown>,
  childStates: Map<string, SubflowChildState>,
): Promise<{ skip: boolean; reason?: string }> {
  for (const need of child.needs ?? []) {
    const parent = childStates.get(need);
    if (!parent || parent.status !== 'completed') {
      return { skip: true, reason: `dependency '${need}' did not complete` };
    }
  }
  if (child.when) {
    const context = buildSubflowContext(resolvedInputs, childStates);
    try {
      const truthy = await evaluateConditionExpression(child.when, context);
      if (!truthy) return { skip: true, reason: `when: ${child.when} → false` };
    } catch (error) {
      if (error instanceof WorkflowExpressionError) {
        throw new Error(`Subflow child when expression failed: ${error.message}`);
      }
      throw error;
    }
  }
  // Discard the unused buildExpressionContext import warning when when is
  // omitted by referencing it in a no-op path above; keep only the used one.
  void buildExpressionContext;
  return { skip: false };
}

async function runChild(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  childId: string,
  child: WorkflowSubflowChild,
  resolvedInputs: Record<string, unknown>,
  childStates: Map<string, SubflowChildState>,
): Promise<SubflowChildState> {
  const expressionContext = buildSubflowContext(resolvedInputs, childStates);
  let command: string;
  let cwd: string;
  try {
    command = await renderTemplateString(child.command, expressionContext);
    const cwdRendered = child.cwd
      ? await renderTemplateString(child.cwd, expressionContext)
      : undefined;
    cwd = resolveNodeCwd(run.directoryPath, cwdRendered);
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const abort = context.shellAbortRegistry.create(run.id, `subflow:${nodeId}:${childId}`);
  try {
    const result = await runShellNode(command, {
      cwd,
      timeoutSeconds: child.timeoutSeconds,
      signal: abort.signal,
    });
    return { status: 'completed', output: result.output, exitCode: result.exitCode };
  } catch (error) {
    if (error instanceof ShellNodeError) {
      return {
        status: 'failed',
        output: error.output,
        exitCode: error.exitCode ?? undefined,
        error: error.message,
      };
    }
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    abort.dispose();
  }
}

function buildSubflowContext(
  inputs: Record<string, unknown>,
  childStates: Map<string, SubflowChildState>,
): ExpressionContext {
  const nodes: ExpressionContext['nodes'] = {};
  for (const [childId, state] of childStates.entries()) {
    nodes[childId] = {
      status: state.status,
      output: state.output ?? null,
      outputs: {},
      error: state.error ?? null,
      sessionId: null,
      nativeSessionId: null,
      worktreePath: null,
      approval: null,
    };
  }
  return {
    run: { id: 'subflow', status: 'running', platformId: null, resourceId: null, url: null },
    inputs: inputs as ExpressionContext['inputs'],
    nodes,
  };
}
