import { openSync, closeSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { configDir } from '../core/config.js';
import {
  readProcessInfo,
  writeDaemonRuntimeState,
  clearDaemonRuntimeState,
  signalProcessGroupSafely,
  signalProcessSafely,
} from './daemon-lifecycle.js';
import {
  SUPERVISOR_CONFIG_ENV,
  WORKER_CONFIG_ENV,
  WORKER_EXIT_RESTART,
  WORKER_EXIT_SHUTDOWN,
  type RuntimeLaunchConfig,
} from './supervisor-protocol.js';

const SUPERVISOR_STARTUP_GRACE_MS = 1_500;

function resolveCliEntry(): string {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error('Unable to resolve CLI entry path for supervisor launch');
  }
  return path.resolve(entry);
}

function encodeRuntimeConfig(config: RuntimeLaunchConfig): string {
  return Buffer.from(JSON.stringify(config), 'utf-8').toString('base64url');
}

function decodeRuntimeConfig(raw: string | undefined): RuntimeLaunchConfig {
  if (!raw) {
    throw new Error('Missing runtime launch config');
  }
  const decoded = Buffer.from(raw, 'base64url').toString('utf-8');
  const parsed = JSON.parse(decoded) as Partial<RuntimeLaunchConfig>;
  if (
    typeof parsed.host !== 'string' ||
    typeof parsed.port !== 'number' ||
    typeof parsed.version !== 'string' ||
    (parsed.profile !== 'local' && parsed.profile !== 'lan' && parsed.profile !== 'relay') ||
    typeof parsed.authEnabled !== 'boolean' ||
    typeof parsed.detached !== 'boolean'
  ) {
    throw new Error('Invalid runtime launch config');
  }
  const listen =
    typeof parsed.listen === 'string'
      ? parsed.listen
      : typeof parsed.socketPath === 'string'
        ? `unix://${parsed.socketPath}`
        : `${parsed.host}:${parsed.port}`;
  return {
    listen,
    host: parsed.host,
    port: parsed.port,
    socketPath: typeof parsed.socketPath === 'string' ? parsed.socketPath : undefined,
    version: parsed.version,
    profile: parsed.profile,
    allowedHostsRaw:
      typeof parsed.allowedHostsRaw === 'string' ? parsed.allowedHostsRaw : undefined,
    allowedOriginsRaw:
      typeof parsed.allowedOriginsRaw === 'string' ? parsed.allowedOriginsRaw : undefined,
    authEnabled: parsed.authEnabled,
    detached: parsed.detached,
    logPath: typeof parsed.logPath === 'string' ? parsed.logPath : undefined,
    relayEnabled: typeof parsed.relayEnabled === 'boolean' ? parsed.relayEnabled : undefined,
    relayEndpoint: typeof parsed.relayEndpoint === 'string' ? parsed.relayEndpoint : undefined,
    relayServerUrl: typeof parsed.relayServerUrl === 'string' ? parsed.relayServerUrl : undefined,
    relayWorkspaceId:
      typeof parsed.relayWorkspaceId === 'string' ? parsed.relayWorkspaceId : undefined,
    relayEnrollToken:
      typeof parsed.relayEnrollToken === 'string' ? parsed.relayEnrollToken : undefined,
    relayIssueToken:
      typeof parsed.relayIssueToken === 'string' ? parsed.relayIssueToken : undefined,
    relayTlsVerify:
      parsed.relayTlsVerify === 'auto' ||
      parsed.relayTlsVerify === '0' ||
      parsed.relayTlsVerify === '1'
        ? parsed.relayTlsVerify
        : undefined,
    relayCaCertPath:
      typeof parsed.relayCaCertPath === 'string' ? parsed.relayCaCertPath : undefined,
    relayTlsPins:
      Array.isArray(parsed.relayTlsPins) &&
      parsed.relayTlsPins.every((entry) => typeof entry === 'string')
        ? parsed.relayTlsPins
        : undefined,
    relayTokenIssuer:
      typeof parsed.relayTokenIssuer === 'string' ? parsed.relayTokenIssuer : undefined,
    relayTokenAudience:
      typeof parsed.relayTokenAudience === 'string' ? parsed.relayTokenAudience : undefined,
    relayTokenJwksUrl:
      typeof parsed.relayTokenJwksUrl === 'string' ? parsed.relayTokenJwksUrl : undefined,
    relayTokenSigningKeys:
      parsed.relayTokenSigningKeys &&
      typeof parsed.relayTokenSigningKeys === 'object' &&
      !Array.isArray(parsed.relayTokenSigningKeys)
        ? (parsed.relayTokenSigningKeys as Record<string, string>)
        : undefined,
    relayTokenClockSkewSec:
      typeof parsed.relayTokenClockSkewSec === 'number' &&
      Number.isInteger(parsed.relayTokenClockSkewSec) &&
      parsed.relayTokenClockSkewSec >= 0
        ? parsed.relayTokenClockSkewSec
        : undefined,
  };
}

function ensureHerdCaCert(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env['NODE_EXTRA_CA_CERTS']) return env;
  const herdCaPath = path.join(
    os.homedir(),
    'Library', 'Application Support', 'Herd', 'config', 'valet', 'CA',
    'LaravelValetCASelfSigned.pem',
  );
  if (existsSync(herdCaPath)) {
    return { ...env, NODE_EXTRA_CA_CERTS: herdCaPath };
  }
  return env;
}

function buildWorkerEnv(config: RuntimeLaunchConfig): NodeJS.ProcessEnv {
  return ensureHerdCaCert({
    ...process.env,
    [WORKER_CONFIG_ENV]: encodeRuntimeConfig(config),
  });
}

function buildSupervisorEnv(config: RuntimeLaunchConfig): NodeJS.ProcessEnv {
  return ensureHerdCaCert({
    ...process.env,
    [SUPERVISOR_CONFIG_ENV]: encodeRuntimeConfig(config),
  });
}

function toWorkerArgs(): string[] {
  return [...process.execArgv, resolveCliEntry(), '__worker'];
}

function toSupervisorArgs(): string[] {
  return [...process.execArgv, resolveCliEntry(), '__supervisor'];
}

export function defaultLogPath(): string {
  return path.join(configDir(), 'daemon.log');
}

export async function startSupervisorDetached(config: RuntimeLaunchConfig): Promise<{
  pid: number | null;
  logPath: string;
}> {
  await import('node:fs/promises').then((fs) => fs.mkdir(configDir(), { recursive: true }));

  const logPath = config.logPath ?? defaultLogPath();
  const logFd = openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, toSupervisorArgs(), {
      detached: true,
      env: buildSupervisorEnv({ ...config, detached: true, logPath }),
      stdio: ['ignore', logFd, logFd],
    });

    child.unref();

    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => finish(), SUPERVISOR_STARTUP_GRACE_MS);
      child.once('error', (err) => {
        clearTimeout(timer);
        finish(err);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        finish(
          new Error(`Supervisor exited early (${code ?? 'unknown'}${signal ? ` ${signal}` : ''})`),
        );
      });
    });

    return { pid: child.pid ?? null, logPath };
  } finally {
    closeSync(logFd);
  }
}

export async function runSupervisorForeground(config: RuntimeLaunchConfig): Promise<number> {
  const env = buildSupervisorEnv({
    ...config,
    detached: false,
    logPath: config.logPath ?? defaultLogPath(),
  });
  const child = spawn(process.execPath, toSupervisorArgs(), {
    env,
    stdio: 'inherit',
  });
  return await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        resolve(1);
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

async function writeState(config: RuntimeLaunchConfig, workerPid?: number): Promise<void> {
  const ownerInfo = readProcessInfo(process.pid);
  await writeDaemonRuntimeState({
    ownerPid: process.pid,
    workerPid,
    port: config.port,
    host: config.host,
    listen: config.listen,
    socketPath: config.socketPath,
    startedAt: Date.now(),
    version: config.version,
    mode: 'supervisor',
    ownerUid: ownerInfo?.uid,
    ownerHostname: os.hostname(),
    ownerStartedAt: ownerInfo?.startedAt,
    ownerCommand: '__supervisor',
    logPath: config.logPath,
    profile: config.profile,
    authEnabled: config.authEnabled,
    allowedHostsRaw: config.allowedHostsRaw,
    allowedOriginsRaw: config.allowedOriginsRaw,
    relayEnabled: config.relayEnabled,
    relayEndpoint: config.relayEndpoint,
    relayServerUrl: config.relayServerUrl,
    relayWorkspaceId: config.relayWorkspaceId,
    relayTlsVerify: config.relayTlsVerify,
  });
}

function launchWorker(config: RuntimeLaunchConfig): ChildProcess {
  return spawn(process.execPath, toWorkerArgs(), {
    env: buildWorkerEnv(config),
    stdio: 'inherit',
  });
}

export async function runSupervisorFromEnv(): Promise<number> {
  const config = decodeRuntimeConfig(process.env[SUPERVISOR_CONFIG_ENV]);
  let stopping = false;
  let restarting = false;
  let worker: ChildProcess | null = null;

  const requestWorkerStop = (signal: NodeJS.Signals): void => {
    stopping = true;
    if (!worker?.pid) return;
    if (!signalProcessGroupSafely(worker.pid, signal)) {
      signalProcessSafely(worker.pid, signal);
    }
  };

  process.on('SIGTERM', () => requestWorkerStop('SIGTERM'));
  process.on('SIGINT', () => requestWorkerStop('SIGINT'));

  await import('node:fs/promises').then((fs) => fs.mkdir(configDir(), { recursive: true }));
  await writeState(config, undefined);

  const spawnWorker = () => {
    worker = launchWorker(config);
    void writeState(config, worker.pid);

    worker.once('exit', (code, signal) => {
      const exitCode = code ?? 0;
      if (
        stopping ||
        signal === 'SIGTERM' ||
        signal === 'SIGINT' ||
        exitCode === WORKER_EXIT_SHUTDOWN
      ) {
        stopping = true;
        void clearDaemonRuntimeState().finally(() => process.exit(0));
        return;
      }

      if (exitCode === WORKER_EXIT_RESTART) {
        restarting = true;
      }

      const delay = restarting ? 250 : 1_000;
      restarting = false;
      setTimeout(() => {
        if (stopping) return;
        spawnWorker();
      }, delay);
    });
  };

  spawnWorker();

  return await new Promise<number>((resolve) => {
    process.on('exit', () => {
      resolve(0);
    });
  });
}

export function loadWorkerConfigFromEnv(): RuntimeLaunchConfig {
  return decodeRuntimeConfig(process.env[WORKER_CONFIG_ENV]);
}
