import fs from 'node:fs/promises';
import path from 'node:path';
import { getArgs, getFlag, hasFlag } from './args.js';
import { daemonFetch, isDaemonRunning } from './daemon-client.js';
import { isJsonMode, printJson } from './command-shared.js';
import type { WorkflowInputValue } from '../workflows/types.js';
import { buildWorkflowRunJsonOutput, type WorkflowRunJsonInput } from './workflow-run-json.js';

export { buildWorkflowRunJsonOutput } from './workflow-run-json.js';

interface DirectoryInfo {
  id: string;
  path: string;
}

interface WorkflowRunResponse {
  run: WorkflowRunJsonInput;
}

export async function workflow(): Promise<void> {
  const subcommand = getArgs()[1];
  if (!subcommand) {
    showWorkflowHelp();
    return;
  }
  if (subcommand === 'validate') {
    await validateWorkflow();
    return;
  }
  if (subcommand === 'run') {
    await runWorkflow();
    return;
  }
  if (subcommand === 'runs') {
    await listWorkflowRuns();
    return;
  }
  if (subcommand === 'show') {
    await showWorkflowRun();
    return;
  }
  if (subcommand === 'rerun') {
    await rerunWorkflowRun();
    return;
  }
  if (subcommand === 'approve') {
    await approveWorkflowNode();
    return;
  }
  if (subcommand === 'cancel') {
    await cancelWorkflowRun();
    return;
  }
  throw new Error(workflowUsage());
}

function workflowUsage(): string {
  return 'Usage: vpd workflow <validate|run|runs|show|rerun|approve|cancel> ...';
}

function showWorkflowHelp(): void {
  console.log(workflowUsage());
}

async function validateWorkflow(): Promise<void> {
  await ensureDaemonRunningOrThrow();
  const file = requiredArg(2, 'Usage: vpd workflow validate <file> [--json]');
  const response = await postJson('/api/workflows/validate', {
    workflowPath: path.resolve(file),
  });

  if (isJsonMode()) {
    printJson({ command: 'workflow validate', ok: true, ...(response as Record<string, unknown>) });
    return;
  }

  const workflow = (response as { workflow?: { name?: string; digest?: string } }).workflow;
  console.log(`Workflow valid: ${workflow?.name ?? file}`);
  console.log(`Digest: ${workflow?.digest ?? 'unknown'}`);
}

async function runWorkflow(): Promise<void> {
  await ensureDaemonRunningOrThrow();
  const file = requiredArg(
    2,
    'Usage: vpd workflow run <file> [--directory <path>] [--input k=v] [--input-json k=json] [--json]',
  );
  const directoryId = await resolveDirectoryIdFromInput(getFlag('directory'));
  const inputs = parseInputs(getArgs());

  const started = (await postJson('/api/workflows/runs', {
    workflowPath: path.resolve(file),
    directoryId,
    inputs,
    initiation: 'cli',
  })) as WorkflowRunResponse;

  if (hasFlag('detach')) {
    printRun(started.run);
    return;
  }

  const completed = await pollWorkflowRun(started.run.id);
  printRun(completed.run);
}

async function listWorkflowRuns(): Promise<void> {
  await ensureDaemonRunningOrThrow();
  const response = await getJson('/api/workflows/runs');
  if (isJsonMode()) {
    printJson({ command: 'workflow runs', ok: true, ...(response as Record<string, unknown>) });
    return;
  }

  const runs = (response as { runs?: WorkflowRunResponse['run'][] }).runs ?? [];
  if (runs.length === 0) {
    console.log('No workflow runs found.');
    return;
  }
  for (const run of runs) {
    console.log(
      `${run.id}  ${run.status.padEnd(9)}  ${run.workflowName}  ${run.digest.slice(0, 12)}`,
    );
  }
}

async function showWorkflowRun(): Promise<void> {
  await ensureDaemonRunningOrThrow();
  const runId = requiredArg(2, 'Usage: vpd workflow show <run-id> [--json]');
  const response = await getJson(`/api/workflows/runs/${encodeURIComponent(runId)}`);
  if (isJsonMode()) {
    printJson({ command: 'workflow show', ok: true, ...(response as Record<string, unknown>) });
    return;
  }
  const run = (response as WorkflowRunResponse).run;
  printRun(run);
}

async function rerunWorkflowRun(): Promise<void> {
  await ensureDaemonRunningOrThrow();
  const runId = requiredArg(2, 'Usage: vpd workflow rerun <run-id> [--detach] [--json]');
  const started = (await postJson(
    `/api/workflows/runs/${encodeURIComponent(runId)}/rerun`,
    {},
  )) as WorkflowRunResponse;

  if (hasFlag('detach')) {
    printRun(started.run);
    return;
  }

  const completed = await pollWorkflowRun(started.run.id);
  printRun(completed.run);
}

async function approveWorkflowNode(): Promise<void> {
  await ensureDaemonRunningOrThrow();
  const runId = requiredArg(
    2,
    'Usage: vpd workflow approve <run-id> <node-id> [--deny] [--message <text>] [--json]',
  );
  const nodeId = requiredArg(
    3,
    'Usage: vpd workflow approve <run-id> <node-id> [--deny] [--message <text>] [--json]',
  );
  const response = (await postJson(
    `/api/workflows/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(nodeId)}`,
    {
      approved: !hasFlag('deny'),
      ...(getFlag('message') ? { message: getFlag('message') } : {}),
      actor: {
        name: 'Local CLI',
        source: 'vpd-cli',
      },
    },
  )) as WorkflowRunResponse;

  if (isJsonMode()) {
    printJson({ command: 'workflow approve', ok: true, ...response });
    return;
  }
  printRun(response.run);
}

async function cancelWorkflowRun(): Promise<void> {
  await ensureDaemonRunningOrThrow();
  const runId = requiredArg(2, 'Usage: vpd workflow cancel <run-id> [--message <text>] [--json]');
  const response = (await postJson(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, {
    ...(getFlag('message') ? { message: getFlag('message') } : {}),
    actor: {
      name: 'Local CLI',
      source: 'vpd-cli',
    },
  })) as WorkflowRunResponse;

  if (isJsonMode()) {
    printJson({ command: 'workflow cancel', ok: response.run.status === 'canceled', ...response });
    return;
  }
  printRun(response.run);
}

async function pollWorkflowRun(runId: string): Promise<WorkflowRunResponse> {
  while (true) {
    const response = (await getJson(
      `/api/workflows/runs/${encodeURIComponent(runId)}`,
    )) as WorkflowRunResponse;
    if (['completed', 'failed', 'blocked', 'canceled'].includes(response.run.status)) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function printRun(run: WorkflowRunResponse['run']): void {
  if (isJsonMode()) {
    printJson(buildWorkflowRunJsonOutput(run));
    return;
  }
  console.log(`Workflow run: ${run.id}`);
  console.log(`Status:       ${run.status}`);
  console.log(`Workflow:     ${run.workflowName}`);
  console.log(`Digest:       ${run.digest}`);
  if (run.error) console.log(`Error:        ${run.error}`);
  console.log(`Inspect:      vpd workflow show ${run.id}`);
}

async function ensureDaemonRunningOrThrow(): Promise<void> {
  if (await isDaemonRunning()) return;
  throw new Error('Daemon is not running. Start it first with `vpd start`.');
}

async function resolveDirectoryIdFromInput(rawInput: string | undefined): Promise<string> {
  const input = rawInput ?? process.cwd();
  const directories = (await getJson('/api/directories')) as DirectoryInfo[];
  const byId = directories.find((item) => item.id === input);
  if (byId) return byId.id;

  const resolvedPath = path.resolve(input);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolvedPath}`);
  }

  const byPath = directories.find((item) => item.path === resolvedPath);
  if (byPath) return byPath.id;

  const created = (await postJson('/api/directories', { path: resolvedPath })) as { id?: unknown };
  if (typeof created.id !== 'string') {
    throw new Error(`Failed to register directory: ${resolvedPath}`);
  }
  return created.id;
}

function requiredArg(index: number, usage: string): string {
  const value = getArgs()[index];
  if (!value || value.startsWith('--')) {
    throw new Error(usage);
  }
  return value;
}

function parseInputs(args: string[]): Record<string, WorkflowInputValue> {
  const inputs: Record<string, WorkflowInputValue> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--input' && args[index] !== '--input-json') continue;
    const raw = args[index + 1];
    if (!raw || !raw.includes('=')) {
      throw new Error(`Expected ${args[index]} key=value`);
    }
    const [key, ...rest] = raw.split('=');
    if (!key) {
      throw new Error(`Expected ${args[index]} key=value`);
    }
    const value = rest.join('=');
    inputs[key] =
      args[index] === '--input-json' ? parseJsonInputValue(value) : parseInputValue(value);
  }
  return inputs;
}

function parseInputValue(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const numberValue = Number(value);
  if (value.trim() !== '' && Number.isFinite(numberValue)) return numberValue;
  return value;
}

function parseJsonInputValue(value: string): WorkflowInputValue {
  try {
    return JSON.parse(value) as WorkflowInputValue;
  } catch {
    throw new Error(`Expected --input-json key=<valid-json>, received: ${value}`);
  }
}

async function getJson(urlPath: string): Promise<unknown> {
  const response = await daemonFetch(urlPath, { timeoutMs: 30_000 });
  if (!response?.ok) {
    throw new Error(`Daemon request failed: ${response?.status ?? 'no response'}`);
  }
  return response.json();
}

async function postJson(urlPath: string, body: unknown): Promise<unknown> {
  const response = await daemonFetch(urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });
  if (!response?.ok) {
    const detail = response ? await response.text() : 'no response';
    throw new Error(`Daemon request failed: ${response?.status ?? 'no response'} ${detail}`);
  }
  return response.json();
}
