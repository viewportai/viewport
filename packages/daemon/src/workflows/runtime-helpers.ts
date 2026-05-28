import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  buildExpressionContext,
  evaluateExpression,
  renderTemplateString,
  WorkflowExpressionError,
} from './expression.js';
import { cleanChildProcessEnv } from '../security/child-env.js';
import type {
  ParsedWorkflow,
  WorkflowInputValue,
  WorkflowRunEvent,
  WorkflowRunRecord,
} from './types.js';

const MAX_OUTPUT_CHARS = 32_000;
const MAX_LOG_CHUNK_CHARS = 4_000;
export const WORKFLOW_PROCESS_NODE_DEFAULT_TIMEOUT_SECONDS = 600;

export interface ShellNodeResult {
  output: string;
  exitCode: number;
}

export class ShellNodeError extends Error {
  constructor(
    message: string,
    readonly output: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'ShellNodeError';
  }
}

export function normalizeInputs(
  parsed: ParsedWorkflow,
  provided: Record<string, WorkflowInputValue>,
): Record<string, WorkflowInputValue> {
  const result: Record<string, WorkflowInputValue> = {};
  for (const [key, definition] of Object.entries(parsed.definition.inputs ?? {})) {
    const value = provided[key] ?? definition.default;
    if (value === undefined) {
      if (definition.required) {
        throw new Error(`Missing required workflow input: ${key}`);
      }
      continue;
    }
    result[key] = value;
  }
  for (const [key, value] of Object.entries(provided)) {
    if (!(key in result)) result[key] = value;
  }
  return result;
}

export function addEvent(
  run: WorkflowRunRecord,
  type: WorkflowRunEvent['type'],
  message: string,
  data?: Record<string, unknown>,
  nodeId?: string,
): void {
  run.events.push({
    id: crypto.randomUUID(),
    runId: run.id,
    timestamp: Date.now(),
    type,
    nodeId,
    message,
    data,
  });
}

export function resolveNodeCwd(directoryPath: string, cwd?: string): string {
  if (!cwd) return directoryPath;
  return path.isAbsolute(cwd) ? cwd : path.join(directoryPath, cwd);
}

export async function renderOptionalTemplate(
  template: string | undefined,
  run: WorkflowRunRecord,
  extras?: Record<string, unknown>,
): Promise<string | undefined> {
  return template !== undefined ? await renderTemplate(template, run, extras) : undefined;
}

/**
 * Render a workflow template by replacing `{{ <jsonata> }}` placeholders. The
 * legacy patterns (`{{ inputs.X }}`, `{{ nodes.X.output }}`, `{{ outputs.X }}`,
 * `{{ artifacts.X.Y }}`) all evaluate as JSONata path expressions over the run
 * context, so existing workflows keep working while authors gain the full
 * JSONata expression language for new templates.
 *
 * Backwards-compat shims:
 *   - `outputs.X` → rewritten to `nodes.X.output` (legacy alias).
 *   - `artifacts.X.Y` → rewritten to a synthetic accessor that maps the run's
 *     artifact list back into `<nodeId>.<artifactName>` shape.
 */
export async function renderTemplate(
  template: string,
  run: WorkflowRunRecord,
  extras?: Record<string, unknown>,
): Promise<string> {
  const rewritten = applyLegacyTemplateAliases(template);
  const context = { ...buildArtifactAwareContext(run), ...(extras ?? {}) };
  try {
    return await renderTemplateString(rewritten, context);
  } catch (error) {
    if (error instanceof WorkflowExpressionError) {
      throw new Error(`Template expression failed (${error.expression}): ${error.message}`);
    }
    throw error;
  }
}

/**
 * Render shell command templates without letting workflow inputs/outputs become
 * raw shell syntax. Unquoted placeholder values are shell-quoted argv fragments.
 * Placeholders inside double quotes are escaped for that shell context so
 * substitutions such as $() and backticks remain literal text.
 */
export async function renderShellCommandTemplate(
  template: string,
  run: WorkflowRunRecord,
  extras?: Record<string, unknown>,
): Promise<string> {
  const rewritten = applyLegacyTemplateAliases(template);
  const context = { ...buildArtifactAwareContext(run), ...(extras ?? {}) };
  const placeholderPattern = /\{\{\s*([\s\S]+?)\s*\}\}/g;
  const matches: Array<{
    index: number;
    length: number;
    expression: string;
    insideDoubleQuotes: boolean;
  }> = [];
  let match: RegExpExecArray | null;
  while ((match = placeholderPattern.exec(rewritten)) !== null) {
    matches.push({
      index: match.index,
      length: match[0].length,
      expression: match[1] ?? '',
      insideDoubleQuotes: isInsideDoubleQuotedShellSpan(rewritten, match.index),
    });
  }
  if (matches.length === 0) return rewritten;

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
    result += rewritten.slice(cursor, entry.index);
    const rendered = stringifyShellTemplateValue(resolved[idx]);
    result += entry.insideDoubleQuotes ? shellDoubleQuoteEscape(rendered) : shellQuote(rendered);
    cursor = entry.index + entry.length;
  });
  result += rewritten.slice(cursor);
  return result;
}

const LEGACY_OUTPUTS_PATTERN = /\{\{\s*outputs\.([A-Za-z0-9._/-]+)\s*\}\}/g;
const LEGACY_ARTIFACTS_PATTERN = /\{\{\s*artifacts\.([A-Za-z0-9._/-]+)\.([A-Za-z0-9._/-]+)\s*\}\}/g;

function applyLegacyTemplateAliases(template: string): string {
  return template
    .replace(LEGACY_OUTPUTS_PATTERN, (_match, nodeId: string) => `{{ nodes.${nodeId}.output }}`)
    .replace(
      LEGACY_ARTIFACTS_PATTERN,
      (_match, nodeId: string, name: string) =>
        `{{ artifacts[nodeId='${nodeId}' and name='${name}'].path }}`,
    );
}

function isInsideDoubleQuotedShellSpan(value: string, offset: number): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let idx = 0; idx < offset; idx += 1) {
    const char = value[idx];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    }
  }
  return inDouble;
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellDoubleQuoteEscape(value: string): string {
  return value.replace(/["\\$`]/g, (char) => `\\${char}`);
}

function stringifyShellTemplateValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildArtifactAwareContext(run: WorkflowRunRecord) {
  const base = buildExpressionContext(run);
  return {
    ...base,
    artifacts: (run.artifacts ?? []).map((artifact) => ({
      nodeId: artifact.nodeId,
      name: artifact.name,
      path: artifact.path,
      kind: artifact.kind ?? null,
    })),
  };
}

export async function runShellNode(
  command: string,
  options: {
    cwd: string;
    timeoutSeconds?: number;
    /** Extra environment variables merged into a scrubbed child environment. */
    env?: Record<string, string>;
    signal?: AbortSignal;
    onOutput?: (event: { source: 'stdout' | 'stderr'; chunk: string; output: string }) => void;
  },
): Promise<ShellNodeResult> {
  return await runProcessNode('sh', ['-lc', command], options);
}

export async function runArgvNode(
  argv: string[],
  options: {
    cwd: string;
    timeoutSeconds?: number;
    /** Extra environment variables merged into a scrubbed child environment. */
    env?: Record<string, string>;
    signal?: AbortSignal;
    onOutput?: (event: { source: 'stdout' | 'stderr'; chunk: string; output: string }) => void;
  },
): Promise<ShellNodeResult> {
  const [file, ...args] = argv;
  if (!file || file.trim() === '') {
    throw new ShellNodeError('Structured argv command is empty', '', null);
  }
  return await runProcessNode(file, args, options);
}

async function runProcessNode(
  file: string,
  args: string[],
  options: {
    cwd: string;
    timeoutSeconds?: number;
    /** Extra environment variables merged into a scrubbed child environment. */
    env?: Record<string, string>;
    signal?: AbortSignal;
    onOutput?: (event: { source: 'stdout' | 'stderr'; chunk: string; output: string }) => void;
  },
): Promise<ShellNodeResult> {
  return await new Promise<ShellNodeResult>((resolve, reject) => {
    const timeoutSeconds = options.timeoutSeconds ?? WORKFLOW_PROCESS_NODE_DEFAULT_TIMEOUT_SECONDS;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: cleanChildProcessEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let aborted = options.signal?.aborted ?? false;

    const killChild = (signal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to killing only the shell below.
        }
      }
      child.kill(signal);
    };

    const append =
      (source: 'stdout' | 'stderr') =>
      (chunk: Buffer): void => {
        const text = chunk.toString('utf-8');
        output = `${output}${text}`.slice(-MAX_OUTPUT_CHARS);
        options.onOutput?.({
          source,
          chunk: text.slice(-MAX_LOG_CHUNK_CHARS),
          output: output.trim(),
        });
      };

    child.stdout.on('data', append('stdout'));
    child.stderr.on('data', append('stderr'));
    child.once('error', reject);
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      const trimmedOutput = output.trim();
      if (aborted) {
        reject(new ShellNodeError('Shell node canceled', trimmedOutput, null));
      } else if (code === 0) {
        resolve({ output: trimmedOutput, exitCode: 0 });
      } else {
        reject(
          new ShellNodeError(
            `Shell node exited with code ${code}: ${trimmedOutput}`,
            trimmedOutput,
            code,
          ),
        );
      }
    });

    const abort = (): void => {
      if (aborted) return;
      aborted = true;
      killChild('SIGTERM');
      killTimer = setTimeout(() => killChild('SIGKILL'), 2_000);
    };

    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    if (timeoutSeconds) {
      timer = setTimeout(() => {
        aborted = true;
        killChild('SIGTERM');
        killTimer = setTimeout(() => killChild('SIGKILL'), 2_000);
        reject(
          new ShellNodeError(`Shell node timed out after ${timeoutSeconds}s`, output.trim(), null),
        );
      }, timeoutSeconds * 1000);
    }
  });
}
