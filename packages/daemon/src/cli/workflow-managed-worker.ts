import { spawn, spawnSync } from 'node:child_process';
import {
  constants,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  randomUUID,
  sign,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { getArgs, getFlag, hasFlag } from './args.js';
import { daemonFetch, isDaemonRunning } from './daemon-client.js';
import { isJsonMode, printJson } from './command-shared.js';
import { parseCsvList, parseTlsVerifyMode, transportFetch } from './network.js';
import {
  commandPollSeconds,
  delay,
  listFlagValue,
  positiveIntFlagValue,
  safeText,
} from './workflow-managed-worker-util.js';
import type { WorkflowRunRecord } from '../workflows/types.js';
import type { SessionResourceManifest } from '../config-resolution/index.js';
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
  approvalFeedback,
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
  ManagedWorkerRunnerKeyPair,
  ManagedWorkerSigningIdentity,
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
  await syncDaemonModelCapabilities(options);
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
          localRun.id,
        );
        if (approved) {
          const resumed = await resumeApprovedLocalRun(
            options,
            assignment.id,
            localRun.id,
            approved,
            assignment.assignment_claim_token,
          );
          const blockedIds = blockedNodeIds(resumed);
          const shouldKeepWaiting =
            resumed.status === 'blocked' &&
            (!alreadyResolvedApprovalRuns.has(resumed) || !blockedIds.has(approved.node_key)) &&
            (!blockedIds.has(approved.node_key) ||
              managedApprovalDecision(approved) === 'request_changes');
          const finalRun = shouldKeepWaiting
            ? await waitForApprovalAndResume(
                options,
                assignment.id,
                localRun.id,
                assignment.assignment_claim_token,
              )
            : resumed;
          stats.completed += finalRun.status === 'completed' ? 1 : 0;
          stats.failed += finalRun.status === 'failed' || finalRun.status === 'canceled' ? 1 : 0;

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

async function syncDaemonModelCapabilities(options: ManagedWorkerOptions): Promise<void> {
  const response = await daemonFetch('/api/models', {
    method: 'GET',
    timeoutMs: 30_000,
  });
  if (!response?.ok) {
    return;
  }

  const body = (await response.json()) as {
    models?: Array<{
      agentId?: unknown;
      agent_id?: unknown;
      value?: unknown;
      id?: unknown;
    }>;
  };
  const catalog = daemonModelCatalog(body.models ?? []);
  const allModels = [...new Set(Object.values(catalog).flat())];
  if (allModels.length === 0) {
    return;
  }

  options.capabilities.models = allModels;
  options.capabilities.agentModels = catalog;
}

function daemonModelCatalog(
  models: Array<{ agentId?: unknown; agent_id?: unknown; value?: unknown; id?: unknown }>,
): Record<string, string[]> {
  const catalog: Record<string, string[]> = {};
  for (const model of models) {
    const agentId = stringValue(model.agentId) ?? stringValue(model.agent_id);
    const value = stringValue(model.value) ?? stringValue(model.id);
    if (!agentId || !value) continue;
    catalog[agentId] = [...new Set([...(catalog[agentId] ?? []), value])];
  }

  return catalog;
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
  const serverId =
    getFlag('server-id') ??
    process.env['VIEWPORT_SERVER_ID'] ??
    process.env['VPD_SERVER_ID'] ??
    registrationProfile?.serverId;
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
  const runnerKeyPair = loadOrCreateRunnerKeyPair(workspaceId, executorId);
  const signingIdentity = loadSigningIdentity(registrationProfile);
  const detected = detectLocalCapabilities();

  const sleepSeconds = positiveIntFlagValue(getFlag('sleep')) ?? 5;

  return {
    server: server.replace(/\/+$/, ''),
    serverId,
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
    workerSessionId: randomUUID(),
    runnerKeyPair,
    signingIdentity,
    runnerPool:
      getFlag('runner-pool') ??
      process.env['VIEWPORT_MANAGED_RUNNER_POOL'] ??
      process.env['VIEWPORT_MANAGED_EXECUTOR_RUNNER_POOL'] ??
      profileRunnerPool ??
      undefined,
    workdir: getFlag('workdir') ? path.resolve(getFlag('workdir')!) : undefined,
    leaseSeconds: positiveIntFlagValue(getFlag('lease')) ?? 300,
    sleepSeconds,
    commandSleepSeconds: commandPollSeconds(
      positiveIntFlagValue(getFlag('command-sleep')) ??
        positiveIntFlagValue(process.env['VIEWPORT_MANAGED_EXECUTOR_COMMAND_SLEEP_SECONDS']),
      sleepSeconds,
    ),
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
      tools: [
        ...new Set([
          ...detected.tools,
          ...listFlagOrProfile('tools', profileCapabilities['tools']),
        ]),
      ],
      agents: listFlagOrProfile('agents', profileCapabilities['agents']),
      models: listFlagOrProfile('models', profileCapabilities['models']),
      agentModels: agentModelsFromProfile(profileCapabilities['agents']),
      integrations: [
        ...new Set([
          ...detected.integrations,
          ...listFlagOrProfile('integrations', profileCapabilities['integrations']),
        ]),
      ],
      secrets: listFlagOrProfile('secrets', profileCapabilities['secrets']),
    },
  };
}

function workflowWorkerUsage(): string {
  return 'Usage: vpd workflow worker --server <url> --workspace <id> --executor <id> --credential <token> [--workdir <path>] [--runner-pool <pool>] [--agent-command <command>] [--action-command <command>] [--provider-actions] [--sleep <seconds>] [--command-sleep <seconds>] [--doctor|--preflight|--once]\n       vpd workflow worker --registration-profile <path> [--sleep <seconds>] [--command-sleep <seconds>] [--doctor|--preflight|--once]';
}

interface RegistrationProfile {
  serverUrl?: string;
  serverId?: string;
  workspaceId?: string;
  executorId?: string;
  credential?: string;
  accessMode?: string;
  runnerProfile?: string;
  runnerPosture?: Record<string, unknown>;
  identityKeyPath?: string;
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
  const daemon = recordValue(record['daemon']);
  const worker = recordValue(daemon?.['worker']);
  const schema = stringValue(record['schema']);
  if (schema && schema !== 'viewport.managed_executor_registration/v1') {
    throw new Error(`Unsupported managed executor registration profile schema: ${schema}`);
  }

  return {
    serverUrl:
      stringValue(record['server_url']) ??
      stringValue(record['serverUrl']) ??
      stringValue(worker?.['serverUrl']) ??
      stringValue(worker?.['server_url']),
    serverId:
      stringValue(record['server_id']) ??
      stringValue(record['serverId']) ??
      stringValue(record['control_plane_id']) ??
      stringValue(worker?.['serverId']) ??
      stringValue(worker?.['server_id']) ??
      stringValue(worker?.['control_plane_id']),
    workspaceId:
      stringValue(record['workspace_id']) ??
      stringValue(record['workspaceId']) ??
      stringValue(worker?.['workspaceId']) ??
      stringValue(worker?.['workspace_id']),
    executorId:
      stringValue(record['managed_executor_id']) ??
      stringValue(record['executor_id']) ??
      stringValue(record['executorId']) ??
      stringValue(worker?.['managedExecutorId']) ??
      stringValue(worker?.['managed_executor_id']),
    credential: stringValue(record['credential']) ?? stringValue(worker?.['credential']),
    accessMode:
      stringValue(record['access_mode']) ??
      stringValue(record['accessMode']) ??
      stringValue(worker?.['accessMode']) ??
      stringValue(worker?.['access_mode']) ??
      stringValue(worker?.['transport']),
    runnerProfile:
      stringValue(record['runner_profile']) ??
      stringValue(record['runnerProfile']) ??
      stringValue(worker?.['runnerProfile']) ??
      stringValue(worker?.['runner_profile']),
    runnerPosture:
      recordValue(record['runner_posture']) ??
      recordValue(record['runnerPosture']) ??
      recordValue(worker?.['runnerPosture']) ??
      recordValue(worker?.['runner_posture']),
    identityKeyPath:
      stringValue(record['identity_key_path']) ??
      stringValue(record['identityKeyPath']) ??
      stringValue(worker?.['identityKeyPath']) ??
      stringValue(worker?.['identity_key_path']),
    capabilities:
      record['capabilities'] &&
      typeof record['capabilities'] === 'object' &&
      !Array.isArray(record['capabilities'])
        ? (record['capabilities'] as Record<string, unknown>)
        : (recordValue(worker?.['capabilities']) ?? undefined),
  };
}

function resolveProfilePath(profilePath: string): string {
  if (profilePath === '~') return os.homedir();
  if (profilePath.startsWith('~/')) return path.join(os.homedir(), profilePath.slice(2));
  return path.resolve(profilePath);
}

function loadOrCreateRunnerKeyPair(
  workspaceId: string,
  executorId: string,
): ManagedWorkerRunnerKeyPair {
  const keyDir = path.join(os.homedir(), '.viewport', 'runner-keys');
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const safeName = `${safeFilename(workspaceId)}-${safeFilename(executorId)}.json`;
  const keyPath = path.join(keyDir, safeName);
  if (fs.existsSync(keyPath)) {
    const parsed = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as unknown;
    if (isRunnerKeyPair(parsed, keyPath)) return parsed;
  }

  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const keyPair: ManagedWorkerRunnerKeyPair = {
    schema: 'viewport.runner_keypair/v1',
    algorithm: 'RSA-OAEP-256',
    publicKeyPem: pair.publicKey,
    privateKeyPem: pair.privateKey,
    fingerprint: publicKeyFingerprint(pair.publicKey),
    path: keyPath,
  };
  fs.writeFileSync(keyPath, JSON.stringify(keyPair, null, 2), { mode: 0o600 });
  return keyPair;
}

function isRunnerKeyPair(value: unknown, keyPath: string): value is ManagedWorkerRunnerKeyPair {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record['schema'] !== 'viewport.runner_keypair/v1' ||
    record['algorithm'] !== 'RSA-OAEP-256' ||
    typeof record['publicKeyPem'] !== 'string' ||
    typeof record['privateKeyPem'] !== 'string' ||
    typeof record['fingerprint'] !== 'string'
  ) {
    return false;
  }
  if (typeof record['path'] !== 'string') {
    record['path'] = keyPath;
  }

  return true;
}

function publicKeyFingerprint(publicKeyPem: string): string {
  const body = publicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(body, 'base64');
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

function loadSigningIdentity(
  registrationProfile: RegistrationProfile | null,
): ManagedWorkerSigningIdentity | undefined {
  const identityPath =
    getFlag('identity-key') ??
    process.env['VIEWPORT_WORKER_IDENTITY_FILE'] ??
    process.env['VIEWPORT_MANAGED_EXECUTOR_IDENTITY_FILE'] ??
    registrationProfile?.identityKeyPath;
  if (!identityPath) return undefined;

  const resolved = resolveProfilePath(identityPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Worker identity file is not a JSON object: ${resolved}`);
  }
  const record = parsed as Record<string, unknown>;
  const algorithm = stringValue(record['algorithm'])?.toLowerCase();
  const publicKeyPem =
    stringValue(record['public_key_pem']) ??
    stringValue(record['publicKeyPem']) ??
    stringValue(record['publicKey']) ??
    stringValue(record['public_key']);
  const privateKeyPem =
    stringValue(record['private_key_pem']) ??
    stringValue(record['privateKeyPem']) ??
    stringValue(record['privateKey']) ??
    stringValue(record['private_key']);
  const fingerprint = normalizeWorkerFingerprint(
    stringValue(record['fingerprint']) ??
      stringValue(record['publicKeyFingerprint']) ??
      stringValue(record['public_key_fingerprint']) ??
      '',
  );
  if (
    algorithm !== 'ed25519' ||
    !publicKeyPem ||
    !privateKeyPem ||
    !/^[a-f0-9]{64}$/i.test(fingerprint)
  ) {
    throw new Error(`Worker identity file is not a supported ed25519 identity: ${resolved}`);
  }

  return {
    algorithm: 'ed25519',
    publicKeyPem,
    privateKeyPem,
    fingerprint: fingerprint.toLowerCase(),
    serverId:
      stringValue(record['server_id']) ??
      stringValue(record['serverId']) ??
      stringValue(record['control_plane_id']) ??
      registrationProfile?.serverId,
    path: resolved,
  };
}

function normalizeWorkerFingerprint(fingerprint: string): string {
  return fingerprint.startsWith('sha256:') ? fingerprint.slice('sha256:'.length) : fingerprint;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'runner';
}

function detectLocalCapabilities(): { tools: string[]; integrations: string[] } {
  const tools = ['git', 'node', 'pnpm', 'docker', 'gh'].filter(commandExists);
  const integrations = [
    ...(commandExists('gh') ? ['github'] : []),
    ...(process.env['NOTION_TOKEN'] ? ['notion'] : []),
    ...(process.env['CONFLUENCE_API_TOKEN'] && process.env['CONFLUENCE_BASE_URL']
      ? ['confluence']
      : []),
  ];
  return { tools, integrations };
}

function commandExists(command: string): boolean {
  return (
    spawnSync('sh', ['-lc', `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
      stdio: 'ignore',
    }).status === 0
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function listFlagOrProfile(flag: string, profileValue: unknown): string[] {
  const fromFlag = listFlagValue(getFlag(flag));
  return fromFlag.length > 0 ? fromFlag : stringList(profileValue);
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
    );
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          return stringValue((entry as Record<string, unknown>)['id']) ?? key;
        }
        return key;
      })
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
  }
  return [];
}

function agentModelsFromProfile(agents: unknown): Record<string, string[]> | undefined {
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return undefined;

  const entries = Object.entries(agents as Record<string, unknown>)
    .map(([key, entry]): [string, string[]] | null => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      const id = stringValue(record['id']) ?? key;
      const models = stringList(record['models']);
      return id.trim() !== '' && models.length > 0 ? [id, models] : null;
    })
    .filter((entry): entry is [string, string[]] => entry !== null);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
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
      execution: {
        ...(recordValue(options.runnerPosture?.['execution']) ?? { kind: 'customer-managed' }),
        worker_session_id: options.workerSessionId,
      },
      secrets: {
        ...recordValue(options.runnerPosture?.['secrets']),
        modes: [
          ...new Set([
            'runner_local',
            'runner_encrypted',
            'run_scoped_grant',
            ...stringList(recordValue(options.runnerPosture?.['secrets'])?.['modes']),
          ]),
        ],
        public_key: {
          schema: 'viewport.runner_public_key/v1',
          algorithm: options.runnerKeyPair.algorithm,
          public_key_pem: options.runnerKeyPair.publicKeyPem,
          fingerprint: options.runnerKeyPair.fingerprint,
        },
      },
      model_credentials: {
        ...recordValue(options.runnerPosture?.['model_credentials']),
        anthropic: process.env['ANTHROPIC_API_KEY'] ? 'available' : 'missing',
        openai: process.env['OPENAI_API_KEY'] ? 'available' : 'missing',
      },
      repo_credentials: {
        ...recordValue(options.runnerPosture?.['repo_credentials']),
        runner_local:
          process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN'] || commandExists('gh')
            ? 'available'
            : 'missing',
        run_scoped_grant: 'available',
      },
      context_worker: {
        ...recordValue(options.runnerPosture?.['context_worker']),
        enabled: true,
        supports: [
          ...new Set([
            'git',
            ...(process.env['NOTION_TOKEN'] ? ['notion'] : []),
            ...(process.env['CONFLUENCE_API_TOKEN'] && process.env['CONFLUENCE_BASE_URL']
              ? ['confluence']
              : []),
          ]),
        ],
      },
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
  return 'polling';
}

async function claimAssignment(options: ManagedWorkerOptions): Promise<ManagedAssignment | null> {
  const response = await platformFetch(options, 'POST', 'claim', {
    lease_seconds: options.leaseSeconds,
    worker_session_id: options.workerSessionId,
  });
  if (response.status === 204) return null;
  const body = await responseJson(response);
  return assignmentFrom(body);
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
    numberField(response ?? null, 'number')?.toString() ??
    stringField(response ?? null, 'ts') ??
    stringField(response ?? null, 'id') ??
    stringField(response ?? null, 'channel') ??
    stringField(response ?? null, 'htmlUrl') ??
    stringField(response ?? null, 'apiUrl') ??
    stringField(response ?? null, 'url')
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
    if (existingRun.status === 'running' || existingRun.status === 'queued') {
      const completed = await pollLocalRun(
        existingRun.id,
        async (run) => {
          await syncLocalRun(options, assignment.id, run, assignment.assignment_claim_token);
        },
        progressSyncEveryMs(options.leaseSeconds),
      );
      if (terminalRunStatus(completed.status)) {
        clearRunCredentialMaterial(assignment.id);
      }
      return completed;
    }
    if (terminalRunStatus(existingRun.status)) {
      clearRunCredentialMaterial(assignment.id);
    }
    return existingRun;
  }

  const directory = await ensureDirectory(
    options.workdir ?? assignment.directory_path ?? process.cwd(),
  );
  const material = await materializeAndCacheRunCredentials(options, assignment);
  const started = await daemonJson('POST', '/api/workflows/runs', {
    workflowYaml: assignment.yaml_snapshot,
    workflowSourceRef: assignment.source_ref ?? `viewport://managed-executor/${assignment.id}`,
    directoryId: directory.id,
    inputs: assignmentInputs(assignment, material),
    runtimeSecretEnv: material.runtimeSecretEnv,
    runtimeSecretFiles: material.runtimeSecretFiles,
    resourceId: options.workspaceId,
    runtimeTargetId: assignment.runtime_target_id ?? undefined,
    platformRunId: assignment.id,
    resourceManifest: assignmentResourceManifest(assignment) ?? undefined,
    workflowAuthorityContract:
      assignmentWorkflowAuthorityContract(assignment) ??
      recordChildValue(
        recordChildValue(assignment.input_snapshot, 'viewport'),
        'workflowAuthorityContract',
      ) ??
      undefined,
    initiation: 'cli',
    dataCapturePolicy: assignment.data_capture_policy ?? undefined,
  });
  const runId = readRun(started).id;
  const completed = await pollLocalRun(
    runId,
    async (run) => {
      await syncLocalRun(options, assignment.id, run, assignment.assignment_claim_token);
    },
    progressSyncEveryMs(options.leaseSeconds),
  );
  if (terminalRunStatus(completed.status)) {
    clearRunCredentialMaterial(assignment.id);
  }
  return completed;
}

function recordChildValue(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entry = (value as Record<string, unknown>)[key];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  return entry as Record<string, unknown>;
}

function assignmentInputs(
  assignment: ManagedAssignment,
  material: CredentialMaterialResult = {
    runtimeSecretEnv: {},
    runtimeSecretFiles: {},
    metadata: [],
  },
): Record<string, unknown> {
  const inputs = { ...(assignment.input_snapshot ?? {}) } as Record<string, unknown>;
  inputs['viewport'] = {
    ...(isRecord(inputs['viewport']) ? inputs['viewport'] : {}),
    platformRunId: assignment.id,
    schemaVersions: assignment.schema_versions ?? null,
    target: assignmentTargetSnapshot(assignment) ?? null,
    route: assignmentRouteSnapshot(assignment) ?? null,
    executionProfile: assignmentExecutionProfileSnapshot(assignment) ?? null,
    workflow: assignmentWorkflowSnapshot(assignment) ?? null,
    runnerWorkspace: assignmentRunnerWorkspaceSnapshot(assignment) ?? null,
    contextReceipts: assignmentContextReceiptsSnapshot(assignment) ?? null,
    credentials: material.metadata,
  };

  return inputs;
}

interface CredentialMaterialResult {
  runtimeSecretEnv: Record<string, string>;
  runtimeSecretFiles: Record<string, string>;
  metadata: CredentialMaterialMetadata[];
}

const runCredentialMaterialCache = new Map<string, CredentialMaterialResult>();
const runCredentialProcessEnvCache = new Map<string, Record<string, string | undefined>>();

function terminalRunStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

async function materializeAndCacheRunCredentials(
  options: ManagedWorkerOptions,
  assignment: ManagedAssignment,
): Promise<CredentialMaterialResult> {
  const material = await materializeRunCredentials(options, assignment);
  runCredentialMaterialCache.set(assignment.id, material);
  installRunCredentialProcessEnv(assignment.id, material.runtimeSecretEnv);
  return material;
}

function installRunCredentialProcessEnv(
  runId: string,
  runtimeSecretEnv: Record<string, string>,
): void {
  const entries = Object.entries(runtimeSecretEnv);
  if (entries.length === 0) return;

  const previous = runCredentialProcessEnvCache.get(runId) ?? {};
  for (const [key, value] of entries) {
    if (!(key in previous)) {
      previous[key] = process.env[key];
    }
    process.env[key] = value;
  }
  runCredentialProcessEnvCache.set(runId, previous);
}

function clearRunCredentialMaterial(runId: string): void {
  const material = runCredentialMaterialCache.get(runId);
  runCredentialMaterialCache.delete(runId);
  if (material) {
    for (const filePath of Object.values(material.runtimeSecretFiles)) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // Best-effort cleanup; the run-scoped directory is removed next.
      }
    }
  }
  try {
    fs.rmSync(
      path.join(
        process.env['VIEWPORT_HOME'] ?? path.join(os.homedir(), '.viewport'),
        'run-secrets',
        runId,
      ),
      { recursive: true, force: true },
    );
  } catch {
    // Best-effort cleanup.
  }

  const previous = runCredentialProcessEnvCache.get(runId);
  if (!previous) return;
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  runCredentialProcessEnvCache.delete(runId);
}

interface CredentialMaterialMetadata {
  handle: string;
  envName: string;
  kind?: string | null;
  storagePosture?: string | null;
  materialAvailable: boolean;
  runtimeSecretAvailable: boolean;
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
  if (handles.length === 0) return { runtimeSecretEnv: {}, runtimeSecretFiles: {}, metadata: [] };

  const runtimeSecretEnv: Record<string, string> = {};
  const runtimeSecretFiles: Record<string, string> = {};
  const metadata: CredentialMaterialMetadata[] = [];
  for (const handle of handles) {
    const response = await materializeCredential(options, assignment, handle);
    const envName = envNameForCredentialRef(handle);
    const secret = stringField(response, 'secret');
    if (secret) {
      runtimeSecretEnv[envName] = secret;
      runtimeSecretFiles[envName] = await writeRunCredentialSecretFile(
        assignment.id,
        envName,
        secret,
      );
    }
    const wrappedSecret = recordField(response, 'wrapped_secret');
    if (wrappedSecret) {
      const decrypted = decryptRunnerWrappedSecret(options.runnerKeyPair, wrappedSecret);
      runtimeSecretEnv[envName] = decrypted;
      runtimeSecretFiles[envName] = await writeRunCredentialSecretFile(
        assignment.id,
        envName,
        decrypted,
      );
    }
    metadata.push({
      handle,
      envName,
      kind: stringField(response, 'kind') ?? null,
      storagePosture: stringField(response, 'storage_posture') ?? null,
      materialAvailable: response['material_available'] === true,
      runtimeSecretAvailable: typeof runtimeSecretEnv[envName] === 'string',
      runnerLocalRequired: response['runner_local_required'] === true,
      provider: stringField(response, 'provider') ?? null,
      credentialId:
        stringField(response, 'credential_id') ?? numberField(response, 'credential_id') ?? null,
      scopes: response['scopes'],
    });
  }

  const missingRuntimeSecrets = metadata.filter(
    (entry) =>
      entry.materialAvailable && !entry.runnerLocalRequired && !entry.runtimeSecretAvailable,
  );
  if (missingRuntimeSecrets.length > 0) {
    const handles = missingRuntimeSecrets.map((entry) => entry.handle).join(', ');
    throw new Error(
      `Credential materialization for ${assignment.id} returned material_available without runtime secret material for: ${handles}`,
    );
  }

  return { runtimeSecretEnv, runtimeSecretFiles, metadata };
}

async function writeRunCredentialSecretFile(
  runId: string,
  envName: string,
  secret: string,
): Promise<string> {
  const root = path.join(
    process.env['VIEWPORT_HOME'] ?? path.join(os.homedir(), '.viewport'),
    'run-secrets',
    runId,
  );
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const filePath = path.join(root, envName);
  await fs.promises.writeFile(filePath, secret, { mode: 0o600 });
  return filePath;
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
    {
      credential: options.credential,
      handle,
      ...repositoryForCredentialMaterialization(assignment, handle),
    },
    assignment.assignment_claim_token,
  );
  const data = dataFrom(body);
  if (!isRecord(data)) {
    throw new Error(`Credential material response for ${handle} was not an object.`);
  }
  return data;
}

function repositoryForCredentialMaterialization(
  assignment: ManagedAssignment,
  handle: string,
): { repository: string } | Record<string, never> {
  const actionRepository = repositoryFromActionCredentialRef(assignment, handle);
  if (actionRepository) return { repository: actionRepository };

  const checkoutEntries = [
    ...credentialEntriesFrom(
      pathValue(asRecord(assignment.execution_profile_snapshot), ['credentials', 'repo_checkout']),
    ),
    ...credentialEntriesFrom(
      pathValue(asRecord(assignment.workflow_snapshot), ['credentials', 'repo_checkout']),
    ),
  ];
  const explicit = checkoutEntries.find((entry) => {
    if (!isRecord(entry)) return entry === handle;
    const entryHandle =
      stringField(entry, 'handle') ??
      stringField(entry, 'ref') ??
      stringField(entry, 'credential_ref');
    return entryHandle === handle;
  });
  const explicitRepo =
    explicit && isRecord(explicit)
      ? (stringField(explicit, 'repository') ?? stringField(explicit, 'repo'))
      : null;
  if (explicitRepo) return { repository: explicitRepo };

  const allowed = allowedRepositoriesFromAssignment(assignment);
  return allowed.length === 1 && allowed[0] ? { repository: allowed[0] } : {};
}

function allowedRepositoriesFromAssignment(assignment: ManagedAssignment): string[] {
  const candidates = assignmentWorkflowAuthorityContracts(assignment).map((contract) =>
    pathValue(contract, ['repos', 'allowed']),
  );

  return [
    ...new Set(
      candidates
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
        .map((value) => value.trim()),
    ),
  ];
}

function decryptRunnerWrappedSecret(
  keyPair: ManagedWorkerRunnerKeyPair,
  wrapped: Record<string, unknown>,
): string {
  const schema = stringField(wrapped, 'schema');
  const algorithm = stringField(wrapped, 'algorithm');
  const fingerprint = stringField(wrapped, 'runner_public_key_fingerprint');
  const ciphertext = stringField(wrapped, 'ciphertext');
  if (
    schema !== 'viewport.runner_wrapped_secret/v1' ||
    algorithm !== 'RSA-OAEP-256' ||
    !fingerprint ||
    !ciphertext
  ) {
    throw new Error('Runner-encrypted credential material is malformed.');
  }
  if (fingerprint !== keyPair.fingerprint) {
    throw new Error(
      `Runner-encrypted credential was wrapped for ${fingerprint}, but this runner key is ${keyPair.fingerprint}. Rotate or re-wrap the credential for this runner pool.`,
    );
  }

  return privateDecrypt(
    {
      key: keyPair.privateKeyPem,
      oaepHash: 'sha256',
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    },
    Buffer.from(ciphertext, 'base64'),
  ).toString('utf8');
}

function collectCredentialHandles(assignment: ManagedAssignment): string[] {
  const snapshots = [
    assignmentTargetSnapshot(assignment),
    assignmentExecutionProfileSnapshot(assignment),
    assignmentWorkflowSnapshot(assignment),
    yamlSnapshotDocument(assignment),
  ].filter(isRecord);
  const handles = new Set<string>();
  for (const snapshot of snapshots) {
    for (const handle of [
      ...credentialRefsFrom(pathValue(snapshot, ['credentials', 'include'])),
      ...credentialRefsFrom(pathValue(snapshot, ['credentials', 'repo_checkout'])),
      ...credentialRefsFrom(pathValue(snapshot, ['credentials', 'mcp_api'])),
      ...credentialRefsFromCredentialMap(snapshot['credentials']),
      ...credentialRefsFrom(snapshot['credential_refs']),
      ...actionCredentialRefs(snapshot['nodes']),
    ]) {
      handles.add(handle);
    }
  }
  for (const contract of assignmentWorkflowAuthorityContracts(assignment)) {
    for (const handle of credentialRefsFrom(
      pathValue(asRecord(contract), ['credentials', 'provider_actions']),
    )) {
      handles.add(handle);
    }
  }
  return [...handles].sort();
}

function credentialRefsFromCredentialMap(entries: unknown): string[] {
  if (!isRecord(entries)) return [];
  return Object.values(entries).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const mode = stringField(entry, 'mode') ?? stringField(entry, 'storage_posture');
    if (mode && !['viewport_brokered', 'viewport_managed'].includes(mode)) return [];
    const handle =
      stringField(entry, 'handle') ??
      stringField(entry, 'ref') ??
      stringField(entry, 'credential_ref');
    return handle ? [handle] : [];
  });
}

function credentialRefsFrom(entries: unknown): string[] {
  return credentialEntriesFrom(entries).flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim() !== '') return [entry];
    if (!isRecord(entry)) return [];
    for (const key of ['handle', 'ref', 'credential_ref']) {
      const value = stringField(entry, key);
      if (value) return [value];
    }
    return [];
  });
}

function credentialEntriesFrom(entries: unknown): unknown[] {
  return Array.isArray(entries) ? entries : [];
}

function actionCredentialRefs(nodes: unknown): string[] {
  if (!isRecord(nodes)) return [];
  return Object.values(nodes).flatMap((node) => {
    if (!isRecord(node) || stringField(node, 'type') !== 'action') return [];
    const withValue = isRecord(node['with']) ? node['with'] : {};
    const credentialRef =
      stringField(withValue, 'credential_ref') ?? stringField(withValue, 'credentialRef');
    return credentialRef ? [credentialRef] : [];
  });
}

function repositoryFromActionCredentialRef(
  assignment: ManagedAssignment,
  handle: string,
): string | null {
  const workflow = yamlSnapshotDocument(assignment);
  const nodes = isRecord(workflow) ? workflow['nodes'] : undefined;
  if (!isRecord(nodes)) return null;

  for (const node of Object.values(nodes)) {
    if (!isRecord(node) || stringField(node, 'type') !== 'action') continue;
    const withValue = isRecord(node['with']) ? node['with'] : {};
    const credentialRef =
      stringField(withValue, 'credential_ref') ?? stringField(withValue, 'credentialRef');
    if (credentialRef !== handle) continue;

    const repository = stringField(withValue, 'repository') ?? stringField(withValue, 'repo');
    const rendered = renderCredentialTemplate(repository, assignment);
    if (rendered) return rendered;
  }

  return null;
}

function renderCredentialTemplate(
  value: string | null | undefined,
  assignment: ManagedAssignment,
): string | null {
  if (!value) return null;
  const inputs = isRecord(assignment.input_snapshot) ? assignment.input_snapshot : {};
  const rendered = value.replace(
    /\{\{\s*inputs\.([A-Za-z0-9_]+)\s*\}\}/g,
    (_match: string, key: string) => {
      const input = inputs[key];
      return typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean'
        ? String(input)
        : '';
    },
  );
  const trimmed = rendered.trim();
  return trimmed === '' || trimmed.includes('{{') ? null : trimmed;
}

function yamlSnapshotDocument(assignment: ManagedAssignment): unknown {
  if (!assignment.yaml_snapshot) return null;
  try {
    return YAML.parse(assignment.yaml_snapshot);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
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
    const commandRun = await applyBrokerActionCompletedCommands(
      options,
      platformRunId,
      assignment,
      localRunId,
      assignmentClaimToken,
    );
    if (commandRun) {
      if (commandRun.status !== 'blocked') return commandRun;
      await delay(options.commandSleepSeconds * 1000);
      continue;
    }
    const approved = await approvedNodeForAssignment(
      options,
      platformRunId,
      assignmentClaimToken,
      localRunId,
    );
    if (approved) {
      const resumed = await resumeApprovedLocalRun(
        options,
        platformRunId,
        localRunId,
        approved,
        assignmentClaimToken,
      );
      if (resumed.status !== 'blocked') return resumed;
      const blockedIds = blockedNodeIds(resumed);
      if (alreadyResolvedApprovalRuns.has(resumed) && !blockedIds.has(approved.node_key)) {
        const nextApproved = await approvedNodeForAssignment(
          options,
          platformRunId,
          assignmentClaimToken,
          localRunId,
        );
        if (
          nextApproved &&
          nextApproved.node_key !== approved.node_key &&
          blockedIds.has(nextApproved.node_key)
        ) {
          await delay(options.commandSleepSeconds * 1000);
          continue;
        }
        await delay(options.commandSleepSeconds * 1000);
        return resumed;
      }
      if (
        blockedIds.has(approved.node_key) &&
        managedApprovalDecision(approved) !== 'request_changes'
      ) {
        return resumed;
      }
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
    const current = await readExistingLocalRun(localRunId);
    if (current) {
      await syncLocalRun(options, platformRunId, current, assignmentClaimToken);
    }
    await delay(options.commandSleepSeconds * 1000);
  }
}

async function applyBrokerActionCompletedCommands(
  options: ManagedWorkerOptions,
  platformRunId: string,
  assignment: ManagedAssignment,
  localRunId: string,
  assignmentClaimToken?: string | null,
): Promise<WorkflowRunRecord | null> {
  const localRun = await readExistingLocalRun(localRunId);
  const commands = (assignment.runtime_commands ?? []).filter(
    (command) =>
      command['type'] === 'workflow.action_completed' &&
      !brokerActionCommandAlreadyApplied(localRun, command),
  );
  if (commands.length === 0) return null;

  const response = await daemonJson(
    'POST',
    `/api/workflows/runs/${encodeURIComponent(localRunId)}/runtime-commands`,
    { runtime_commands: commands },
  );
  const run = readRun(response);
  await syncLocalRun(options, platformRunId, run, assignmentClaimToken);
  if (terminalRunStatus(run.status)) {
    clearRunCredentialMaterial(platformRunId);
  }
  return run;
}

function brokerActionCommandAlreadyApplied(
  run: WorkflowRunRecord | null,
  command: Record<string, unknown>,
): boolean {
  const nodeKey = stringValue(command['workflow_node_id']);
  if (!nodeKey) return false;

  const node = run?.nodes?.[nodeKey];
  if (!node || node.status !== 'completed') return false;

  const receipt = recordValue(node.metadata?.['executionReceipt']);
  const receiptKey = stringValue(receipt?.['receipt_key']);
  const commandReceiptKey = stringValue(command['receipt_key']);

  return Boolean(receiptKey && commandReceiptKey && receiptKey === commandReceiptKey);
}

const alreadyResolvedApprovalRuns = new WeakSet<WorkflowRunRecord>();

async function approvedNodeForAssignment(
  options: ManagedWorkerOptions,
  platformRunId: string,
  assignmentClaimToken?: string | null,
  localRunId?: string | null,
): Promise<NonNullable<ManagedAssignment['nodes']>[number] | null> {
  const assignment = await getAssignment(options, platformRunId, assignmentClaimToken);
  if (!localRunId) {
    return (
      managedApprovalNodeFromRuntimeCommands(assignment, new Set()) ??
      assignment.nodes?.find(isResolvedManagedGateNode) ??
      null
    );
  }

  const localRun = await readExistingLocalRun(localRunId);
  const blockedIds = blockedNodeIds(localRun);
  const commandNode = managedApprovalNodeFromRuntimeCommands(assignment, blockedIds);
  if (commandNode) return commandNode;

  const approvedNodes = assignment.nodes?.filter(isResolvedManagedGateNode) ?? [];
  if (approvedNodes.length === 0) return null;

  if (blockedIds.size > 0) {
    return approvedNodes.find((node) => blockedIds.has(node.node_key)) ?? null;
  }

  return approvedNodes[0] ?? null;
}

function managedApprovalNodeFromRuntimeCommands(
  assignment: ManagedAssignment,
  blockedIds: Set<string>,
): NonNullable<ManagedAssignment['nodes']>[number] | null {
  for (const command of assignment.runtime_commands ?? []) {
    if (command['type'] !== 'workflow.approval_decision') continue;
    const nodeKey = stringValue(command['workflow_node_id']);
    if (!nodeKey || (blockedIds.size > 0 && !blockedIds.has(nodeKey))) continue;

    const approved = command['approved'] === true;
    const decision = stringValue(command['decision']);
    return {
      node_key: nodeKey,
      type: 'plan',
      status: 'blocked',
      metadata: {
        approval: {
          approved,
          decision: approved
            ? 'approve'
            : decision === 'request_changes'
              ? 'request_changes'
              : 'reject',
          message: stringValue(command['message']),
          actor: recordValue(command['actor']),
          feedback: recordValue(command['feedback']),
          approval_decision_key: stringValue(command['approval_decision_key']),
          expected_action_digest: stringValue(command['expected_action_digest']),
          execution_grant: recordValue(command['execution_grant']),
        },
      },
    };
  }

  return null;
}

function blockedNodeIds(run?: WorkflowRunRecord | null): Set<string> {
  return new Set(
    Object.values(run?.nodes ?? {})
      .filter((node) => node.status === 'blocked')
      .map((node) => node.id),
  );
}

async function resumeApprovedLocalRun(
  options: ManagedWorkerOptions,
  platformRunId: string,
  localRunId: string,
  approved: NonNullable<ManagedAssignment['nodes']>[number],
  assignmentClaimToken?: string | null,
): Promise<WorkflowRunRecord> {
  const assignment = await getAssignment(options, platformRunId, assignmentClaimToken);
  const localRun = await readExistingLocalRun(localRunId);
  const materialAssignment = localRun
    ? assignmentWithLocalRunSnapshot(assignment, localRun, assignmentClaimToken)
    : {
        ...assignment,
        assignment_claim_token: assignment.assignment_claim_token ?? assignmentClaimToken ?? null,
      };
  const cachedMaterial = runCredentialMaterialCache.get(platformRunId);
  const material =
    cachedMaterial && hasRuntimeSecrets(cachedMaterial)
      ? cachedMaterial
      : await materializeAndCacheRunCredentials(options, materialAssignment);
  try {
    await daemonJson(
      'POST',
      `/api/workflows/runs/${encodeURIComponent(localRunId)}/approvals/${encodeURIComponent(
        approved.node_key,
      )}`,
      {
        approved: managedApprovalApproved(approved),
        decision: managedApprovalDecision(approved),
        message: approvalMessage(approved),
        actor: approvalActor(approved),
        expectedActionDigest: approvalExpectedActionDigest(approved),
        executionGrant: approvalExecutionGrant(approved),
        feedback: approvalFeedback(approved),
        runtimeSecretEnv: material.runtimeSecretEnv,
        runtimeSecretFiles: material.runtimeSecretFiles,
      },
    );
  } catch (error) {
    if (!isAlreadyResolvedApprovalError(error)) throw error;

    const current = await readExistingLocalRun(localRunId);
    if (!current) throw error;
    alreadyResolvedApprovalRuns.add(current);
    await syncLocalRun(options, platformRunId, current, assignmentClaimToken);

    return current;
  }

  const resumed = await pollLocalRun(
    localRunId,
    async (run) => {
      await syncLocalRun(options, platformRunId, run, assignmentClaimToken);
    },
    progressSyncEveryMs(options.leaseSeconds),
  );
  await syncLocalRun(options, platformRunId, resumed, assignmentClaimToken);
  if (terminalRunStatus(resumed.status)) {
    clearRunCredentialMaterial(platformRunId);
  }
  return resumed;
}

function hasRuntimeSecrets(material: CredentialMaterialResult): boolean {
  return Object.keys(material.runtimeSecretEnv).length > 0;
}

function assignmentWithLocalRunSnapshot(
  assignment: ManagedAssignment,
  localRun: WorkflowRunRecord,
  assignmentClaimToken?: string | null,
): ManagedAssignment {
  return {
    ...assignment,
    assignment_claim_token: assignment.assignment_claim_token ?? assignmentClaimToken ?? null,
    yaml_snapshot: localRun.yamlSnapshot || assignment.yaml_snapshot,
    directory_path: localRun.directoryPath || assignment.directory_path,
    input_snapshot: localRun.inputs ?? assignment.input_snapshot,
    resource_manifest: localRun.resourceManifest ?? assignmentResourceManifest(assignment),
    workflow_authority_contract:
      localRun.workflowAuthorityContract ??
      assignmentWorkflowAuthorityContract(assignment) ??
      undefined,
  };
}

function assignmentTargetSnapshot(assignment: ManagedAssignment): Record<string, unknown> | null {
  return assignment.target_snapshot ?? assignment.targetSnapshot ?? null;
}

function assignmentRouteSnapshot(assignment: ManagedAssignment): Record<string, unknown> | null {
  return assignment.route_snapshot ?? assignment.routeSnapshot ?? null;
}

function assignmentExecutionProfileSnapshot(
  assignment: ManagedAssignment,
): Record<string, unknown> | null {
  return assignment.execution_profile_snapshot ?? assignment.executionProfileSnapshot ?? null;
}

function assignmentWorkflowSnapshot(assignment: ManagedAssignment): Record<string, unknown> | null {
  return assignment.workflow_snapshot ?? assignment.workflowSnapshot ?? null;
}

function assignmentRunnerWorkspaceSnapshot(
  assignment: ManagedAssignment,
): Record<string, unknown> | null {
  return assignment.runner_workspace_snapshot ?? assignment.runnerWorkspaceSnapshot ?? null;
}

function assignmentResourceManifest(assignment: ManagedAssignment): SessionResourceManifest | null {
  return assignment.resource_manifest ?? assignment.resourceManifest ?? null;
}

function assignmentContextReceiptsSnapshot(
  assignment: ManagedAssignment,
): unknown[] | Record<string, unknown> | null {
  return assignment.context_receipts_snapshot ?? assignment.contextReceiptsSnapshot ?? null;
}

function assignmentWorkflowAuthorityContract(
  assignment: ManagedAssignment,
): Record<string, unknown> | null {
  return assignmentWorkflowAuthorityContracts(assignment)[0] ?? null;
}

function assignmentWorkflowAuthorityContracts(
  assignment: ManagedAssignment,
): Record<string, unknown>[] {
  return [
    assignment.workflow_authority_contract ?? null,
    assignment.workflowAuthorityContract ?? null,
    recordChildValue(assignmentTargetSnapshot(assignment), 'workflow_authority_contract'),
    recordChildValue(assignmentTargetSnapshot(assignment), 'workflowAuthorityContract'),
    recordChildValue(assignmentRouteSnapshot(assignment), 'workflow_authority_contract'),
    recordChildValue(assignmentRouteSnapshot(assignment), 'workflowAuthorityContract'),
    recordChildValue(assignmentExecutionProfileSnapshot(assignment), 'workflow_authority_contract'),
    recordChildValue(assignmentExecutionProfileSnapshot(assignment), 'workflowAuthorityContract'),
    recordChildValue(assignmentWorkflowSnapshot(assignment), 'workflow_authority_contract'),
    recordChildValue(assignmentWorkflowSnapshot(assignment), 'workflowAuthorityContract'),
    recordChildValue(assignmentRunnerWorkspaceSnapshot(assignment), 'workflow_authority_contract'),
    recordChildValue(assignmentRunnerWorkspaceSnapshot(assignment), 'workflowAuthorityContract'),
    recordChildValue(
      recordChildValue(asRecord(assignment.input_snapshot), 'viewport'),
      'workflow_authority_contract',
    ),
    recordChildValue(
      recordChildValue(asRecord(assignment.input_snapshot), 'viewport'),
      'workflowAuthorityContract',
    ),
  ].filter(isRecord);
}

function isAlreadyResolvedApprovalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return message.includes('Workflow node is not awaiting approval');
}

function isResolvedManagedGateNode(node: NonNullable<ManagedAssignment['nodes']>[number]): boolean {
  if (!['approval', 'gate', 'plan'].includes(String(node.type ?? ''))) return false;
  if (node.status === 'completed') return true;
  const approval = node.metadata?.['approval'];
  if (
    (node.type === 'plan' || node.type === 'gate' || node.type === 'approval') &&
    node.status === 'blocked' &&
    approval &&
    typeof approval === 'object' &&
    'approved' in approval
  ) {
    return true;
  }
  return false;
}

function managedApprovalApproved(node: NonNullable<ManagedAssignment['nodes']>[number]): boolean {
  const approval = node.metadata?.['approval'];
  if (approval && typeof approval === 'object' && 'approved' in approval) {
    return (approval as { approved?: unknown }).approved === true;
  }
  return true;
}

function managedApprovalDecision(
  node: NonNullable<ManagedAssignment['nodes']>[number],
): 'approve' | 'request_changes' | 'reject' {
  const approval = node.metadata?.['approval'];
  if (approval && typeof approval === 'object') {
    const approved = (approval as { approved?: unknown }).approved;
    const decision = (approval as { decision?: unknown }).decision;
    if (approved === false) {
      if (decision === 'request_changes' || decision === 'changes_requested')
        return 'request_changes';
      return 'reject';
    }
  }
  return 'approve';
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
  return assignmentFrom(body);
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
  return assignmentFrom(body);
}

function assignmentFrom(body: unknown): ManagedAssignment {
  const data = dataFrom(body);
  if (!isRecord(data)) return data as ManagedAssignment;

  if (isRecord(body) && Array.isArray(body['runtime_commands'])) {
    return {
      ...data,
      runtime_commands: body['runtime_commands'],
    } as unknown as ManagedAssignment;
  }

  return data as unknown as ManagedAssignment;
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
  const url = `${baseManagedUrl(options)}/${pathSuffix}`;
  const bodyText = body !== undefined ? JSON.stringify(body) : undefined;
  const response = await transportFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${options.credential}`,
      Accept: 'application/json',
      ...(assignmentClaimToken ? { 'X-Viewport-Assignment-Claim': assignmentClaimToken } : {}),
      ...(extraHeaders ?? {}),
      ...workerSignatureHeaders(options, method, url, bodyText),
      ...(bodyText !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(bodyText !== undefined ? { body: bodyText } : {}),
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

function workerSignatureHeaders(
  options: ManagedWorkerOptions,
  method: string,
  url: string,
  bodyText: string | undefined,
): Record<string, string> {
  const identity = options.signingIdentity;
  if (!identity) return {};

  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const bodySha256 = createHash('sha256')
    .update(bodyText ?? '')
    .digest('hex');
  const pathName = new URL(url).pathname;
  const serverId = identity.serverId ?? options.serverId;
  const canonical = [
    method.toUpperCase(),
    pathName,
    bodySha256,
    nonce,
    timestamp,
    ...(serverId ? [serverId] : []),
  ].join('\n');
  const signature = sign(null, Buffer.from(canonical), identity.privateKeyPem).toString('base64');

  return {
    'X-Viewport-Worker-Fingerprint': identity.fingerprint,
    'X-Viewport-Worker-Timestamp': timestamp,
    'X-Viewport-Worker-Nonce': nonce,
    'X-Viewport-Worker-Body-SHA256': bodySha256,
    'X-Viewport-Worker-Signature': signature,
    ...(serverId ? { 'X-Viewport-Server-Id': serverId } : {}),
  };
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
