import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getArgs, getFlag, hasFlag } from './args.js';
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
  executeProviderAction,
  WorkflowActionError,
} from '../workflows/action-provider-adapters.js';
import { envNameForCredentialRef } from '../workflows/action-provider-utils.js';
import { sanitizeActionInput } from '../workflows/action-digest.js';
import type { WorkflowActionNode, WorkflowInputValue } from '../workflows/types.js';
import {
  approvalActor,
  approvalExecutionGrant,
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
  ManagedActionReplayAssignment,
  ManagedWorkerAccessMode,
  ManagedWorkerOptions,
  WorkerStats,
} from './workflow-managed-worker-types.js';

export async function workflowWorker(): Promise<void> {
  if (hasFlag('help') || getArgs().includes('-h')) {
    console.log(workflowWorkerUsage());
    return;
  }

  const options = resolveWorkerOptions();
  if (!(await isDaemonRunning())) {
    throw new Error('Daemon is not running. Start it first with `vpd start`.');
  }
  await validateDaemonAgentCapabilities(options);
  if (hasFlag('doctor')) {
    await heartbeat(options, 'online', 'idle');
    await safeHeartbeat(options, 'offline', 'offline');
    if (isJsonMode()) {
      printJson({
        command: 'workflow worker doctor',
        ok: true,
        accessMode: options.accessMode,
        runnerProfile: options.runnerProfile ?? null,
        runnerPool: options.runnerPool ?? null,
        capabilities: options.capabilities,
      });
      return;
    }
    console.log('Workflow worker doctor passed.');
    return;
  }
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

  const stats: WorkerStats = {
    claimed: 0,
    actionReplaysClaimed: 0,
    actionReplaysCompleted: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
  };
  let failed = false;
  try {
    do {
      await heartbeat(options, 'online', 'idle');
      const assignment = await claimAssignment(options);
      if (!assignment) {
        const actionReplay = await claimActionReplay(options);
        if (actionReplay) {
          stats.actionReplaysClaimed += 1;
          const completedReplay = await completeActionReplay(options, actionReplay);
          if (completedReplay.status === 'completed') {
            stats.actionReplaysCompleted += 1;
            stats.completed += 1;
          } else {
            stats.failed += 1;
          }
          if (
            options.once ||
            (options.maxRuns !== undefined && totalClaimed(stats) >= options.maxRuns)
          ) {
            break;
          }
          continue;
        }
        if (options.once) break;
        await delay(options.sleepSeconds * 1000);
        continue;
      }

      stats.claimed += 1;
      const localRun = await runAssignmentLocally(options, assignment);
      if (localRun.status === 'blocked' && !options.once) {
        const approved = await approvedNodeForAssignment(
          options,
          assignment.id,
          assignment.assignment_claim_token,
        );
        if (approved) {
          const resumed = await resumeApprovedLocalRun(
            options,
            assignment.id,
            localRun.id,
            approved,
            assignment.assignment_claim_token,
          );
          stats.completed += resumed.status === 'completed' ? 1 : 0;
          stats.failed += resumed.status === 'failed' || resumed.status === 'canceled' ? 1 : 0;

          if (options.maxRuns !== undefined && totalClaimed(stats) >= options.maxRuns) {
            break;
          }
          continue;
        }
      }
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

      if (
        options.once ||
        (options.maxRuns !== undefined && totalClaimed(stats) >= options.maxRuns)
      ) {
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
    `Workflow worker stopped. Claimed ${stats.claimed} workflow run(s), replayed ${stats.actionReplaysCompleted}/${stats.actionReplaysClaimed} action(s), completed ${stats.completed}, blocked ${stats.blocked}, failed ${stats.failed}.`,
  );
}

function totalClaimed(stats: WorkerStats): number {
  return stats.claimed + stats.actionReplaysClaimed;
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
  const registrationProfile = readRegistrationProfile();
  const server =
    getFlag('server') ??
    process.env['VIEWPORT_SERVER_URL'] ??
    process.env['VPD_SERVER_URL'] ??
    registrationProfile?.serverUrl;
  const workspaceId =
    getFlag('workspace') ??
    getFlag('resource') ??
    process.env['VIEWPORT_WORKSPACE_ID'] ??
    registrationProfile?.workspaceId;
  const executorId =
    getFlag('executor') ??
    process.env['VIEWPORT_MANAGED_EXECUTOR_ID'] ??
    registrationProfile?.executorId;
  const credential =
    getFlag('credential') ??
    process.env['VIEWPORT_MANAGED_EXECUTOR_TOKEN'] ??
    process.env['VPD_MANAGED_EXECUTOR_TOKEN'] ??
    registrationProfile?.credential;

  if (!server || !workspaceId || !executorId || !credential) {
    throw new Error(workflowWorkerUsage());
  }
  const profileCapabilities = registrationProfile?.capabilities ?? {};
  const profileRunnerPool =
    stringValue(profileCapabilities['runner_pool']) ??
    stringValue(profileCapabilities['runnerPool']);

  return {
    server: server.replace(/\/+$/, ''),
    workspaceId,
    executorId,
    credential,
    accessMode: managedWorkerAccessMode(
      getFlag('access-mode') ??
        process.env['VIEWPORT_MANAGED_EXECUTOR_ACCESS_MODE'] ??
        registrationProfile?.accessMode,
    ),
    runnerProfile:
      getFlag('runner-profile') ??
      process.env['VIEWPORT_MANAGED_EXECUTOR_PROFILE'] ??
      registrationProfile?.runnerProfile ??
      undefined,
    runnerPosture: registrationProfile?.runnerPosture,
    runnerPool:
      getFlag('runner-pool') ??
      process.env['VIEWPORT_MANAGED_RUNNER_POOL'] ??
      process.env['VIEWPORT_MANAGED_EXECUTOR_RUNNER_POOL'] ??
      profileRunnerPool ??
      undefined,
    workdir: getFlag('workdir') ? path.resolve(getFlag('workdir')!) : undefined,
    leaseSeconds: positiveIntFlagValue(getFlag('lease')) ?? 300,
    sleepSeconds: positiveIntFlagValue(getFlag('sleep')) ?? 5,
    maxRuns: positiveIntFlagValue(getFlag('max-runs')),
    once: hasFlag('once'),
    capabilities: {
      runnerPool:
        getFlag('runner-pool') ??
        process.env['VIEWPORT_MANAGED_RUNNER_POOL'] ??
        process.env['VIEWPORT_MANAGED_EXECUTOR_RUNNER_POOL'] ??
        profileRunnerPool ??
        undefined,
      agentCommand: getFlag('agent-command') ?? process.env['VIEWPORT_MANAGED_AGENT_COMMAND'],
      actionCommand: getFlag('action-command') ?? process.env['VIEWPORT_MANAGED_ACTION_COMMAND'],
      providerActions:
        hasFlag('provider-actions') || process.env['VIEWPORT_MANAGED_PROVIDER_ACTIONS'] === '1',
      tools: listFlagOrProfile('tools', profileCapabilities['tools']),
      agents: listFlagOrProfile('agents', profileCapabilities['agents']),
      models: listFlagOrProfile('models', profileCapabilities['models']),
      integrations: listFlagOrProfile('integrations', profileCapabilities['integrations']),
      secrets: listFlagOrProfile('secrets', profileCapabilities['secrets']),
    },
  };
}

function workflowWorkerUsage(): string {
  return 'Usage: vpd workflow worker --server <url> --workspace <id> --executor <id> --credential <token> [--workdir <path>] [--runner-pool <pool>] [--agent-command <command>] [--action-command <command>] [--provider-actions] [--doctor|--preflight|--once]\n       vpd workflow worker --registration-profile <path> [--doctor|--preflight|--once]';
}

interface RegistrationProfile {
  serverUrl?: string;
  workspaceId?: string;
  executorId?: string;
  credential?: string;
  accessMode?: string;
  runnerProfile?: string;
  runnerPosture?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
}

function readRegistrationProfile(): RegistrationProfile | null {
  const profilePath =
    getFlag('registration-profile') ?? process.env['VIEWPORT_MANAGED_EXECUTOR_PROFILE_FILE'];
  if (!profilePath) return null;

  const resolved = resolveProfilePath(profilePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Managed executor registration profile is not a JSON object: ${resolved}`);
  }
  const record = parsed as Record<string, unknown>;
  const schema = stringValue(record['schema']);
  if (schema && schema !== 'viewport.managed_executor_registration/v1') {
    throw new Error(`Unsupported managed executor registration profile schema: ${schema}`);
  }

  return {
    serverUrl: stringValue(record['server_url']) ?? stringValue(record['serverUrl']),
    workspaceId: stringValue(record['workspace_id']) ?? stringValue(record['workspaceId']),
    executorId:
      stringValue(record['managed_executor_id']) ??
      stringValue(record['executor_id']) ??
      stringValue(record['executorId']),
    credential: stringValue(record['credential']),
    accessMode: stringValue(record['access_mode']) ?? stringValue(record['accessMode']),
    runnerProfile: stringValue(record['runner_profile']) ?? stringValue(record['runnerProfile']),
    runnerPosture: recordValue(record['runner_posture']) ?? recordValue(record['runnerPosture']),
    capabilities:
      record['capabilities'] &&
      typeof record['capabilities'] === 'object' &&
      !Array.isArray(record['capabilities'])
        ? (record['capabilities'] as Record<string, unknown>)
        : undefined,
  };
}

function resolveProfilePath(profilePath: string): string {
  if (profilePath === '~') return os.homedir();
  if (profilePath.startsWith('~/')) return path.join(os.homedir(), profilePath.slice(2));
  return path.resolve(profilePath);
}

function listFlagOrProfile(flag: string, profileValue: unknown): string[] {
  const fromFlag = listFlagValue(getFlag(flag));
  return fromFlag.length > 0 ? fromFlag : stringList(profileValue);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
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
      ...(options.runnerPosture ?? {}),
      transport: {
        ...recordValue(options.runnerPosture?.['transport']),
        mode: options.accessMode,
      },
      execution: recordValue(options.runnerPosture?.['execution']) ?? { kind: 'customer-managed' },
      version:
        stringValue(options.runnerPosture?.['version']) ??
        process.env['npm_package_version'] ??
        null,
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

async function claimActionReplay(
  options: ManagedWorkerOptions,
): Promise<ManagedActionReplayAssignment | null> {
  if (
    (!options.capabilities.actionCommand && !options.capabilities.providerActions) ||
    options.capabilities.integrations.length === 0
  ) {
    return null;
  }

  const response = await platformFetch(options, 'POST', 'action-replays/claim', {
    lease_seconds: options.leaseSeconds,
  });
  if (response.status === 204) return null;
  const body = await responseJson(response);
  return dataFrom(body) as ManagedActionReplayAssignment;
}

async function completeActionReplay(
  options: ManagedWorkerOptions,
  assignment: ManagedActionReplayAssignment,
): Promise<ManagedActionReplayAssignment> {
  if (!options.capabilities.actionCommand && !options.capabilities.providerActions) {
    throw new Error('Action replay execution is not configured.');
  }
  if (!assignment.claim_token) {
    throw new Error(`Managed action replay ${assignment.id} is missing claim_token.`);
  }

  await heartbeat(options, 'online', 'busy');
  const result = options.capabilities.actionCommand
    ? await runActionReplayCommand(options.capabilities.actionCommand, assignment)
    : await runProviderActionReplay(assignment);
  const body = await platformJson(
    options,
    'PATCH',
    `action-replays/${encodeURIComponent(assignment.id)}/complete`,
    result,
    undefined,
    { 'X-Viewport-Action-Replay-Claim': assignment.claim_token },
  );
  return dataFrom(body) as ManagedActionReplayAssignment;
}

async function runProviderActionReplay(
  assignment: ManagedActionReplayAssignment,
): Promise<Record<string, unknown>> {
  const actionInput = actionInputFromReplay(assignment);
  if (!actionInput) {
    return {
      status: 'failed',
      idempotency_key: assignment.idempotency_key ?? undefined,
      payload_digest: assignment.action_digest ?? undefined,
      provider_response: assignment.provider_response ?? undefined,
      error: 'Action replay is missing the original action proposal payload.',
    };
  }

  const nodeId =
    assignment.action_proposal?.node_key ?? assignment.workflow_run_node_id ?? assignment.id;
  const node: WorkflowActionNode = {
    type: 'action',
    adapter: assignment.adapter,
    action: normalizeReplayAction(assignment.adapter, assignment.action),
    with: actionInput,
    idempotencyKey: assignment.idempotency_key ?? undefined,
    requiresApproval: false,
  };
  const run = actionReplayRunRecord(assignment);

  try {
    const result = await executeProviderAction(run, nodeId, node, actionInput, {
      idempotencyKey: assignment.idempotency_key ?? undefined,
    });
    if (!result) {
      return {
        status: 'failed',
        idempotency_key: assignment.idempotency_key ?? undefined,
        payload_digest: assignment.action_digest ?? undefined,
        provider_response: assignment.provider_response ?? undefined,
        error: `No built-in provider action adapter exists for ${assignment.adapter}.${assignment.action}.`,
      };
    }
    const action = recordValue(result.metadata['action']);
    const response = recordValue(action?.['response']);
    const providerReconciliation =
      recordValue(action?.['provider_reconciliation']) ??
      recordValue(action?.['providerReconciliation']);
    return {
      status: 'succeeded',
      provider_reference: replayProviderReference(response),
      provider_url: replayProviderUrl(response),
      idempotency_key: assignment.idempotency_key ?? stringField(action, 'idempotencyKey'),
      payload_digest: assignment.action_digest ?? stringField(action, 'digest'),
      payload: {
        action: {
          adapter: assignment.adapter,
          action: assignment.action,
          input: sanitizeActionInput(actionInput),
          response: response ?? null,
        },
      },
      provider_response: response ?? result.metadata,
      provider_reconciliation: providerReconciliation,
    };
  } catch (error) {
    if (error instanceof WorkflowActionError) {
      const action = recordValue(error.result.metadata['action']);
      const response = recordValue(action?.['response']);
      const providerReconciliation =
        recordValue(action?.['provider_reconciliation']) ??
        recordValue(action?.['providerReconciliation']);
      return {
        status: 'failed',
        idempotency_key: assignment.idempotency_key ?? stringField(action, 'idempotencyKey'),
        payload_digest: assignment.action_digest ?? stringField(action, 'digest'),
        payload: {
          action: {
            adapter: assignment.adapter,
            action: assignment.action,
            input: sanitizeActionInput(actionInput),
            response: response ?? null,
          },
        },
        provider_response: response ?? error.result.metadata,
        provider_reconciliation: providerReconciliation,
        error: error.message,
      };
    }
    throw error;
  }
}

function actionInputFromReplay(
  assignment: ManagedActionReplayAssignment,
): Record<string, WorkflowInputValue> | null {
  const proposalPayload = assignment.action_proposal?.payload;
  const proposalInput = workflowInputRecord(proposalPayload);
  if (proposalInput) return proposalInput;
  const payload = assignment.payload ?? {};
  const actionPayload = recordValue(payload['action_payload']) ?? recordValue(payload['action']);
  const replayPayload = workflowInputRecord(actionPayload);
  return replayPayload ?? null;
}

function normalizeReplayAction(adapter: string, action: string): string {
  if (adapter === 'github' && action === 'pull_request.create') return 'create_pull_request';
  if (adapter === 'github' && action === 'issue.comment') return 'comment_issue';
  if (adapter === 'jira' && action === 'issue.comment') return 'comment_issue';
  if (adapter === 'slack' && action === 'message') return 'post_message';
  return action;
}

function replayProviderReference(
  response: Record<string, unknown> | undefined,
): string | undefined {
  return (
    stringField(response ?? null, 'htmlUrl') ??
    stringField(response ?? null, 'apiUrl') ??
    stringField(response ?? null, 'url') ??
    stringField(response ?? null, 'channel') ??
    stringField(response ?? null, 'ts') ??
    numberField(response ?? null, 'number')?.toString()
  );
}

function replayProviderUrl(response: Record<string, unknown> | undefined): string | undefined {
  return (
    stringField(response ?? null, 'htmlUrl') ??
    stringField(response ?? null, 'apiUrl') ??
    stringField(response ?? null, 'url')
  );
}

function workflowInputRecord(value: unknown): Record<string, WorkflowInputValue> | null {
  if (!isRecord(value)) return null;
  return value as Record<string, WorkflowInputValue>;
}

function actionReplayRunRecord(assignment: ManagedActionReplayAssignment): WorkflowRunRecord {
  const now = Date.now();
  return {
    id: assignment.workflow_run_id ?? assignment.id,
    workflowName: 'action-replay',
    sourceType: 'viewport_snapshot',
    sourcePath: `viewport://action-replay/${assignment.id}`,
    digest: assignment.action_digest ?? `action-replay:${assignment.id}`,
    schema: 'viewport.workflow/v1',
    yamlSnapshot: '',
    directoryId: 'action-replay',
    directoryPath: process.cwd(),
    machineId: 'managed-executor',
    initiation: 'cli',
    status: 'running',
    inputs: {},
    preflight: { ok: true, issues: [] },
    nodes: {},
    artifacts: [],
    events: [],
    createdAt: now,
    startedAt: now,
    updatedAt: now,
  };
}

async function runActionReplayCommand(
  command: string,
  assignment: ManagedActionReplayAssignment,
): Promise<Record<string, unknown>> {
  const input = {
    id: assignment.id,
    adapter: assignment.adapter,
    action: assignment.action,
    idempotency_key: assignment.idempotency_key ?? null,
    action_digest: assignment.action_digest ?? null,
    source_runtime_event_id: assignment.source_runtime_event_id ?? null,
    workflow_run_id: assignment.workflow_run_id ?? null,
    workflow_action_proposal_id: assignment.workflow_action_proposal_id ?? null,
    source_execution_receipt_id: assignment.source_execution_receipt_id ?? null,
    payload: assignment.payload ?? {},
    provider_response: assignment.provider_response ?? null,
  };
  const result = await runShellCommand(command, `${JSON.stringify(input)}\n`);
  if (result.exitCode !== 0) {
    return {
      status: 'failed',
      idempotency_key: assignment.idempotency_key ?? undefined,
      payload_digest: assignment.action_digest ?? undefined,
      provider_response: outputResponse(result),
      error: result.stderr || result.stdout || `Action replay command exited ${result.exitCode}.`,
    };
  }

  const parsed = parseCommandJson(result.stdout);
  if (parsed === 'invalid') {
    return {
      status: 'failed',
      idempotency_key: assignment.idempotency_key ?? undefined,
      payload_digest: assignment.action_digest ?? undefined,
      provider_response: outputResponse(result),
      error: 'Action replay command stdout was not valid JSON.',
    };
  }
  const status = replayStatus(parsed?.['status']);
  return {
    status,
    provider_reference: stringField(parsed, 'provider_reference'),
    provider_url: stringField(parsed, 'provider_url'),
    idempotency_key:
      stringField(parsed, 'idempotency_key') ?? assignment.idempotency_key ?? undefined,
    payload_digest: stringField(parsed, 'payload_digest') ?? assignment.action_digest ?? undefined,
    payload: recordField(parsed, 'payload') ?? assignment.payload ?? undefined,
    provider_response: recordField(parsed, 'provider_response') ?? outputResponse(result),
    provider_reconciliation: recordField(parsed, 'provider_reconciliation'),
    error: status === 'succeeded' ? undefined : (stringField(parsed, 'error') ?? result.stderr),
  };
}

function replayStatus(value: unknown): 'succeeded' | 'failed' | 'dead_letter' {
  if (value === 'failed' || value === 'dead_letter') return value;
  return 'succeeded';
}

function parseCommandJson(stdout: string): Record<string, unknown> | null | 'invalid' {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : 'invalid';
  } catch {
    return 'invalid';
  }
}

function stringField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function recordField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function numberField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' ? value : undefined;
}

function outputResponse(result: ShellCommandResult): Record<string, unknown> {
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exitCode,
  };
}

interface ShellCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runShellCommand(command: string, stdin: string): Promise<ShellCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-lc', command], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(stdin);
  });
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
  const material = await materializeRunCredentials(options, assignment);
  const started = await daemonJson('POST', '/api/workflows/runs', {
    workflowYaml: assignment.yaml_snapshot,
    workflowSourceRef: assignment.source_ref ?? `viewport://managed-executor/${assignment.id}`,
    directoryId: directory.id,
    inputs: assignmentInputs(assignment, material.metadata),
    runtimeSecretEnv: material.runtimeSecretEnv,
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

function assignmentInputs(
  assignment: ManagedAssignment,
  credentialMetadata: CredentialMaterialMetadata[] = [],
): Record<string, unknown> {
  const inputs = { ...(assignment.input_snapshot ?? {}) } as Record<string, unknown>;
  inputs['viewport'] = {
    ...(isRecord(inputs['viewport']) ? inputs['viewport'] : {}),
    platformRunId: assignment.id,
    schemaVersions: assignment.schema_versions ?? null,
    route: assignment.route_snapshot ?? null,
    executionProfile: assignment.execution_profile_snapshot ?? null,
    workflow: assignment.workflow_snapshot ?? null,
    runnerWorkspace: assignment.runner_workspace_snapshot ?? null,
    contextReceipts: assignment.context_receipts_snapshot ?? null,
    credentials: credentialMetadata,
  };

  return inputs;
}

interface CredentialMaterialResult {
  runtimeSecretEnv: Record<string, string>;
  metadata: CredentialMaterialMetadata[];
}

interface CredentialMaterialMetadata {
  handle: string;
  envName: string;
  kind?: string | null;
  storagePosture?: string | null;
  materialAvailable: boolean;
  runnerLocalRequired: boolean;
  provider?: string | null;
  credentialId?: string | number | null;
  scopes?: unknown;
}

async function materializeRunCredentials(
  options: ManagedWorkerOptions,
  assignment: ManagedAssignment,
): Promise<CredentialMaterialResult> {
  const handles = collectCredentialHandles(assignment);
  if (handles.length === 0) return { runtimeSecretEnv: {}, metadata: [] };

  const runtimeSecretEnv: Record<string, string> = {};
  const metadata: CredentialMaterialMetadata[] = [];
  for (const handle of handles) {
    const response = await materializeCredential(options, assignment, handle);
    const envName = envNameForCredentialRef(handle);
    const secret = stringField(response, 'secret');
    if (secret) {
      runtimeSecretEnv[envName] = secret;
    }
    metadata.push({
      handle,
      envName,
      kind: stringField(response, 'kind') ?? null,
      storagePosture: stringField(response, 'storage_posture') ?? null,
      materialAvailable: response['material_available'] === true,
      runnerLocalRequired: response['runner_local_required'] === true,
      provider: stringField(response, 'provider') ?? null,
      credentialId:
        stringField(response, 'credential_id') ?? numberField(response, 'credential_id') ?? null,
      scopes: response['scopes'],
    });
  }

  return { runtimeSecretEnv, metadata };
}

async function materializeCredential(
  options: ManagedWorkerOptions,
  assignment: ManagedAssignment,
  handle: string,
): Promise<Record<string, unknown>> {
  if (!assignment.assignment_claim_token) {
    throw new Error(`Managed workflow assignment ${assignment.id} is missing claim_token.`);
  }
  const body = await platformJson(
    options,
    'POST',
    `workflow-runs/${encodeURIComponent(assignment.id)}/credential-material`,
    { credential: options.credential, handle },
    assignment.assignment_claim_token,
  );
  const data = dataFrom(body);
  if (!isRecord(data)) {
    throw new Error(`Credential material response for ${handle} was not an object.`);
  }
  return data;
}

function collectCredentialHandles(assignment: ManagedAssignment): string[] {
  const snapshots = [assignment.execution_profile_snapshot, assignment.workflow_snapshot].filter(
    isRecord,
  );
  const handles = new Set<string>();
  for (const snapshot of snapshots) {
    for (const handle of [
      ...credentialRefsFrom(pathValue(snapshot, ['credentials', 'include'])),
      ...credentialRefsFrom(pathValue(snapshot, ['credentials', 'repo_checkout'])),
      ...credentialRefsFrom(pathValue(snapshot, ['credentials', 'mcp_api'])),
      ...credentialRefsFrom(snapshot['credential_refs']),
      ...credentialRefsFrom(pathValue(snapshot, ['requires', 'secrets'])),
    ]) {
      handles.add(handle);
    }
  }
  return [...handles].sort();
}

function credentialRefsFrom(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim() !== '') return [entry];
    if (!isRecord(entry)) return [];
    for (const key of ['handle', 'ref', 'credential_ref']) {
      const value = stringField(entry, key);
      if (value) return [value];
    }
    return [];
  });
}

function pathValue(value: Record<string, unknown>, pathParts: string[]): unknown {
  let current: unknown = value;
  for (const part of pathParts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
    await heartbeat(options, 'online', 'busy');
    const assignment = await getAssignment(options, platformRunId, assignmentClaimToken);
    const approved = assignment.nodes?.find(isApprovedManagedGateNode);
    if (approved) {
      return resumeApprovedLocalRun(
        options,
        platformRunId,
        localRunId,
        approved,
        assignmentClaimToken,
      );
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
    await delay(options.sleepSeconds * 1000);
  }
}

async function approvedNodeForAssignment(
  options: ManagedWorkerOptions,
  platformRunId: string,
  assignmentClaimToken?: string | null,
): Promise<NonNullable<ManagedAssignment['nodes']>[number] | null> {
  const assignment = await getAssignment(options, platformRunId, assignmentClaimToken);
  return assignment.nodes?.find(isApprovedManagedGateNode) ?? null;
}

async function resumeApprovedLocalRun(
  options: ManagedWorkerOptions,
  platformRunId: string,
  localRunId: string,
  approved: NonNullable<ManagedAssignment['nodes']>[number],
  assignmentClaimToken?: string | null,
): Promise<WorkflowRunRecord> {
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
      executionGrant: approvalExecutionGrant(approved),
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
    localRunToSyncPayload(run, { includeApprovalDecisions: false }),
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
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  return responseJson(
    await platformFetch(options, method, pathSuffix, body, assignmentClaimToken, extraHeaders),
  );
}

async function platformFetch(
  options: ManagedWorkerOptions,
  method: string,
  pathSuffix: string,
  body?: unknown,
  assignmentClaimToken?: string | null,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const response = await transportFetch(`${baseManagedUrl(options)}/${pathSuffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${options.credential}`,
      Accept: 'application/json',
      ...(assignmentClaimToken ? { 'X-Viewport-Assignment-Claim': assignmentClaimToken } : {}),
      ...(extraHeaders ?? {}),
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
