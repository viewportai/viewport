import fs from 'node:fs/promises';
import path from 'node:path';
import { getArgs, getFlag, hasFlag } from './args.js';
import { daemonFetch, isDaemonRunning } from './daemon-client.js';
import { isJsonMode, printJson } from './command-shared.js';
import type { WorkflowInputValue } from '../workflows/types.js';
import { buildWorkflowRunJsonOutput, type WorkflowRunJsonInput } from './workflow-run-json.js';
import { resolveWorkflowRunTarget } from './workflow-contract-resolver.js';

export { buildWorkflowRunJsonOutput } from './workflow-run-json.js';

interface DirectoryInfo {
  id: string;
  path: string;
}

interface WorkflowRunResponse {
  run: WorkflowRunJsonInput;
}

interface DaemonAgentInventory {
  agents?: Array<string | { id?: unknown; available?: unknown; displayName?: unknown }>;
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
  if (subcommand === 'smoke') {
    await smokeWorkflow();
    return;
  }
  if (subcommand === 'agents') {
    await listWorkflowAgents();
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
  return 'Usage: vpd workflow <validate|run|smoke|agents|runs|show|rerun|approve|cancel> ...';
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
    'Usage: vpd workflow run <workflow-id|file> [--path <repo>] [--directory <repo>] [--input k=v] [--input-json k=json] [--json]',
  );
  const directory = await resolveDirectoryFromInput(getFlag('path') ?? getFlag('directory'));
  const resolvedTarget = resolveWorkflowRunTarget({
    workflowTarget: file,
    directoryPath: directory.path,
  });
  const inputs = parseInputs(getArgs());

  const started = (await postJson('/api/workflows/runs', {
    workflowPath: resolvedTarget.workflowPath,
    workflowContract: resolvedTarget.workflowContract,
    directoryId: directory.id,
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

async function smokeWorkflow(): Promise<void> {
  await ensureDaemonRunningOrThrow();
  const directory = await resolveDirectoryFromInput(getFlag('path') ?? getFlag('directory'));
  const agent = getFlag('agent');
  if (agent) await ensureAgentAvailableForSmoke(agent);
  const sentinel = `VIEWPORT_WORKFLOW_SMOKE_${Date.now()}`;
  const workflowYaml = agent
    ? agentSmokeWorkflowYaml(agent, sentinel)
    : shellSmokeWorkflowYaml(sentinel);

  const started = (await postJson('/api/workflows/runs', {
    workflowYaml,
    workflowSourceRef: 'viewport://workflow-smoke/local',
    directoryId: directory.id,
    inputs: { sentinel },
    initiation: 'cli',
  })) as WorkflowRunResponse;

  const completed =
    hasFlag('detach') || isTerminalWorkflowStatus(started.run.status)
      ? started
      : await pollWorkflowRun(started.run.id);
  if (isJsonMode()) {
    printJson({
      command: 'workflow smoke',
      ok: completed.run.status === 'completed',
      sentinel,
      ...buildWorkflowRunJsonOutput(completed.run),
    });
    return;
  }

  printRun(completed.run);
  if (completed.run.status === 'completed') {
    console.log(`Smoke:       ${sentinel}`);
  }
}

async function listWorkflowAgents(): Promise<void> {
  await ensureDaemonRunningOrThrow();
  const body = (await getJson('/api/agents')) as DaemonAgentInventory;
  const agents = body.agents ?? [];

  if (isJsonMode()) {
    printJson({ command: 'workflow agents', ok: true, agents });
    return;
  }

  if (agents.length === 0) {
    console.log('No workflow agents registered.');
    return;
  }

  console.log('Workflow agents:');
  for (const agent of agents) {
    if (typeof agent === 'string') {
      console.log(`- ${agent}  available`);
      continue;
    }
    const id = typeof agent.id === 'string' ? agent.id : 'unknown';
    const name = typeof agent.displayName === 'string' ? agent.displayName : id;
    const status = agent.available === false ? 'unavailable' : 'available';
    console.log(`- ${id}  ${status}  ${name}`);
  }
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
  const usage =
    'Usage: vpd workflow approve <run-id> <node-id> [--request-changes|--reject|--deny] [--expected-action-digest sha256:...] [--message <text>] [--json]';
  const runId = requiredArg(2, usage);
  const nodeId = requiredArg(3, usage);
  const decision = workflowApprovalDecisionFromFlags();
  const expectedActionDigest = getFlag('expected-action-digest') ?? getFlag('digest');
  const response = (await postJson(
    `/api/workflows/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(nodeId)}`,
    {
      approved: decision === 'approve',
      decision,
      ...(expectedActionDigest ? { expectedActionDigest } : {}),
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

function workflowApprovalDecisionFromFlags(): 'approve' | 'request_changes' | 'reject' {
  const negativeFlags = [hasFlag('request-changes'), hasFlag('reject'), hasFlag('deny')].filter(
    Boolean,
  ).length;
  if (negativeFlags > 1) {
    throw new Error('Use only one of --request-changes, --reject, or --deny.');
  }
  if (hasFlag('request-changes')) return 'request_changes';
  if (hasFlag('reject') || hasFlag('deny')) return 'reject';
  return 'approve';
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

function isTerminalWorkflowStatus(status: string): boolean {
  return ['completed', 'failed', 'blocked', 'canceled'].includes(status);
}

function shellSmokeWorkflowYaml(sentinel: string): string {
  return `schema: viewport.workflow/v1
name: viewport-smoke
title: Viewport workflow smoke
nodes:
  smoke:
    type: shell
    title: Local shell smoke
    command: ${JSON.stringify(`printf ${sentinel}`)}
`;
}

function agentSmokeWorkflowYaml(agent: string, sentinel: string): string {
  return `schema: viewport.workflow/v1
name: viewport-agent-smoke
title: Viewport agent smoke
requires:
  agents:
    - ${JSON.stringify(agent)}
nodes:
  smoke:
    type: agent
    agent: ${JSON.stringify(agent)}
    title: Agent smoke
    prompt: "Reply with exactly this sentinel: ${sentinel}"
`;
}

async function ensureAgentAvailableForSmoke(agentId: string): Promise<void> {
  const response = await daemonFetch('/api/agents', {
    method: 'GET',
    timeoutMs: 30_000,
  });
  if (!response?.ok) {
    throw new Error(`Daemon request failed: ${response?.status ?? 'no response'}`);
  }

  const body = (await response.json()) as DaemonAgentInventory;
  const availableAgents = new Set(
    (body.agents ?? []).flatMap((agent) => {
      if (typeof agent === 'string') return [agent];
      if (!agent || typeof agent !== 'object') return [];
      if (agent.available === false) return [];
      return typeof agent.id === 'string' ? [agent.id] : [];
    }),
  );
  if (availableAgents.has(agentId)) return;

  throw new Error(
    `Daemon cannot launch workflow agent '${agentId}'. Start the daemon with that built-in agent available, or configure VIEWPORT_CUSTOM_AGENT_COMMAND and VIEWPORT_CUSTOM_AGENT_ID=${agentId}.`,
  );
}

async function ensureDaemonRunningOrThrow(): Promise<void> {
  if (await isDaemonRunning()) return;
  throw new Error('Daemon is not running. Start it first with `vpd start`.');
}

async function resolveDirectoryFromInput(rawInput: string | undefined): Promise<DirectoryInfo> {
  const input = rawInput ?? process.cwd();
  const directories = (await getJson('/api/directories')) as DirectoryInfo[];
  const byId = directories.find((item) => item.id === input);
  if (byId) return byId;

  const resolvedPath = path.resolve(input);
  const stat = await fs.stat(resolvedPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolvedPath}`);
  }

  const byPath = directories.find((item) => item.path === resolvedPath);
  if (byPath) return byPath;

  const created = (await postJson('/api/directories', { path: resolvedPath })) as { id?: unknown };
  if (typeof created.id !== 'string') {
    throw new Error(`Failed to register directory: ${resolvedPath}`);
  }
  return { id: created.id, path: resolvedPath };
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
