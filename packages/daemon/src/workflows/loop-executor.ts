import {
  buildExpressionContext,
  evaluateConditionExpression,
  evaluateExpression,
  WorkflowExpressionError,
} from './expression.js';
import {
  addEvent,
  renderOptionalTemplate,
  renderTemplate,
  resolveNodeCwd,
  runShellNode,
  ShellNodeError,
} from './runtime-helpers.js';
import { runWorkflowDaemonSession } from './daemon-session.js';
import type { WorkflowNodeExecutorContext } from './node-executor.js';
import type { WorkflowLoopIterationRecord, WorkflowLoopNode, WorkflowRunRecord } from './types.js';

interface LoopFrame {
  index: number;
  item: unknown;
  last: WorkflowLoopIterationRecord | null;
}

type LoopExtras = Record<string, unknown> & { loop: LoopFrame };

/**
 * Run a `loop` node. Iterates the body shell command up to `maxIterations`
 * times under one of three modes:
 *  - foreach: iterate the array returned by the JSONata expression.
 *  - while:   evaluate before each iteration; stop when the condition is falsy.
 *  - until:   evaluate after each iteration; stop when the condition is truthy.
 *
 * Each iteration executes with extras `{ loop: { index, item, last } }` merged
 * into the expression context, so the body command and `until`/`while`
 * conditions can reference iteration state. The aggregate node output is the
 * iteration outputs joined as a JSON array, so downstream nodes can read the
 * full series via `nodes.<id>.outputs` (when declared) or `output`.
 */
export async function executeLoopNode(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowLoopNode,
): Promise<void> {
  const state = run.nodes[nodeId];
  if (!state) return;
  state.iterations = [];

  const items = node.foreach ? await resolveForeachItems(node.foreach, run, nodeId) : null;
  const totalCap = items ? Math.min(items.length, node.maxIterations) : node.maxIterations;

  for (let index = 0; index < totalCap; index += 1) {
    const item = items ? items[index] : undefined;
    const previous = state.iterations[state.iterations.length - 1] ?? null;
    const extras: LoopExtras = {
      loop: { index, item, last: previous },
    };

    if (node.while) {
      const continueLoop = await evaluateLoopCondition(node.while, run, extras, nodeId, 'while');
      if (!continueLoop) break;
    }

    const iteration = await runIteration(context, run, nodeId, node, index, item, extras);

    if (iteration.status === 'failed') {
      throw new Error(iteration.error ?? `Loop ${nodeId} iteration ${index} failed`);
    }

    if (node.until) {
      const stop = await evaluateLoopCondition(node.until, run, extras, nodeId, 'until');
      if (stop) break;
    }
  }

  state.output = JSON.stringify(state.iterations.map((iter) => iter.output ?? ''));
  state.exitCode = state.iterations.every((iter) => iter.exitCode === 0) ? 0 : undefined;
  addEvent(
    run,
    'node-output',
    `Loop ${nodeId} completed ${state.iterations.length} iteration${state.iterations.length === 1 ? '' : 's'}`,
    { iterations: state.iterations.length, output: state.output },
    nodeId,
  );
}

async function runIteration(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowLoopNode,
  index: number,
  item: unknown,
  extras: LoopExtras,
): Promise<WorkflowLoopIterationRecord> {
  const startedAt = Date.now();
  const state = run.nodes[nodeId];
  const record: WorkflowLoopIterationRecord = {
    index,
    status: 'running',
    startedAt,
    ...(item !== undefined ? { item } : {}),
  };
  state?.iterations?.push(record);
  addEvent(
    run,
    'loop-iteration-started',
    `Loop ${nodeId} iteration ${index} started`,
    { index, item },
    nodeId,
  );
  await context.saveAndEmit(run);

  const body = node.body;
  if (body.type === 'prompt') {
    return await runPromptIteration(context, run, nodeId, body, index, extras, record);
  }

  const cwd = resolveNodeCwd(
    run.directoryPath,
    await renderOptionalTemplate(body.cwd, run, extras),
  );
  const command = await renderTemplate(body.command, run, extras);
  const abort = context.shellAbortRegistry.create(run.id, `loop:${nodeId}:${index}`);
  try {
    const result = await runShellNode(command, {
      cwd,
      timeoutSeconds: body.timeoutSeconds,
      signal: abort.signal,
      onOutput: ({ source, chunk, output }) => {
        addEvent(
          run,
          'node-log',
          `Loop ${nodeId} iteration ${index} wrote ${source}`,
          { source, chunk, output, iteration: index },
          nodeId,
        );
        run.updatedAt = Date.now();
        void context.saveAndEmit(run);
      },
    });
    if (record.status === 'canceled') return record;
    const completedAt = Date.now();
    record.status = 'completed';
    record.completedAt = completedAt;
    record.output = result.output;
    record.exitCode = result.exitCode;
    addEvent(
      run,
      'loop-iteration-completed',
      `Loop ${nodeId} iteration ${index} completed`,
      { index, exitCode: result.exitCode, output: result.output },
      nodeId,
    );
    run.updatedAt = completedAt;
    await context.saveAndEmit(run);
    return record;
  } catch (error) {
    if (record.status === 'canceled') return record;
    const completedAt = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    record.status = 'failed';
    record.completedAt = completedAt;
    record.output = error instanceof ShellNodeError ? error.output : undefined;
    record.exitCode = error instanceof ShellNodeError ? (error.exitCode ?? undefined) : undefined;
    record.error = message;
    addEvent(
      run,
      'loop-iteration-failed',
      `Loop ${nodeId} iteration ${index} failed: ${message}`,
      { index, error: message },
      nodeId,
    );
    run.updatedAt = completedAt;
    await context.saveAndEmit(run);
    return record;
  } finally {
    abort.dispose();
  }
}

async function runPromptIteration(
  context: WorkflowNodeExecutorContext,
  run: WorkflowRunRecord,
  nodeId: string,
  body: Extract<WorkflowLoopNode['body'], { type: 'prompt' }>,
  index: number,
  extras: LoopExtras,
  record: WorkflowLoopIterationRecord,
): Promise<WorkflowLoopIterationRecord> {
  try {
    const result = await runWorkflowDaemonSession(context, {
      run,
      nodeId,
      target: record,
      prompt: await renderTemplate(body.prompt, run, extras),
      ...(body.agent ? { agent: body.agent } : {}),
      ...(body.model ? { model: body.model } : {}),
    });
    if (record.status === 'canceled') return record;
    record.status = 'completed';
    record.completedAt = Date.now();
    record.output = result.output;
    addEvent(
      run,
      'loop-iteration-completed',
      `Loop ${nodeId} iteration ${index} completed`,
      { index, sessionId: result.sessionId, output: result.output },
      nodeId,
    );
    run.updatedAt = record.completedAt;
    await context.saveAndEmit(run);
    return record;
  } catch (error) {
    if (record.status === 'canceled') return record;
    record.status = 'failed';
    record.completedAt = Date.now();
    record.error = error instanceof Error ? error.message : String(error);
    addEvent(
      run,
      'loop-iteration-failed',
      `Loop ${nodeId} iteration ${index} failed: ${record.error}`,
      { index, error: record.error },
      nodeId,
    );
    run.updatedAt = record.completedAt;
    await context.saveAndEmit(run);
    return record;
  }
}

async function resolveForeachItems(
  expression: string,
  run: WorkflowRunRecord,
  nodeId: string,
): Promise<unknown[]> {
  const context = buildExpressionContext(run);
  let value: unknown;
  try {
    value = await evaluateExpression(expression, context);
  } catch (error) {
    if (error instanceof WorkflowExpressionError) {
      throw new Error(`Loop ${nodeId} foreach expression failed: ${error.message}`);
    }
    throw error;
  }
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `Loop ${nodeId} foreach expression must resolve to an array (got ${typeof value})`,
    );
  }
  return value;
}

async function evaluateLoopCondition(
  expression: string,
  run: WorkflowRunRecord,
  extras: LoopExtras,
  nodeId: string,
  kind: 'while' | 'until',
): Promise<boolean> {
  const context = { ...buildExpressionContext(run), ...extras };
  try {
    return await evaluateConditionExpression(expression, context);
  } catch (error) {
    if (error instanceof WorkflowExpressionError) {
      throw new Error(`Loop ${nodeId} ${kind} expression failed: ${error.message}`);
    }
    throw error;
  }
}
