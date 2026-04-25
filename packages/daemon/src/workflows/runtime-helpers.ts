import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  buildExpressionContext,
  renderTemplateString,
  WorkflowExpressionError,
} from './expression.js';
import type { ParsedWorkflow, WorkflowRunEvent, WorkflowRunRecord } from './types.js';

const MAX_OUTPUT_CHARS = 32_000;
const MAX_LOG_CHUNK_CHARS = 4_000;

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
  provided: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
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
    /** Extra environment variables merged with process.env for this child. */
    env?: Record<string, string>;
    onOutput?: (event: { source: 'stdout' | 'stderr'; chunk: string; output: string }) => void;
  },
): Promise<ShellNodeResult> {
  return await new Promise<ShellNodeResult>((resolve, reject) => {
    const child = spawn('sh', ['-lc', command], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

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
      const trimmedOutput = output.trim();
      if (code === 0) {
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

    if (options.timeoutSeconds) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(
          new ShellNodeError(
            `Shell node timed out after ${options.timeoutSeconds}s`,
            output.trim(),
            null,
          ),
        );
      }, options.timeoutSeconds * 1000);
    }
  });
}
