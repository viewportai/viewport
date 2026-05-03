import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { configDir, resolveProjectConfig } from '../core/config.js';
import {
  readProcessInfo,
  writeDaemonRuntimeState,
  clearDaemonRuntimeState,
  signalProcessGroupSafely,
  signalProcessSafely,
} from './daemon-lifecycle.js';
import { resolveDaemonRuntimeIdentity } from '../core/runtime-identity.js';
import {
  SUPERVISOR_CONFIG_ENV,
  WORKER_CONFIG_ENV,
  WORKER_EXIT_RESTART,
  WORKER_EXIT_SHUTDOWN,
  type RuntimeLaunchConfig,
} from './supervisor-protocol.js';
import { decodeRuntimeConfig, encodeRuntimeConfig } from './supervisor-runtime-config.js';
import { resolveDaemonSettingsFromSources } from './daemon-settings.js';
import { resolveLocalTlsState } from './local-tls.js';

const SUPERVISOR_STARTUP_GRACE_MS = 1_500;
function resolveCliEntry(): string {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error('Unable to resolve CLI entry path for supervisor launch');
  }
  return path.resolve(entry);
}

function buildWorkerEnv(config: RuntimeLaunchConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[SUPERVISOR_CONFIG_ENV];
  delete env[WORKER_CONFIG_ENV];
  env[WORKER_CONFIG_ENV] = encodeRuntimeConfig(config);
  return env;
}

function buildSupervisorEnv(config: RuntimeLaunchConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[SUPERVISOR_CONFIG_ENV];
  delete env[WORKER_CONFIG_ENV];
  env[SUPERVISOR_CONFIG_ENV] = encodeRuntimeConfig(config);
  return env;
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
  const tls = resolveLocalTlsState();
  const identity = resolveDaemonRuntimeIdentity({
    daemonConfig: {
      profile: config.profile,
      server: {
        url: config.serverUrl,
        tlsVerify: config.serverTlsVerify,
        caCertPath: config.serverCaCertPath,
        tlsPins: config.serverTlsPins,
      },
      relay: {
        enabled: config.relayEnabled,
        endpoint: config.relayEndpoint,
        serverUrl: config.relayServerUrl,
        workspaceId: config.relayWorkspaceId,
        projectMachineBindingId: config.relayProjectMachineBindingId,
        machineId: config.relayMachineId,
      },
    },
    daemonVersion: config.version,
  });
  const projectConfig = resolveProjectConfig(process.env);
  await writeDaemonRuntimeState({
    pid: workerPid ?? process.pid,
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
    relayProjectMachineBindingId: config.relayProjectMachineBindingId,
    relayMachineId: config.relayMachineId,
    relayTlsVerify: config.relayTlsVerify,
    tlsEnabled: tls.enabled,
    tlsHost: tls.host,
    tlsCertDir: tls.certDir,
    tlsCertPath: tls.certPath,
    tlsKeyPath: tls.keyPath,
    runtimeKind: identity.runtimeKind,
    daemonHome: identity.daemonHome,
    daemonHomeScope: identity.daemonHomeScope,
    serverUrl: identity.serverUrl,
    projectConfigDir: projectConfig.dir ?? undefined,
    projectConfigSource: projectConfig.source ?? undefined,
  });
}

function launchWorker(config: RuntimeLaunchConfig): ChildProcess {
  return spawn(process.execPath, toWorkerArgs(), {
    env: buildWorkerEnv(config),
    stdio: 'inherit',
  });
}

export async function runSupervisorFromEnv(): Promise<number> {
  let config = decodeRuntimeConfig(process.env[SUPERVISOR_CONFIG_ENV]);
  let stopping = false;
  let restarting = false;
  let worker: ChildProcess | null = null;

  const reloadConfig = async (): Promise<void> => {
    try {
      const resolved = await resolveDaemonSettingsFromSources();
      config = {
        ...config,
        ...resolved.launch,
        listen: config.listen,
        host: config.host,
        port: config.port,
        socketPath: config.socketPath,
        profile: config.profile,
        authEnabled: config.authEnabled,
        allowedHostsRaw: config.allowedHostsRaw,
        allowedOriginsRaw: config.allowedOriginsRaw,
        detached: config.detached,
        logPath: config.logPath ?? resolved.launch.logPath,
      };
    } catch (error) {
      console.warn(
        `[supervisor] failed to reload daemon config after restart request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

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
      setTimeout(() => {
        if (stopping) return;
        void (async () => {
          if (restarting) {
            await reloadConfig();
          }
          restarting = false;
          spawnWorker();
        })();
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
