import path from 'node:path';
import { getFlag, hasFlag } from './args.js';
import { daemonFetch, isDaemonRunning } from './daemon-client.js';
import { isJsonMode, printJson } from './command-shared.js';
import { parseCsvList, parseTlsVerifyMode, transportFetch } from './network.js';
import {
  delay,
  listFlagValue,
  positiveIntFlagValue,
  safeText,
} from './workflow-managed-worker-util.js';
import type { WorkflowRunRecord } from '../workflows/types.js';
import {
  approvalActor,
  approvalExpectedActionDigest,
  approvalMessage,
  capabilityPayload,
  dataFrom,
  localRunToSyncPayload,
  progressSyncEveryMs,
  readRun,
} from './workflow-managed-worker-format.js';
import type {
  DirectoryInfo,
  ManagedAssignment,
  ManagedWorkerAccessMode,
  ManagedWorkerOptions,
  WorkerStats,
} from './workflow-managed-worker-types.js';

export async function workflowWorker(): Promise<void> {
  const options = resolveWorkerOptions();
  if (!(await isDaemonRunning())) {
    throw new Error('Daemon is not running. Start it first with `vpd start`.');
  }
  await validateDaemonAgentCapabilities(options);
  if (hasFlag('preflight')) {
    if (isJsonMode()) {
      printJson({
        command: 'workflow worker',
        ok: true,
        preflight: true,
        capabilities: options.capabilities,
      });
      return;
    }
    console.log('Workflow worker preflight passed.');
    return;
  }

  const stats: WorkerStats = { claimed: 0, completed: 0, blocked: 0, failed: 0 };
  let failed = false;
  try {
    do {
      await heartbeat(options, 'online', 'idle');
      const assignment = await claimAssignment(options);
      if (!assignment) {
        if (options.once) break;
        await delay(options.sleepSeconds * 1000);
        continue;
      }

      stats.claimed += 1;
      const localRun = await runAssignmentLocally(options, assignment);
      const synced = await syncLocalRun(
        options,
        assignment.id,
        localRun,
        assignment.assignment_claim_token,
      );
      if (synced.status === 'blocked') {
        stats.blocked += 1;
        if (!options.once) {
          const resumed = await waitForApprovalAndResume(
            options,
            assignment.id,
            localRun.id,
            assignment.assignment_claim_token,
          );
          stats.completed += resumed.status === 'completed' ? 1 : 0;
          stats.failed += resumed.status === 'failed' || resumed.status === 'canceled' ? 1 : 0;
        }
      } else if (synced.status === 'completed') {
        stats.completed += 1;
      } else if (synced.status === 'failed' || synced.status === 'canceled') {
        stats.failed += 1;
      }

      if (options.once || (options.maxRuns !== undefined && stats.claimed >= options.maxRuns)) {
        break;
      }
    } while (true);
  } catch (error) {
    failed = true;
    await safeHeartbeat(options, 'stale', 'degraded');
    throw error;
  } finally {
    await safeHeartbeat(options, 'offline', failed ? 'degraded' : 'offline');
  }

  if (isJsonMode()) {
    printJson({ command: 'workflow worker', ok: stats.failed === 0, stats });
    return;
  }
  console.log(
    `Workflow worker stopped. Claimed ${stats.claimed}, completed ${stats.completed}, blocked ${stats.blocked}, failed ${stats.failed}.`,
  );
}

async function validateDaemonAgentCapabilities(options: ManagedWorkerOptions): Promise<void> {
  if (options.capabilities.agents.length === 0) return;

  const response = await daemonFetch('/api/agents', {
    method: 'GET',
    timeoutMs: 30_000,
  });
  if (!response?.ok) {
    throw new Error(
      `Daemon request failed: ${response?.status ?? 'no response'} ${await safeText(response ?? undefined)}`,
    );
  }

  const body = (await response.json()) as {
    agents?: Array<string | { id?: unknown; available?: unknown }>;
  };
  const availableAgents = new Set(
    (body.agents ?? []).flatMap((agent) => {
      if (typeof agent === 'string') return [agent];
      if (!agent || typeof agent !== 'object') return [];
      if (agent.available === false) return [];
      return typeof agent.id === 'string' ? [agent.id] : [];
    }),
  );
  const missing = options.capabilities.agents.filter((agent) => !availableAgents.has(agent));
  if (missing.length === 0) return;

  throw new Error(
    `Daemon is missing workflow agent adapter(s): ${missing.join(
      ', ',
    )}. Start the daemon with the matching built-in agent installed, or configure a custom command agent with VIEWPORT_CUSTOM_AGENT_COMMAND.`,
  );
}

function resolveWorkerOptions(): ManagedWorkerOptions {
  const server =
    getFlag('server') ?? process.env['VIEWPORT_SERVER_URL'] ?? process.env['VPD_SERVER_URL'];
  const workspaceId =
    getFlag('workspace') ?? getFlag('resource') ?? process.env['VIEWPORT_WORKSPACE_ID'];
  const executorId = getFlag('executor') ?? process.env['VIEWPORT_MANAGED_EXECUTOR_ID'];
  const credential =
    getFlag('credential') ??
    process.env['VIEWPORT_MANAGED_EXECUTOR_TOKEN'] ??
    process.env['VPD_MANAGED_EXECUTOR_TOKEN'];

  if (!server || !workspaceId || !executorId || !credential) {
    throw new Error(
      'Usage: vpd workflow worker --server <url> --workspace <id> --executor <id> --credential <token> [--workdir <path>] [--once]',
    );
  }

  return {
    server: server.replace(/\/+$/, ''),
    workspaceId,
    executorId,
    credential,
    accessMode: managedWorkerAccessMode(
      getFlag('access-mode') ?? process.env['VIEWPORT_MANAGED_EXECUTOR_ACCESS_MODE'],
    ),
    runnerProfile:
      getFlag('runner-profile') ?? process.env['VIEWPORT_MANAGED_EXECUTOR_PROFILE'] ?? undefined,
    workdir: getFlag('workdir') ? path.resolve(getFlag('workdir')!) : undefined,
    leaseSeconds: positiveIntFlagValue(getFlag('lease')) ?? 300,
    sleepSeconds: positiveIntFlagValue(getFlag('sleep')) ?? 5,
    maxRuns: positiveIntFlagValue(getFlag('max-runs')),
    once: hasFlag('once'),
    capabilities: {
      agentCommand: getFlag('agent-command') ?? process.env['VIEWPORT_MANAGED_AGENT_COMMAND'],
      agents: listFlagValue(getFlag('agents')),
      models: listFlagValue(getFlag('models')),
      integrations: listFlagValue(getFlag('integrations')),
      secrets: listFlagValue(getFlag('secrets')),
    },
  };
}

async function heartbeat(
  options: ManagedWorkerOptions,
  status: 'online' | 'offline' | 'stale',
  healthStatus: 'idle' | 'busy' | 'degraded' | 'offline',
): Promise<void> {
  await platformJson(options, 'POST', 'heartbeat', {
    status,
    health_status: healthStatus,
    access_mode: options.accessMode,
    runner_profile: options.runnerProfile ?? null,
    runner_posture: {
      transport: { mode: options.accessMode },
      execution: { kind: 'customer-managed' },
      version: process.env['npm_package_version'] ?? null,
    },
    capabilities: capabilityPayload(options.capabilities),
  });
}

async function safeHeartbeat(
  options: ManagedWorkerOptions,
  status: 'online' | 'offline' | 'stale',
  healthStatus: 'idle' | 'busy' | 'degraded' | 'offline',
): Promise<void> {
  try {
    await heartbeat(options, status, healthStatus);
  } catch {
    // The worker is exiting or already degraded; do not mask the primary result.
  }
}

function managedWorkerAccessMode(value: string | undefined): ManagedWorkerAccessMode {
  if (value === 'polling' || value === 'direct' || value === 'relay') return value;
  return 'relay';
}

async function claimAssignment(options: ManagedWorkerOptions): Promise<ManagedAssignment | null> {
  const response = await platformFetch(options, 'POST', 'claim', {
    lease_seconds: options.leaseSeconds,
  });
  if (response.status === 204) return null;
  const body = await responseJson(response);
  return dataFrom(body) as ManagedAssignment;
}

async function runAssignmentLocally(
  options: ManagedWorkerOptions,
  assignment: ManagedAssignment,
): Promise<WorkflowRunRecord> {
  if (!assignment.yaml_snapshot) {
    throw new Error(`Managed workflow assignment ${assignment.id} is missing yaml_snapshot.`);
  }

  await heartbeat(options, 'online', 'busy');
  const existingRun = await readExistingLocalRun(assignment.runtime_run_id);
  if (existingRun) {
    return existingRun;
  }

  const directory = await ensureDirectory(
    options.workdir ?? assignment.directory_path ?? process.cwd(),
  );
  const started = await daemonJson('POST', '/api/workflows/runs', {
    workflowYaml: assignment.yaml_snapshot,
    workflowSourceRef: assignment.source_ref ?? `viewport://managed-executor/${assignment.id}`,
    directoryId: directory.id,
    inputs: assignment.input_snapshot ?? {},
    resourceId: options.workspaceId,
    runtimeTargetId: assignment.runtime_target_id ?? undefined,
    platformRunId: assignment.id,
    initiation: 'cli',
    dataCapturePolicy: assignment.data_capture_policy ?? undefined,
  });
  const runId = readRun(started).id;
  return pollLocalRun(
    runId,
    async (run) => {
      await syncLocalRun(options, assignment.id, run, assignment.assignment_claim_token);
    },
    progressSyncEveryMs(options.leaseSeconds),
  );
}

async function readExistingLocalRun(runId?: string | null): Promise<WorkflowRunRecord | null> {
  if (!runId) return null;
  const response = await daemonFetch(`/api/workflows/runs/${encodeURIComponent(runId)}`, {
    method: 'GET',
    timeoutMs: 30_000,
  });
  if (response?.status === 404) return null;
  if (!response?.ok) {
    throw new Error(
      `Daemon request failed: ${response?.status ?? 'no response'} ${await safeText(response ?? undefined)}`,
    );
  }
  return readRun(await response.json());
}

async function waitForApprovalAndResume(
  options: ManagedWorkerOptions,
  platformRunId: string,
  localRunId: string,
  assignmentClaimToken?: string | null,
): Promise<WorkflowRunRecord> {
  while (true) {
    await delay(options.sleepSeconds * 1000);
    await heartbeat(options, 'online', 'busy');
    const assignment = await getAssignment(options, platformRunId, assignmentClaimToken);
    const approved = assignment.nodes?.find(isApprovedManagedGateNode);
    if (approved) {
      await daemonJson(
        'POST',
        `/api/workflows/runs/${encodeURIComponent(localRunId)}/approvals/${encodeURIComponent(
          approved.node_key,
        )}`,
        {
          approved: true,
          message: approvalMessage(approved),
          actor: approvalActor(approved),
          expectedActionDigest: approvalExpectedActionDigest(approved),
        },
      );
      const resumed = await pollLocalRun(
        localRunId,
        async (run) => {
          await syncLocalRun(options, platformRunId, run, assignmentClaimToken);
        },
        progressSyncEveryMs(options.leaseSeconds),
      );
      await syncLocalRun(options, platformRunId, resumed, assignmentClaimToken);
      return resumed;
    }
    if (assignment.status === 'canceled' || assignment.status === 'failed') {
      const canceled = await daemonJson(
        'POST',
        `/api/workflows/runs/${encodeURIComponent(localRunId)}/cancel`,
        {
          message: 'Managed workflow assignment was canceled from Viewport.',
          actor: { name: 'Viewport', source: 'managed-executor' },
        },
      );
      const run = readRun(canceled);
      await syncLocalRun(options, platformRunId, run, assignmentClaimToken);
      return run;
    }
  }
}

function isApprovedManagedGateNode(node: NonNullable<ManagedAssignment['nodes']>[number]): boolean {
  if (!['approval', 'gate', 'plan', 'action'].includes(String(node.type ?? ''))) return false;
  if (node.status === 'completed') return true;
  if (node.type !== 'action' || node.status !== 'queued') return false;
  const approval = node.metadata?.['approval'];
  return (
    !!approval &&
    typeof approval === 'object' &&
    (approval as { approved?: unknown }).approved === true
  );
}

async function getAssignment(
  options: ManagedWorkerOptions,
  platformRunId: string,
  assignmentClaimToken?: string | null,
): Promise<ManagedAssignment> {
  const body = await platformJson(
    options,
    'GET',
    `workflow-runs/${encodeURIComponent(platformRunId)}`,
    undefined,
    assignmentClaimToken,
  );
  return dataFrom(body) as ManagedAssignment;
}

async function syncLocalRun(
  options: ManagedWorkerOptions,
  platformRunId: string,
  run: WorkflowRunRecord,
  assignmentClaimToken?: string | null,
): Promise<ManagedAssignment> {
  const body = await platformJson(
    options,
    'PATCH',
    `workflow-runs/${encodeURIComponent(platformRunId)}/sync`,
    localRunToSyncPayload(run),
    assignmentClaimToken,
  );
  return dataFrom(body) as ManagedAssignment;
}

async function ensureDirectory(directoryPath: string): Promise<DirectoryInfo> {
  const resolvedPath = path.resolve(directoryPath);
  const directories = (await daemonJson('GET', '/api/directories')) as DirectoryInfo[];
  const existing = directories.find((directory) => directory.path === resolvedPath);
  if (existing) return existing;
  const created = (await daemonJson('POST', '/api/directories', { path: resolvedPath })) as {
    id?: string;
  };
  if (!created.id) throw new Error(`Failed to register workflow worker directory: ${resolvedPath}`);
  return { id: created.id, path: resolvedPath };
}

async function pollLocalRun(
  runId: string,
  onProgress?: (run: WorkflowRunRecord) => Promise<void>,
  progressEveryMs = 30_000,
): Promise<WorkflowRunRecord> {
  let nextProgressAt = 0;
  while (true) {
    const body = await daemonJson('GET', `/api/workflows/runs/${encodeURIComponent(runId)}`);
    const run = readRun(body);
    if (['completed', 'failed', 'blocked', 'canceled'].includes(run.status)) return run;
    if (onProgress && Date.now() >= nextProgressAt) {
      await onProgress(run);
      nextProgressAt = Date.now() + progressEveryMs;
    }
    await delay(500);
  }
}

async function daemonJson(method: string, urlPath: string, body?: unknown): Promise<unknown> {
  const response = await daemonFetch(urlPath, {
    method,
    ...(body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
    timeoutMs: 30_000,
  });
  if (!response?.ok) {
    throw new Error(
      `Daemon request failed: ${response?.status ?? 'no response'} ${await safeText(response ?? undefined)}`,
    );
  }
  return response.json();
}

async function platformJson(
  options: ManagedWorkerOptions,
  method: string,
  pathSuffix: string,
  body?: unknown,
  assignmentClaimToken?: string | null,
): Promise<unknown> {
  return responseJson(await platformFetch(options, method, pathSuffix, body, assignmentClaimToken));
}

async function platformFetch(
  options: ManagedWorkerOptions,
  method: string,
  pathSuffix: string,
  body?: unknown,
  assignmentClaimToken?: string | null,
): Promise<Response> {
  const response = await transportFetch(`${baseManagedUrl(options)}/${pathSuffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${options.credential}`,
      Accept: 'application/json',
      ...(assignmentClaimToken ? { 'X-Viewport-Assignment-Claim': assignmentClaimToken } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    timeoutMs: 30_000,
    tlsVerify: parseTlsVerifyMode(process.env['VPD_SERVER_TLS_VERIFY']) ?? 'auto',
    caCertPath: process.env['VPD_SERVER_CA_CERT'],
    tlsPins: parseCsvList(process.env['VPD_SERVER_TLS_PINS']),
  });
  if (!response.ok && response.status !== 204) {
    throw new Error(`Platform request failed: HTTP ${response.status} ${await response.text()}`);
  }
  return response;
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  return response.json();
}

function baseManagedUrl(options: ManagedWorkerOptions): string {
  return `${options.server}/api/runtime/workspaces/${encodeURIComponent(
    options.workspaceId,
  )}/managed-executors/${encodeURIComponent(options.executorId)}`;
}
