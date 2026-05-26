import jsonata from 'jsonata';
import type { WorkflowInputValue, WorkflowRunRecord } from './types.js';

/**
 * The evaluation context exposed to JSONata expressions and `{{ ... }}` template
 * interpolations. Keep this shape stable — every workflow author and plugin
 * relies on it.
 *
 * - `inputs`: the run's normalized inputs.
 * - `nodes.<id>.status`: the current node lifecycle status.
 * - `nodes.<id>.output`: the bulk text output (single string, capped).
 * - `nodes.<id>.outputs`: the structured outputs the node declared, if any.
 * - `nodes.<id>.error`: the failure message, if the node failed.
 * - `nodes.<id>.sessionId`, `nativeSessionId`, `worktreePath`: session
 *   provenance for prompt nodes.
 */
export interface ExpressionContext {
  run: {
    id: string;
    status: string;
  };
  inputs: Record<string, WorkflowInputValue>;
  nodes: Record<string, NodeContextEntry>;
}

export interface NodeContextEntry {
  status: string;
  output: string | null;
  outputs: Record<string, unknown>;
  error: string | null;
  sessionId: string | null;
  nativeSessionId: string | null;
  worktreePath: string | null;
  approval: {
    prompt: string;
    message: string | null;
    approved: boolean | null;
    feedback: Record<string, unknown> | null;
    requestedAt: number;
    resolvedAt: number | null;
  } | null;
}

export class WorkflowExpressionError extends Error {
  constructor(
    message: string,
    readonly expression: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WorkflowExpressionError';
  }
}

/**
 * Evaluate a single JSONata expression against the run context.
 *
 * Returns the raw JSONata result. Caller decides how to coerce — for `when:`
 * a boolean is expected; for templating the result is stringified.
 *
 * Throws WorkflowExpressionError with the original expression text attached so
 * the caller can build clean validation diagnostics.
 */
export async function evaluateExpression(
  expression: string,
  context: ExpressionContext,
): Promise<unknown> {
  let compiled: ReturnType<typeof jsonata>;
  try {
    compiled = jsonata(expression);
  } catch (error) {
    throw new WorkflowExpressionError(
      `Could not compile expression: ${error instanceof Error ? error.message : String(error)}`,
      expression,
      error,
    );
  }

  try {
    return await compiled.evaluate(context);
  } catch (error) {
    throw new WorkflowExpressionError(
      `Expression evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      expression,
      error,
    );
  }
}

/**
 * Treat the result of an expression as a boolean. JSONata returns undefined
 * when a path matches nothing, which we read as `false` so unguarded refs are
 * safe in `when:` clauses.
 */
export async function evaluateConditionExpression(
  expression: string,
  context: ExpressionContext,
): Promise<boolean> {
  const value = await evaluateExpression(expression, context);
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  return Boolean(value);
}

/**
 * Render a template string by replacing every `{{ <expression> }}` block with
 * the JSONata-evaluated result. Whitespace inside the braces is trimmed.
 *
 * Stringification rules:
 *   - undefined / null -> empty string
 *   - string -> as is
 *   - boolean / number -> String(...)
 *   - object / array -> JSON.stringify (so prompts can cleanly embed structured output)
 */
export async function renderTemplateString(
  template: string,
  context: ExpressionContext,
): Promise<string> {
  const placeholderPattern = /\{\{\s*([\s\S]+?)\s*\}\}/g;
  const matches: Array<{ index: number; length: number; expression: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = placeholderPattern.exec(template)) !== null) {
    const expression = match[1] ?? '';
    matches.push({ index: match.index, length: match[0].length, expression });
  }
  if (matches.length === 0) return template;

  const resolved = await Promise.all(
    matches.map((entry) =>
      evaluateExpression(entry.expression, context).catch((error) => {
        if (error instanceof WorkflowExpressionError) throw error;
        throw new WorkflowExpressionError(
          error instanceof Error ? error.message : String(error),
          entry.expression,
          error,
        );
      }),
    ),
  );

  let result = '';
  let cursor = 0;
  matches.forEach((entry, idx) => {
    result += template.slice(cursor, entry.index);
    result += stringifyTemplateValue(resolved[idx]);
    cursor = entry.index + entry.length;
  });
  result += template.slice(cursor);
  return result;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Build the expression context for a workflow run. Pure function — accepts the
 * run record and returns a fresh context. The runner calls this each time it
 * needs to re-evaluate (which is cheap; no deep clones).
 */
export function buildExpressionContext(run: WorkflowRunRecord): ExpressionContext {
  const nodes: Record<string, NodeContextEntry> = {};
  for (const node of Object.values(run.nodes)) {
    nodes[node.id] = {
      status: node.status,
      output: node.output ?? null,
      outputs: node.outputs ?? {},
      error: node.error ?? null,
      sessionId: node.sessionId ?? null,
      nativeSessionId: node.nativeSessionId ?? null,
      worktreePath: node.worktreePath ?? null,
      approval: node.approval
        ? {
            prompt: node.approval.prompt,
            message: node.approval.message ?? null,
            approved: node.approval.approved ?? null,
            feedback: node.approval.feedback ?? null,
            requestedAt: node.approval.requestedAt,
            resolvedAt: node.approval.resolvedAt ?? null,
          }
        : null,
    };
  }
  return { run: { id: run.id, status: run.status }, inputs: { ...run.inputs }, nodes };
}
