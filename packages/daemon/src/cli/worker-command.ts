import fs from 'node:fs';
import path from 'node:path';
import { ConfigManager } from '../core/config.js';
import { activeProfileInfo } from '../core/profiles.js';
import { getArgs, getFlag, hasFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import {
  inspectWorkerProcessLock,
  stopWorkerProcessLock,
  type WorkerLockOptions,
  type WorkerProcessLockStatus,
} from './worker-process-lock.js';
import { runStandaloneWorker } from './worker-runtime.js';
import {
  defaultWorkerWorkspaceRoot,
  normalizeWorkerLifecycle,
  normalizeWorkerTransport,
  readWorkerPairingRecord,
  resetWorkerProfile,
  workerProfileIntegrity,
} from './worker-profile.js';
import { SUPPORT_PACKET_DOCS_URL, supportPacketMetadata } from './support-packet.js';

const DEFAULT_WORKER_LEASE_SECONDS = 1_800;

export async function worker(): Promise<void> {
  const args = getArgs();
  const subcommand = args[1] ?? 'help';

  switch (subcommand) {
    case 'help':
    case '--help':
    case '-h':
      showWorkerHelp();
      return;
    case 'doctor':
      await workerDoctor();
      return;
    case 'reset':
      await workerReset();
      return;
    case 'stop':
      await workerStop();
      return;
    case 'start':
      await workerStart();
      return;
    case 'run-once':
      await workerRunOnce();
      return;
    default:
      throw new Error(`${workerHelpText()}\nUnknown worker command "${subcommand}".`);
  }
}

export function showWorkerHelp(): void {
  console.log(workerHelpText());
}

function workerHelpText(): string {
  return [
    'Usage: vpd worker <command>',
    '',
    'Commands:',
    '  start --mode persistent --transport polling|relay|inbound [--lease <seconds>]',
    '  run-once --lease <lease-token> --transport polling|relay|inbound',
    '  stop [--json]',
    '  doctor [--json] [--registration-profile <path>]',
    '  reset [--json] [--force]',
    '  help',
    '',
    'Pairing:',
    '  vpd pair --worker --transport=polling --workdir <path>',
    '  vpd pair --worker --server <url> --transport=polling --workdir <path>',
    '',
    'Defaults:',
    `  workspace root: ${defaultWorkerWorkspaceRoot()}`,
    `  hosted worker lease: ${DEFAULT_WORKER_LEASE_SECONDS} seconds`,
    '  server: hosted Viewport unless --server or config overrides it',
  ].join('\n');
}

async function workerDoctor(): Promise<void> {
  const asJson = isJsonMode();
  const managed = managedExecutorDoctorProfile();
  if (managed.present) {
    if (asJson) {
      printJson(managed.payload);
      return;
    }
    console.log('Viewport worker doctor');
    console.log(`VPD profile:${formatVpdProfile(managed.payload.vpdProfile)}`);
    console.log('Runtime:   managed executor');
    console.log(`Transport: ${managed.payload.transport ?? 'not configured'}`);
    console.log(`Server:    ${managed.payload.serverUrl ?? 'not configured'}`);
    console.log(`Workspace: ${managed.payload.workspaceId ?? 'not configured'}`);
    console.log(`Executor:  ${managed.payload.executorId ?? 'not configured'}`);
    console.log(`Work root: ${managed.payload.workspaceRoot ?? 'not configured'}`);
    console.log(
      `Credential:${managed.payload.credentialSource ? ` ${managed.payload.credentialSource}` : ' missing'}`,
    );
    console.log(`Lock:      ${workerLockLabel(managed.payload.processLock)}`);
    console.log(`Support:   ${SUPPORT_PACKET_DOCS_URL}`);
    if (managed.payload.missing.length > 0) {
      console.log(`Missing:   ${managed.payload.missing.join(', ')}`);
      console.log('Fix:       pass --server, --workspace, --executor, and --credential-file.');
      return;
    }
    if (managed.payload.warnings.length > 0) {
      console.log(`Warnings:  ${managed.payload.warnings.join(', ')}`);
    }
    console.log('Status:    configured');
    return;
  }

  const manager = new ConfigManager();
  await manager.load();
  const workerConfig = manager.getDaemonConfig()?.worker;
  const pairing = await readWorkerPairingRecord(workerConfig?.stateDir);
  const integrity = workerProfileIntegrity(workerConfig, pairing);
  const missing: string[] = [];
  if (!workerConfig?.serverUrl) missing.push('server URL');
  if (!workerConfig?.workspaceRoot) missing.push('workspace root');
  if (!workerConfig?.identityKeyPath || !workerConfig.publicKeyFingerprint) {
    missing.push('worker identity');
  }
  const lockOptions = await currentWorkerLockOptions();
  const payload = {
    command: 'worker doctor',
    ok: missing.length === 0 && integrity.ok,
    vpdProfile: currentVpdProfilePayload(),
    lifecycle: workerConfig?.lifecycle ?? null,
    transport: workerConfig?.transport ?? null,
    serverUrl: workerConfig?.serverUrl ?? null,
    workspaceId: workerConfig?.workspaceId ?? null,
    workspaceRoot: workerConfig?.workspaceRoot ?? null,
    publicKeyFingerprint: workerConfig?.publicKeyFingerprint ?? null,
    capabilities: workerConfig?.capabilities ?? null,
    processLock: lockStatusForOptions(lockOptions),
    pairingIntegrity: integrity,
    missing,
    supportPacket: supportPacketMetadata(),
  };
  if (asJson) {
    printJson(payload);
    return;
  }
  console.log('Viewport worker doctor');
  console.log(`VPD profile:${formatVpdProfile(payload.vpdProfile)}`);
  console.log(`Mode:      ${payload.lifecycle ?? 'not configured'}`);
  console.log(`Transport: ${payload.transport ?? 'not configured'}`);
  console.log(`Server:    ${payload.serverUrl ?? 'not configured'}`);
  console.log(`Workspace: ${payload.workspaceId ?? 'not paired'}`);
  console.log(`Work root: ${payload.workspaceRoot ?? 'not configured'}`);
  console.log(`Lock:      ${workerLockLabel(payload.processLock)}`);
  console.log(`Support:   ${SUPPORT_PACKET_DOCS_URL}`);
  const agents = payload.capabilities?.agents;
  const agentCount = Array.isArray(agents)
    ? agents.length
    : agents && typeof agents === 'object'
      ? Object.keys(agents).length
      : 0;
  console.log(`Agents:    ${agentCount > 0 ? `${agentCount} detected` : 'not recorded'}`);
  if (missing.length > 0) {
    console.log(`Missing:   ${missing.join(', ')}`);
    console.log('Fix:       run `vpd pair --worker --transport=polling --workdir <path>`.');
    return;
  }
  if (!integrity.ok) {
    console.log(`Mismatch:  ${integrity.mismatches.join(', ')}`);
    console.log('Fix:       run `vpd worker reset`, then pair this worker again.');
    return;
  }
  console.log('Status:    configured');
}

interface ManagedExecutorDoctorPayload {
  command: 'worker doctor';
  ok: boolean;
  runtimeProfile: 'managed-executor';
  vpdProfile: VpdProfilePayload;
  lifecycle: 'persistent';
  transport: string | null;
  serverUrl: string | null;
  serverId: string | null;
  workspaceId: string | null;
  executorId: string | null;
  workspaceRoot: string | null;
  runnerPool: string | null;
  credentialSource: 'inline' | 'file' | 'profile' | null;
  capabilities: Record<string, unknown> | null;
  processLock: SanitizedWorkerProcessLockStatus | null;
  missing: string[];
  warnings: string[];
  supportPacket: ReturnType<typeof supportPacketMetadata>;
}

interface VpdProfilePayload {
  name: string | null;
  source: 'env' | 'current-profile' | 'none';
  home: string;
  baseHome: string;
}

function managedExecutorDoctorProfile(): {
  present: boolean;
  payload: ManagedExecutorDoctorPayload;
} {
  const profilePath =
    getFlag('registration-profile') ?? process.env['VIEWPORT_MANAGED_EXECUTOR_PROFILE_FILE'];
  const profile = profilePath ? readManagedExecutorProfile(profilePath) : {};
  const hasManagedInput = Boolean(
    profilePath ||
    getFlag('server') ||
    getFlag('workspace') ||
    getFlag('resource') ||
    getFlag('executor') ||
    getFlag('credential') ||
    getFlag('credential-file') ||
    process.env['VIEWPORT_SERVER_URL'] ||
    process.env['VPD_SERVER_URL'] ||
    process.env['VIEWPORT_WORKSPACE_ID'] ||
    process.env['VIEWPORT_MANAGED_EXECUTOR_ID'] ||
    process.env['VIEWPORT_MANAGED_EXECUTOR_TOKEN'] ||
    process.env['VPD_MANAGED_EXECUTOR_TOKEN'] ||
    process.env['VIEWPORT_MANAGED_EXECUTOR_TOKEN_FILE'] ||
    process.env['VPD_MANAGED_EXECUTOR_TOKEN_FILE'],
  );

  const credentialFile =
    getFlag('credential-file') ??
    process.env['VIEWPORT_MANAGED_EXECUTOR_TOKEN_FILE'] ??
    process.env['VPD_MANAGED_EXECUTOR_TOKEN_FILE'] ??
    stringValue(profile['credentialFile']) ??
    stringValue(profile['credential_file']);
  const inlineCredential =
    getFlag('credential') ??
    process.env['VIEWPORT_MANAGED_EXECUTOR_TOKEN'] ??
    process.env['VPD_MANAGED_EXECUTOR_TOKEN'] ??
    stringValue(profile['credential']);
  let credentialSource: ManagedExecutorDoctorPayload['credentialSource'] = inlineCredential
    ? profile['credential'] === inlineCredential
      ? 'profile'
      : 'inline'
    : null;
  const missing: string[] = [];
  const warnings: string[] = [];

  if (credentialFile) {
    const readable = credentialFileIsReadable(credentialFile);
    if (readable) {
      credentialSource = 'file';
    } else {
      missing.push('managed executor credential file');
    }
  }
  if (!credentialFile && !inlineCredential) {
    missing.push('managed executor credential');
  }

  const serverUrl =
    getFlag('server') ??
    process.env['VIEWPORT_SERVER_URL'] ??
    process.env['VPD_SERVER_URL'] ??
    stringValue(profile['serverUrl']) ??
    stringValue(profile['server_url']);
  const workspaceId =
    getFlag('workspace') ??
    getFlag('resource') ??
    process.env['VIEWPORT_WORKSPACE_ID'] ??
    stringValue(profile['workspaceId']) ??
    stringValue(profile['workspace_id']);
  const executorId =
    getFlag('executor') ??
    process.env['VIEWPORT_MANAGED_EXECUTOR_ID'] ??
    stringValue(profile['executorId']) ??
    stringValue(profile['executor_id']) ??
    stringValue(profile['managedExecutorId']) ??
    stringValue(profile['managed_executor_id']);
  const workspaceRoot =
    getFlag('workdir') ??
    stringValue(profile['workspaceRoot']) ??
    stringValue(profile['workspace_root']) ??
    stringValue(profile['workdir']);
  if (!serverUrl) missing.push('server URL');
  if (!workspaceId) missing.push('workspace id');
  if (!executorId) missing.push('managed executor id');
  if (!workspaceRoot)
    warnings.push('workspace root not pinned; pass --workdir for predictable checkouts');

  const lockOptions = managedWorkerLockOptions({
    serverUrl,
    workspaceId,
    executorId,
    runnerPool:
      getFlag('runner-pool') ??
      process.env['VIEWPORT_MANAGED_RUNNER_POOL'] ??
      process.env['VIEWPORT_MANAGED_EXECUTOR_RUNNER_POOL'] ??
      stringValue(profile['runnerPool']) ??
      stringValue(profile['runner_pool']),
    transport:
      getFlag('access-mode') ??
      process.env['VIEWPORT_MANAGED_EXECUTOR_ACCESS_MODE'] ??
      stringValue(profile['accessMode']) ??
      stringValue(profile['access_mode']) ??
      'polling',
  });

  return {
    present: hasManagedInput,
    payload: {
      command: 'worker doctor',
      ok: missing.length === 0,
      runtimeProfile: 'managed-executor',
      vpdProfile: currentVpdProfilePayload(),
      lifecycle: 'persistent',
      transport: lockOptions?.accessMode ?? 'polling',
      serverUrl: serverUrl ?? null,
      serverId:
        getFlag('server-id') ??
        process.env['VIEWPORT_SERVER_ID'] ??
        process.env['VPD_SERVER_ID'] ??
        stringValue(profile['serverId']) ??
        stringValue(profile['server_id']) ??
        stringValue(profile['control_plane_id']) ??
        null,
      workspaceId: workspaceId ?? null,
      executorId: executorId ?? null,
      workspaceRoot: workspaceRoot ? path.resolve(workspaceRoot) : null,
      runnerPool: lockOptions?.runnerProfile ?? null,
      credentialSource,
      capabilities: recordValue(profile['capabilities']),
      processLock: lockStatusForOptions(lockOptions),
      missing,
      warnings,
      supportPacket: supportPacketMetadata(),
    },
  };
}

interface SanitizedWorkerProcessLockStatus {
  active: boolean;
  stale: boolean;
  pid: number | null;
  startedAt: string | null;
}

function managedWorkerLockOptions(input: {
  serverUrl: string | undefined;
  workspaceId: string | undefined;
  executorId: string | undefined;
  runnerPool: string | undefined;
  transport: string | undefined;
}): WorkerLockOptions | null {
  if (!input.serverUrl || !input.workspaceId || !input.executorId) {
    return null;
  }

  return {
    server: input.serverUrl,
    workspaceId: input.workspaceId,
    executorId: input.executorId,
    runnerProfile: input.runnerPool,
    accessMode: input.transport ?? 'polling',
  };
}

function currentVpdProfilePayload(): VpdProfilePayload {
  const info = activeProfileInfo();
  return {
    name: info.name,
    source: info.source,
    home: info.home,
    baseHome: info.baseHome,
  };
}

function formatVpdProfile(profile: VpdProfilePayload): string {
  return ` ${profile.name ?? 'default'} (${profile.source})`;
}

function lockStatusForOptions(
  options: WorkerLockOptions | null,
): SanitizedWorkerProcessLockStatus | null {
  if (!options) return null;
  return sanitizeWorkerLockStatus(inspectWorkerProcessLock(options));
}

function sanitizeWorkerLockStatus(
  status: WorkerProcessLockStatus,
): SanitizedWorkerProcessLockStatus {
  return {
    active: status.active,
    stale: Boolean(status.stale),
    pid: status.pid ?? null,
    startedAt: status.startedAt ?? null,
  };
}

function workerLockLabel(status: SanitizedWorkerProcessLockStatus | null): string {
  if (!status) return 'not available';
  if (!status.pid) return 'not active';
  if (status.active) return `active pid ${status.pid}`;
  if (status.stale) return `stale pid ${status.pid}`;
  return 'not active';
}

function readManagedExecutorProfile(profilePath: string): Record<string, unknown> {
  const resolved = resolveProfilePath(profilePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Managed executor registration profile is not a JSON object: ${resolved}`);
  }
  const record = parsed as Record<string, unknown>;
  const daemon = recordValue(record['daemon']);
  const worker = recordValue(daemon?.['worker']);

  return { ...record, ...(worker ?? {}) };
}

function credentialFileIsReadable(filePath: string): boolean {
  try {
    return fs.readFileSync(resolveProfilePath(filePath), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

function resolveProfilePath(profilePath: string): string {
  if (profilePath === '~') return process.env['HOME'] ?? profilePath;
  if (profilePath.startsWith('~/')) {
    const home = process.env['HOME'];
    return home ? path.join(home, profilePath.slice(2)) : path.resolve(profilePath);
  }
  return path.resolve(profilePath);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function workerReset(): Promise<void> {
  const asJson = isJsonMode();
  const forced = hasFlag('force');
  const lockStatus = lockStatusForOptions(await currentWorkerLockOptions());
  if (lockStatus?.active && !forced) {
    if (asJson) {
      printJson({
        command: 'worker reset',
        ok: false,
        reset: false,
        reason: 'active_worker_lock',
        processLock: lockStatus,
        hint: 'Run `vpd worker stop` first, or rerun with `--force` if the worker is already stopped.',
      });
      return;
    }
    console.log(`A persistent worker appears active for this profile (pid ${lockStatus.pid}).`);
    console.log(
      'Run `vpd worker stop` first, or rerun with `--force` if the worker is already stopped.',
    );
    return;
  }

  const result = await resetWorkerProfile();
  if (asJson) {
    printJson({
      command: 'worker reset',
      ok: true,
      reset: result.hadWorkerProfile,
      forced,
      processLock: lockStatus,
      ...result,
    });
    return;
  }
  if (!result.hadWorkerProfile) {
    console.log('No worker profile was configured.');
    return;
  }
  console.log('Worker pairing reset.');
  console.log(
    'Run `vpd pair --worker --transport=polling --workdir <path>` to pair this worker again.',
  );
}

async function workerStop(): Promise<void> {
  const asJson = isJsonMode();
  const options = await currentWorkerLockOptions();
  if (!options) {
    if (asJson) {
      printJson({
        command: 'worker stop',
        ok: false,
        stopped: false,
        reason: 'worker_not_configured',
      });
      return;
    }
    console.log(
      'No worker profile is configured. Run `vpd pair --worker --transport=polling --workdir <path>` first.',
    );
    return;
  }

  const result = stopWorkerProcessLock(options);
  if (asJson) {
    printJson({ command: 'worker stop', ok: true, ...result });
    return;
  }
  if (result.stopped) {
    console.log(`Sent ${result.signal ?? 'SIGTERM'} to worker pid ${result.pid}.`);
    return;
  }
  if (result.stale) {
    console.log(`Removed stale worker lock for pid ${result.pid}.`);
    return;
  }
  console.log('No persistent worker lock is active for this profile.');
}

async function workerStart(): Promise<void> {
  const asJson = isJsonMode();
  const lifecycle = normalizeWorkerLifecycle(getFlag('mode') ?? getFlag('lifecycle'));
  if (lifecycle !== 'persistent') {
    throw new Error('Use `vpd worker run-once` for ephemeral workers.');
  }
  const result = await runStandaloneWorker({
    lifecycle,
    transport: normalizeWorkerTransport(getFlag('transport')),
    once: getArgs().includes('--once'),
    leaseSeconds: positiveIntFlag(getFlag('lease')) ?? DEFAULT_WORKER_LEASE_SECONDS,
  });
  if (asJson) {
    printJson({ command: 'worker start', ok: true, ...result });
    return;
  }
  console.log(
    `Worker stopped. Claimed ${result.claimed}, completed ${result.completed}, failed ${result.failed}, cleanup ${result.cleanup}.`,
  );
}

function positiveIntFlag(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('--lease must be a positive integer number of seconds.');
  }
  return parsed;
}

async function workerRunOnce(): Promise<void> {
  const asJson = isJsonMode();
  const lease = getFlag('lease');
  if (!lease || lease.trim() === '') {
    throw new Error(
      'Usage: vpd worker run-once --lease <lease-token> [--transport polling|relay|inbound]',
    );
  }
  const result = await runStandaloneWorker({
    lifecycle: 'ephemeral',
    transport: normalizeWorkerTransport(getFlag('transport')),
    once: true,
    leaseToken: lease.trim(),
  });
  if (asJson) {
    printJson({ command: 'worker run-once', ok: true, ...result });
    return;
  }
  console.log(`Worker run-once complete. Cleanup receipts: ${result.cleanup}.`);
}

async function currentWorkerLockOptions(): Promise<WorkerLockOptions | null> {
  const manager = new ConfigManager();
  await manager.load();
  const workerConfig = manager.getDaemonConfig()?.worker;
  if (!workerConfig?.serverUrl || !workerConfig.publicKeyFingerprint) {
    return null;
  }

  return {
    server: workerConfig.serverUrl,
    workspaceId: workerConfig.workspaceId ?? workerConfig.publicKeyFingerprint,
    executorId: workerConfig.managedExecutorId ?? workerConfig.publicKeyFingerprint,
    runnerProfile: runnerPoolFromCapabilities(workerConfig.capabilities ?? {}),
    accessMode: workerConfig.transport ?? 'polling',
  };
}

function runnerPoolFromCapabilities(capabilities: Record<string, unknown>): string | undefined {
  const value = capabilities['runner_pool'] ?? capabilities['runnerPool'];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
