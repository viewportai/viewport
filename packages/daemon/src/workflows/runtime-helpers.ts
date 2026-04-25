import { spawn } from 'node:child_process';
import path from 'node:path';
import type {
  ParsedWorkflow,
  WorkflowNodeRunState,
  WorkflowRunEvent,
  WorkflowRunRecord,
} from './types.js';

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

export function renderOptionalTemplate(
  template: string | undefined,
  run: WorkflowRunRecord,
): string | undefined {
  return template ? renderTemplate(template, run) : undefined;
}

export function renderTemplate(template: string, run: WorkflowRunRecord): string {
  return template
    .replace(/\{\{\s*inputs\.([A-Za-z0-9_.-]+)\s*\}\}/g, (_, key: string) => {
      const value = run.inputs[key];
      return value === undefined ? '' : String(value);
    })
    .replace(/\{\{\s*outputs\.([A-Za-z0-9._/-]+)\s*\}\}/g, (_, nodeId: string) => {
      return run.nodes[nodeId]?.output ?? '';
    })
    .replace(
      /\{\{\s*nodes\.([A-Za-z0-9._/-]+)\.(output|status|sessionId|error)\s*\}\}/g,
      (_, nodeId: string, key: keyof WorkflowNodeRunState) => {
        const value = run.nodes[nodeId]?.[key];
        return value === undefined ? '' : String(value);
      },
    );
}

export async function runShellNode(
  command: string,
  options: {
    cwd: string;
    timeoutSeconds?: number;
    onOutput?: (event: { source: 'stdout' | 'stderr'; chunk: string; output: string }) => void;
  },
): Promise<ShellNodeResult> {
  return await new Promise<ShellNodeResult>((resolve, reject) => {
    const child = spawn('sh', ['-lc', command], {
      cwd: options.cwd,
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
