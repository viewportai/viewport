import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { configDir } from '../core/config.js';
import type { DeploymentProfile } from '../server/security.js';

const DAEMON_STATE_FILE = 'daemon-state.json';
export const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const STOP_POLL_INTERVAL_MS = 150;
const FORCE_KILL_TIMEOUT_MS = 4_000;

export interface DaemonProcessInfo {
  pid: number;
  uid?: number;
  startedAt?: string;
  command?: string;
}

export interface DaemonRuntimeState {
  pid: number;
  ownerPid: number;
  workerPid?: number;
  port: number;
  host: string;
  listen?: string;
  socketPath?: string;
  startedAt: number;
  version: string;
  mode: 'supervisor' | 'worker';
  ownerUid?: number;
  ownerHostname?: string;
  ownerStartedAt?: string;
  ownerCommand?: string;
  logPath?: string;
  profile?: DeploymentProfile;
  authEnabled?: boolean;
  allowedHostsRaw?: string;
  allowedOriginsRaw?: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayServerUrl?: string;
  relayWorkspaceId?: string;
  relayTlsVerify?: 'auto' | '0' | '1';
  tlsEnabled?: boolean;
  tlsHost?: string;
  runtimeKind?: 'managed' | 'local-dev' | 'self-hosted';
  daemonHome?: string;
  daemonHomeScope?: 'global' | 'isolated';
  serverUrl?: string;
}

function daemonStatePath(): string {
  return path.join(configDir(), DAEMON_STATE_FILE);
}

export async function readDaemonRuntimeState(): Promise<DaemonRuntimeState | null> {
  try {
    const raw = await fs.readFile(daemonStatePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DaemonRuntimeState>;
    const ownerPid = typeof parsed.ownerPid === 'number' ? parsed.ownerPid : parsed.pid;
    if (typeof ownerPid !== 'number') return null;

    if (
      typeof parsed.port !== 'number' ||
      typeof parsed.host !== 'string' ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.version !== 'string'
    ) {
      return null;
    }

    const mode = parsed.mode === 'supervisor' || parsed.mode === 'worker' ? parsed.mode : 'worker';
    const socketPath = typeof parsed.socketPath === 'string' ? parsed.socketPath : undefined;
    const listen =
      typeof parsed.listen === 'string'
        ? parsed.listen
        : socketPath
          ? `unix://${socketPath}`
          : `${parsed.host}:${parsed.port}`;

    const pid =
      typeof parsed.pid === 'number'
        ? parsed.pid
        : typeof parsed.workerPid === 'number'
          ? parsed.workerPid
          : ownerPid;

    return {
      pid,
      ownerPid,
      workerPid: typeof parsed.workerPid === 'number' ? parsed.workerPid : undefined,
      port: parsed.port,
      host: parsed.host,
      listen,
      socketPath,
      startedAt: parsed.startedAt,
      version: parsed.version,
      mode,
      ownerUid: typeof parsed.ownerUid === 'number' ? parsed.ownerUid : undefined,
      ownerHostname: typeof parsed.ownerHostname === 'string' ? parsed.ownerHostname : undefined,
      ownerStartedAt: typeof parsed.ownerStartedAt === 'string' ? parsed.ownerStartedAt : undefined,
      ownerCommand: typeof parsed.ownerCommand === 'string' ? parsed.ownerCommand : undefined,
      logPath: typeof parsed.logPath === 'string' ? parsed.logPath : undefined,
      profile:
        parsed.profile === 'local' || parsed.profile === 'lan' || parsed.profile === 'relay'
          ? parsed.profile
          : undefined,
      authEnabled: typeof parsed.authEnabled === 'boolean' ? parsed.authEnabled : undefined,
      allowedHostsRaw:
        typeof parsed.allowedHostsRaw === 'string' ? parsed.allowedHostsRaw : undefined,
      allowedOriginsRaw:
        typeof parsed.allowedOriginsRaw === 'string' ? parsed.allowedOriginsRaw : undefined,
      relayEnabled: typeof parsed.relayEnabled === 'boolean' ? parsed.relayEnabled : undefined,
      relayEndpoint: typeof parsed.relayEndpoint === 'string' ? parsed.relayEndpoint : undefined,
      relayServerUrl: typeof parsed.relayServerUrl === 'string' ? parsed.relayServerUrl : undefined,
      relayWorkspaceId:
        typeof parsed.relayWorkspaceId === 'string' ? parsed.relayWorkspaceId : undefined,
      relayTlsVerify:
        parsed.relayTlsVerify === 'auto' ||
        parsed.relayTlsVerify === '0' ||
        parsed.relayTlsVerify === '1'
          ? parsed.relayTlsVerify
          : undefined,
      tlsEnabled: typeof parsed.tlsEnabled === 'boolean' ? parsed.tlsEnabled : undefined,
      tlsHost: typeof parsed.tlsHost === 'string' ? parsed.tlsHost : undefined,
      runtimeKind:
        parsed.runtimeKind === 'managed' ||
        parsed.runtimeKind === 'local-dev' ||
        parsed.runtimeKind === 'self-hosted'
          ? parsed.runtimeKind
          : undefined,
      daemonHome: typeof parsed.daemonHome === 'string' ? parsed.daemonHome : undefined,
      daemonHomeScope:
        parsed.daemonHomeScope === 'global' || parsed.daemonHomeScope === 'isolated'
          ? parsed.daemonHomeScope
          : undefined,
      serverUrl: typeof parsed.serverUrl === 'string' ? parsed.serverUrl : undefined,
    };
  } catch {
    return null;
  }
}

export async function writeDaemonRuntimeState(state: DaemonRuntimeState): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  const ownerPid = typeof state.ownerPid === 'number' ? state.ownerPid : state.pid;
  if (typeof ownerPid !== 'number') {
    throw new Error('Daemon runtime state requires ownerPid');
  }
  const pid =
    typeof state.pid === 'number'
      ? state.pid
      : typeof state.workerPid === 'number'
        ? state.workerPid
        : ownerPid;
  const normalized: DaemonRuntimeState = {
    ...state,
    pid,
    ownerPid,
    listen:
      typeof state.listen === 'string'
        ? state.listen
        : typeof state.socketPath === 'string'
          ? `unix://${state.socketPath}`
          : `${state.host}:${state.port}`,
  };
  await fs.writeFile(daemonStatePath(), JSON.stringify(normalized, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export async function clearDaemonRuntimeState(): Promise<void> {
  try {
    await fs.rm(daemonStatePath(), { force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

function readNodeErrnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

export function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = readNodeErrnoCode(err);
    return code === 'EPERM';
  }
}

export function signalProcessSafely(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    const code = readNodeErrnoCode(err);
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw err;
  }
}

export function signalProcessGroupSafely(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    return false;
  }

  if (process.platform === 'win32') {
    return signalProcessSafely(pid, signal);
  }

  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    const code = readNodeErrnoCode(err);
    if (code === 'ESRCH') {
      return signalProcessSafely(pid, signal);
    }
    if (code === 'EPERM') {
      return true;
    }
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) {
      return true;
    }
    await sleep(STOP_POLL_INTERVAL_MS);
  }
  return !isPidRunning(pid);
}

export interface StopPidOptions {
  timeoutMs?: number;
  force?: boolean;
  useProcessGroup?: boolean;
}

export async function stopPid(
  pid: number,
  options: StopPidOptions | number = {},
): Promise<'stopped' | 'not-running' | 'force-stopped'> {
  const normalizedOptions: StopPidOptions =
    typeof options === 'number' ? { timeoutMs: options } : options;
  const timeoutMs = normalizedOptions.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  if (!isPidRunning(pid)) return 'not-running';

  const requested = normalizedOptions.useProcessGroup
    ? signalProcessGroupSafely(pid, 'SIGTERM')
    : signalProcessSafely(pid, 'SIGTERM');

  if (!requested) {
    return 'not-running';
  }

  let stopped = await waitForPidExit(pid, timeoutMs);
  if (stopped) return 'stopped';

  if (!normalizedOptions.force) {
    throw new Error(`Timed out waiting for daemon process ${pid} to exit`);
  }

  if (normalizedOptions.useProcessGroup) {
    signalProcessGroupSafely(pid, 'SIGKILL');
  } else {
    signalProcessSafely(pid, 'SIGKILL');
  }
  stopped = await waitForPidExit(pid, FORCE_KILL_TIMEOUT_MS);
  if (!stopped) {
    throw new Error(`Timed out waiting for daemon process ${pid} to exit after SIGKILL`);
  }
  return 'force-stopped';
}

function parseUid(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed)) return undefined;
  return parsed;
}

export function readProcessInfo(pid: number): DaemonProcessInfo | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  const result = spawnSync('ps', ['-p', String(pid), '-o', 'uid=,lstart=,command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    return null;
  }

  const line = result.stdout
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) return null;

  const parts = line.split(/\s+/);
  if (parts.length < 7) {
    return {
      pid,
      command: line,
    };
  }

  const uid = parseUid(parts[0] ?? '');
  const startedAt = parts.slice(1, 6).join(' ');
  const command = parts.slice(6).join(' ');

  return {
    pid,
    uid,
    startedAt: startedAt.length > 0 ? startedAt : undefined,
    command: command.length > 0 ? command : undefined,
  };
}

export function isOwnershipMatch(
  state: DaemonRuntimeState,
  processInfo: DaemonProcessInfo | null,
): boolean {
  if (!processInfo) return false;

  if (
    state.ownerUid !== undefined &&
    processInfo.uid !== undefined &&
    state.ownerUid !== processInfo.uid
  ) {
    return false;
  }

  if (
    state.ownerStartedAt &&
    processInfo.startedAt &&
    state.ownerStartedAt.trim() !== processInfo.startedAt.trim()
  ) {
    return false;
  }

  if (
    state.ownerCommand &&
    processInfo.command &&
    !processInfo.command.includes(state.ownerCommand)
  ) {
    return false;
  }

  if (state.ownerHostname) {
    const localHostnames = new Set<string>(['localhost', os.hostname()]);
    if (process.env['HOSTNAME']) localHostnames.add(process.env['HOSTNAME']);
    if (!localHostnames.has(state.ownerHostname)) {
      return false;
    }
  }

  return true;
}
