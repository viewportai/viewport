import { spawn } from 'node:child_process';
import os from 'node:os';
import { configDir, ConfigManager } from '../core/config.js';
import type { ViewportConfig } from '../core/config.js';
import { getArgs, getFlag, hasFlag } from './args.js';
import { resolveDaemonEndpoint } from './daemon-client.js';
import type { DaemonEndpoint } from './daemon-client.js';
import {
  clearDaemonRuntimeState,
  readDaemonRuntimeState,
  stopPid,
  DEFAULT_STOP_TIMEOUT_MS,
  waitForPidExit,
  readProcessInfo,
  isOwnershipMatch,
  isPidRunning,
  type DaemonRuntimeState,
} from './daemon-lifecycle.js';
import {
  compareSemver,
  fetchLatestVersion,
  formatNpmInvocation,
  resolveNpmInvocationFromNode,
  resolvePreferredNodePath,
  type NpmInvocation,
} from './runtime-toolchain.js';
import { startWithLaunchConfig } from '../startup.js';
import {
  isJsonMode,
  parseTimeoutMs,
  printJson,
  readDaemonHealth,
  requestLifecycle,
  shortError,
  waitForDaemonReady,
} from './command-shared.js';
import { resolveDaemonSettingsFromSources } from './daemon-settings.js';
import { inferRelayEndpointFromServer } from './remote-commands.js';
import { getOrCreateTrustAnchor, rotateAuthToken } from '../server/pairing-offers.js';
import { loadOrCreateIdentity as loadOrCreateRelayIdentity } from '../relay/bridge-key-exchange.js';
import { parseCsvList, parseTlsVerifyMode, transportFetch } from './network.js';
import {
  formatDaemonHomeLabel,
  formatRuntimeKindLabel,
  resolveDaemonRuntimeIdentity,
  toInstallCapabilities,
} from '../core/runtime-identity.js';
import {
  resolveCliEntrypointPath,
  resolveDisplayVersion,
  resolvePackageName,
  resolvePackageRoot,
  resolvePackageSourceInfo,
} from '../core/package-meta.js';

function endpointHealthUrl(endpoint: DaemonEndpoint): string {
  if (endpoint.type === 'socket') {
    return `unix://${endpoint.socketPath}:/health`;
  }
  return `${endpoint.baseUrl}/health`;
}

function endpointListenLabel(endpoint: DaemonEndpoint): string {
  if (endpoint.type === 'socket') {
    return `unix://${endpoint.socketPath}`;
  }
  return `${endpoint.host}:${endpoint.port}`;
}

export async function status(): Promise<void> {
  const asJson = isJsonMode();
  const shouldCheckUpdates = hasFlag('check-updates');
  const endpoint = await resolveDaemonEndpoint();
  const url = endpointHealthUrl(endpoint);
  const state = await readDaemonRuntimeState();
  const runningByState = !!(state && isPidRunning(state.ownerPid));
  const health = await readDaemonHealth();

  const statusValue: 'running' | 'stopped' | 'unresponsive' = health
    ? 'running'
    : runningByState
      ? 'unresponsive'
      : 'stopped';

  const owner =
    state?.ownerUid !== undefined
      ? `${state.ownerUid}@${state.ownerHostname ?? 'unknown-host'}`
      : null;
  const resolvedNode = resolvePreferredNodePath({
    daemonPid: state?.ownerPid ?? null,
    fallbackNodePath: process.execPath,
  });

  let runtimeNpm = 'unknown';
  let npmInvocation: NpmInvocation | null = null;
  try {
    npmInvocation = resolveNpmInvocationFromNode(resolvedNode.nodePath);
    runtimeNpm = formatNpmInvocation(npmInvocation);
  } catch (err) {
    runtimeNpm = `unresolved (${shortError(err)})`;
  }

  const manager = new ConfigManager();
  await manager.load();
  const cliVersion = resolveDisplayVersion();
  const cliSource = resolvePackageSourceInfo();
  const runtimeIdentity = resolveDaemonRuntimeIdentity({
    daemonConfig: manager.getDaemonConfig(),
    machineId: manager.getMachineId(),
    daemonVersion: health?.machine?.daemonVersion ?? state?.version ?? cliVersion,
  });
  const configPaths = manager.getConfigPaths();
  let latestCliVersion = 'skipped';
  let updateStatus = 'skipped (use --check-updates)';
  let note: string | undefined;
  if (npmInvocation && shouldCheckUpdates) {
    const latest = fetchLatestVersion({ npm: npmInvocation, packageName: resolvePackageName() });
    if (latest.version) {
      latestCliVersion = latest.version;
      const comparison = compareSemver(cliVersion, latest.version);
      if (comparison === null) {
        updateStatus = 'unknown (version format not comparable)';
      } else if (comparison < 0) {
        updateStatus = `update available (${cliVersion} -> ${latest.version})`;
      } else {
        updateStatus = 'up to date';
      }
    } else {
      note = latest.note;
      updateStatus = latest.note ?? 'unknown';
    }
  }

  const payload = {
    status: statusValue,
    endpoint: url,
    home: configDir(),
    ownerPid: state?.ownerPid ?? null,
    workerPid: state?.workerPid ?? health?.pid ?? null,
    owner,
    listen: state?.listen ?? health?.listen ?? endpointListenLabel(endpoint),
    socketPath:
      state?.socketPath ??
      health?.socketPath ??
      (endpoint.type === 'socket' ? endpoint.socketPath : null),
    startedAt: state?.startedAt ?? health?.startedAt ?? null,
    profile: health?.machine?.profile ?? state?.profile ?? runtimeIdentity.profile ?? null,
    runtimeKind: health?.machine?.runtimeKind ?? state?.runtimeKind ?? runtimeIdentity.runtimeKind,
    daemonHome: health?.machine?.daemonHome ?? state?.daemonHome ?? runtimeIdentity.daemonHome,
    daemonHomeScope:
      health?.machine?.daemonHomeScope ?? state?.daemonHomeScope ?? runtimeIdentity.daemonHomeScope,
    serverUrl: health?.machine?.serverUrl ?? state?.serverUrl ?? runtimeIdentity.serverUrl ?? null,
    relayEndpoint:
      health?.machine?.relayEndpoint ??
      state?.relayEndpoint ??
      runtimeIdentity.relayEndpoint ??
      null,
    relayServerUrl:
      health?.machine?.relayServerUrl ??
      state?.relayServerUrl ??
      runtimeIdentity.relayServerUrl ??
      null,
    runtimeNode: `${resolvedNode.nodePath} (${resolvedNode.source})`,
    runtimeNpm,
    cliVersion,
    latestCliVersion,
    updateStatus,
    health,
    relayState: health?.relay?.state ?? null,
    relayReconnectAttempt: health?.relay?.reconnectAttempt ?? null,
    relayLastErrorCode: health?.relay?.lastErrorCode ?? null,
    relayLastErrorMessage: health?.relay?.lastErrorMessage ?? null,
    note,
    configSource: configPaths.projectOverridePath
      ? `project override (${configPaths.projectOverridePath})`
      : `global (${configPaths.globalPath})`,
    configReason: runtimeIdentity.projectConfigSource
      ? runtimeIdentity.projectConfigSource === 'explicit'
        ? 'explicit VIEWPORT_PROJECT_CONFIG_DIR override'
        : 'nearest ancestor .viewport/config.json'
      : 'global ~/.viewport/config.json',
    cliSource:
      cliSource.kind === 'linked-local-build'
        ? `linked local build${cliSource.gitRef ? ` (${cliSource.gitRef})` : ''}`
        : 'installed package',
  };

  if (asJson) {
    printJson(payload);
    return;
  }

  console.log(`Status:      ${payload.status}`);
  console.log(
    `Runtime:     ${formatRuntimeKindLabel(payload.runtimeKind)} (${payload.daemonHomeScope})`,
  );
  console.log(`Home:        ${formatDaemonHomeLabel(runtimeIdentity)}`);
  console.log(`Listen:      ${payload.listen}`);
  if (payload.socketPath) {
    console.log(`Socket:      ${payload.socketPath}`);
  }
  console.log(`Owner PID:   ${payload.ownerPid ?? '-'}`);
  console.log(`Worker PID:  ${payload.workerPid ?? '-'}`);
  console.log(`Owner:       ${payload.owner ?? '-'}`);
  console.log(
    `Started:     ${payload.startedAt ? new Date(payload.startedAt).toISOString() : '-'}`,
  );
  console.log(`Profile:     ${payload.profile ?? '-'}`);
  console.log(`Server:      ${payload.serverUrl ?? '-'}`);
  console.log(`Relay WS:    ${payload.relayEndpoint ?? '-'}`);
  console.log(`Relay API:   ${payload.relayServerUrl ?? '-'}`);
  console.log(`Relay state: ${payload.relayState ?? '-'}`);
  if (payload.relayReconnectAttempt) {
    console.log(`Relay tries: ${payload.relayReconnectAttempt}`);
  }
  if (payload.relayLastErrorCode || payload.relayLastErrorMessage) {
    console.log(
      `Relay last:  ${payload.relayLastErrorCode ?? 'UNKNOWN'}${payload.relayLastErrorMessage ? ` — ${payload.relayLastErrorMessage}` : ''}`,
    );
  }
  console.log(`Node:        ${payload.runtimeNode}`);
  console.log(`npm:         ${payload.runtimeNpm}`);
  console.log(`CLI:         ${payload.cliVersion}`);
  console.log(`CLI source:  ${payload.cliSource}`);
  console.log(`Latest CLI:  ${payload.latestCliVersion}`);
  console.log(`Update:      ${payload.updateStatus}`);
  console.log(`Config:      ${payload.configSource}`);
  console.log(`Reason:      ${payload.configReason}`);
  if (payload.health) {
    console.log(`Sessions:    ${payload.health.sessions}`);
    console.log(`Directories: ${payload.health.directories}`);
    console.log(`Agents:      ${payload.health.agents}`);
  }
  if (payload.note) {
    console.log(`Note:        ${payload.note}`);
  }
}

export async function doctor(): Promise<void> {
  const asJson = isJsonMode();
  const health = await readDaemonHealth();
  const state = await readDaemonRuntimeState();
  const manager = new ConfigManager();
  await manager.load();
  const cliVersion = resolveDisplayVersion();
  const cliSource = resolvePackageSourceInfo();
  const identity = resolveDaemonRuntimeIdentity({
    daemonConfig: manager.getDaemonConfig(),
    machineId: manager.getMachineId(),
    daemonVersion: health?.machine?.daemonVersion ?? state?.version ?? cliVersion,
  });
  const configPaths = manager.getConfigPaths();

  const payload = {
    status: health ? 'running' : state ? 'configured' : 'not_running',
    machineId: identity.machineId ?? null,
    daemonVersion: identity.daemonVersion,
    runtimeKind: identity.runtimeKind,
    daemonHome: identity.daemonHome,
    daemonHomeScope: identity.daemonHomeScope,
    daemonHomeSource: identity.daemonHomeSource,
    packageRoot: resolvePackageRoot(),
    cliEntrypoint: resolveCliEntrypointPath(),
    profile: health?.machine?.profile ?? state?.profile ?? identity.profile ?? null,
    serverUrl: health?.machine?.serverUrl ?? state?.serverUrl ?? identity.serverUrl ?? null,
    relayEndpoint:
      health?.machine?.relayEndpoint ?? state?.relayEndpoint ?? identity.relayEndpoint ?? null,
    relayServerUrl:
      health?.machine?.relayServerUrl ?? state?.relayServerUrl ?? identity.relayServerUrl ?? null,
    relayWorkspaceId: identity.relayWorkspaceId ?? state?.relayWorkspaceId ?? null,
    hostedDefaults: identity.hostedDefaults,
    listen: state?.listen ?? health?.listen ?? null,
    socketPath: state?.socketPath ?? health?.socketPath ?? null,
    ownerPid: state?.ownerPid ?? null,
    workerPid: state?.workerPid ?? health?.pid ?? null,
    relayState: health?.relay?.state ?? null,
    relayReconnectAttempt: health?.relay?.reconnectAttempt ?? null,
    relayLastErrorCode: health?.relay?.lastErrorCode ?? null,
    relayLastErrorMessage: health?.relay?.lastErrorMessage ?? null,
    configSource: configPaths.projectOverridePath
      ? `project override (${configPaths.projectOverridePath})`
      : `global (${configPaths.globalPath})`,
    configReason: identity.projectConfigSource
      ? identity.projectConfigSource === 'explicit'
        ? 'explicit VIEWPORT_PROJECT_CONFIG_DIR override'
        : 'nearest ancestor .viewport/config.json'
      : 'global ~/.viewport/config.json',
    cliVersion,
    cliSource:
      cliSource.kind === 'linked-local-build'
        ? `linked local build${cliSource.gitRef ? ` (${cliSource.gitRef})` : ''}`
        : 'installed package',
  };

  if (asJson) {
    printJson(payload);
    return;
  }

  console.log(`Status:       ${payload.status}`);
  console.log(`Machine:      ${payload.machineId ?? '-'}`);
  console.log(`Daemon:       ${payload.daemonVersion}`);
  console.log(`CLI:          ${payload.cliVersion}`);
  console.log(`CLI source:   ${payload.cliSource}`);
  console.log(`Runtime:      ${formatRuntimeKindLabel(payload.runtimeKind)}`);
  console.log(`Home:         ${formatDaemonHomeLabel(identity)}`);
  console.log(`Package root: ${payload.packageRoot}`);
  console.log(`CLI entry:    ${payload.cliEntrypoint}`);
  console.log(`Profile:      ${payload.profile ?? '-'}`);
  console.log(`Server:       ${payload.serverUrl ?? '-'}`);
  console.log(`Relay WS:     ${payload.relayEndpoint ?? '-'}`);
  console.log(`Relay API:    ${payload.relayServerUrl ?? '-'}`);
  console.log(`Workspace:    ${payload.relayWorkspaceId ?? '-'}`);
  console.log(`Hosted:       ${payload.hostedDefaults ? 'yes' : 'no'}`);
  console.log(`Listen:       ${payload.listen ?? '-'}`);
  console.log(`Socket:       ${payload.socketPath ?? '-'}`);
  console.log(`Owner PID:    ${payload.ownerPid ?? '-'}`);
  console.log(`Worker PID:   ${payload.workerPid ?? '-'}`);
  console.log(`Relay state:  ${payload.relayState ?? '-'}`);
  console.log(`Config:       ${payload.configSource}`);
  console.log(`Reason:       ${payload.configReason}`);
  if (payload.relayReconnectAttempt) {
    console.log(`Relay tries:  ${payload.relayReconnectAttempt}`);
  }
  if (payload.relayLastErrorCode || payload.relayLastErrorMessage) {
    console.log(
      `Relay last:   ${payload.relayLastErrorCode ?? 'UNKNOWN'}${payload.relayLastErrorMessage ? ` — ${payload.relayLastErrorMessage}` : ''}`,
    );
  }
}

export async function stop(options?: {
  exitOnNotRunning?: boolean;
  silent?: boolean;
}): Promise<void> {
  const exitOnNotRunning = options?.exitOnNotRunning ?? true;
  const silent = options?.silent ?? false;
  const asJson = isJsonMode();
  const timeoutMs = parseTimeoutMs(getFlag('timeout'), DEFAULT_STOP_TIMEOUT_MS);
  const force = hasFlag('force');

  const state = await readDaemonRuntimeState();
  const pid = state?.ownerPid;

  if (!state || !pid) {
    if (!silent && asJson) {
      printJson({ command: 'stop', action: 'not_running', reason: 'missing_state' });
    } else if (!silent) {
      console.log('Daemon is not running');
    }
    if (exitOnNotRunning) {
      process.exit(1);
    }
    return;
  }

  if (!isPidRunning(pid)) {
    await clearDaemonRuntimeState();
    if (!silent && asJson) {
      printJson({ command: 'stop', action: 'not_running', reason: 'stale_pid_file', pid });
    } else if (!silent) {
      console.log(`Daemon is not running (stale state for pid ${pid})`);
    }
    if (exitOnNotRunning) {
      process.exit(1);
    }
    return;
  }

  const processInfo = readProcessInfo(pid);
  if (!isOwnershipMatch(state, processInfo)) {
    if (!silent && asJson) {
      printJson({
        command: 'stop',
        action: 'not_running',
        reason: 'ownership_mismatch',
        pid,
        processInfo,
      });
    } else if (!silent) {
      console.log(`Refusing to stop pid ${pid}: runtime ownership metadata mismatch.`);
    }
    if (exitOnNotRunning) {
      process.exit(1);
    }
    return;
  }

  const lifecycleRequested = await requestLifecycle('shutdown');

  if (lifecycleRequested) {
    const exited = await waitForPidExit(pid, timeoutMs);
    if (!exited) {
      if (!force) {
        throw new Error(
          `Timed out waiting for daemon owner pid ${pid} to exit after lifecycle shutdown`,
        );
      }
      await stopPid(pid, { timeoutMs: 1_000, force: true, useProcessGroup: true });
      await clearDaemonRuntimeState();
      if (!silent && asJson) {
        printJson({ command: 'stop', action: 'stopped', forced: true, pid });
        return;
      }
      if (!silent) {
        console.log(`Force-stopped daemon owner process group (pid ${pid})`);
      }
      return;
    }

    await clearDaemonRuntimeState();
    if (!silent && asJson) {
      printJson({ command: 'stop', action: 'stopped', forced: false, pid, via: 'lifecycle' });
      return;
    }
    if (!silent) {
      console.log(`Stopped daemon gracefully (owner pid ${pid})`);
    }
    return;
  }

  const result = await stopPid(pid, { timeoutMs, force, useProcessGroup: true });
  await clearDaemonRuntimeState();

  if (!silent && asJson) {
    printJson({
      command: 'stop',
      action: result === 'not-running' ? 'not_running' : 'stopped',
      forced: result === 'force-stopped',
      pid,
      via: 'signal',
    });
    return;
  }

  if (result === 'not-running') {
    if (!silent) {
      console.log('Daemon was not running');
    }
    if (exitOnNotRunning) {
      process.exit(1);
    }
    return;
  }

  if (result === 'force-stopped') {
    if (!silent) {
      console.log(`Force-stopped daemon owner process group (pid ${pid})`);
    }
    return;
  }

  if (!silent) {
    console.log(`Stopped daemon (pid ${pid})`);
  }
}

export async function restart(): Promise<void> {
  const asJson = isJsonMode();
  await restartDaemon();
  if (asJson) {
    printJson({ command: 'restart', ok: true });
    return;
  }
  console.log('Daemon restarted.');
}

// ---------------------------------------------------------------------------
// Pairing code flow — new default for `vpd pair`
// ---------------------------------------------------------------------------

const DEFAULT_PAIRING_SERVER = 'https://getviewport.com';
const DEFAULT_PAIRING_APP = 'https://app.getviewport.com';
const PAIRING_POLL_INTERVAL_MS = 2_000;
const PAIRING_POLL_MAX_ATTEMPTS = 150; // 5 minutes at 2s intervals

interface PairingServerTransportConfig {
  url: string;
  appUrl: string;
  tlsVerify: 'auto' | '0' | '1';
  caCertPath?: string;
  tlsPins?: string[];
  daemonConfig?: ViewportConfig['daemon'];
}

function envValue(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = env[key];
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed !== '') return trimmed;
    }
  }
  return undefined;
}

async function resolvePairingServerTransport(
  explicitUrl?: string,
): Promise<PairingServerTransportConfig> {
  const manager = new ConfigManager();
  await manager.load();
  const daemonConfig = manager.getDaemonConfig();
  const serverConfig = daemonConfig?.server;
  const resolvedUrl =
    explicitUrl ??
    getFlag('server') ??
    envValue(process.env, 'VPD_SERVER_URL', 'VIEWPORT_SERVER_URL', 'VIEWPORT_SERVER') ??
    serverConfig?.url ??
    DEFAULT_PAIRING_SERVER;

  return {
    url: resolvedUrl,
    appUrl: resolvePairingAppUrl({
      serverUrl: resolvedUrl,
      explicitAppUrl:
        getFlag('app-url') ??
        envValue(process.env, 'VPD_APP_URL', 'VIEWPORT_APP_URL') ??
        serverConfig?.appUrl,
    }),
    tlsVerify:
      parseTlsVerifyMode(getFlag('server-tls-verify')) ??
      parseTlsVerifyMode(process.env['VPD_SERVER_TLS_VERIFY']) ??
      parseTlsVerifyMode(process.env['VIEWPORT_SERVER_TLS_VERIFY']) ??
      serverConfig?.tlsVerify ??
      'auto',
    caCertPath:
      getFlag('server-ca-cert') ??
      process.env['VPD_SERVER_CA_CERT'] ??
      process.env['VIEWPORT_SERVER_CA_CERT'] ??
      serverConfig?.caCertPath,
    tlsPins:
      parseCsvList(getFlag('server-tls-pins')) ??
      parseCsvList(process.env['VPD_SERVER_TLS_PINS']) ??
      parseCsvList(process.env['VIEWPORT_SERVER_TLS_PINS']) ??
      serverConfig?.tlsPins,
    daemonConfig,
  };
}

function joinPairingUrl(base: string, pathname: string): string {
  return `${base.replace(/\/+$/, '')}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function resolvePairingAppUrl(input: { serverUrl: string; explicitAppUrl?: string }): string {
  if (input.explicitAppUrl) {
    return input.explicitAppUrl.replace(/\/$/, '');
  }

  if (input.serverUrl === DEFAULT_PAIRING_SERVER) {
    return DEFAULT_PAIRING_APP;
  }

  try {
    const url = new URL(input.serverUrl);
    if (url.hostname === 'getviewport.test') {
      url.hostname = 'app.getviewport.test';
      return url.toString().replace(/\/$/, '');
    }
    if (url.hostname === 'getviewport.dev') {
      url.hostname = 'app.getviewport.dev';
      return url.toString().replace(/\/$/, '');
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return input.serverUrl;
  }
}

function openPairingUrl(url: string): void {
  const platform = process.platform;
  if (platform === 'darwin') {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }

  if (platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    });
    child.unref();
    return;
  }

  const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

interface PairingPollApprovedData {
  status: 'approved';
  workspace_id: string;
  workspace_name?: string;
  install_id?: string;
  project_machine_binding_id?: string;
  machine_id?: string;
  relay_endpoint?: string;
  token: string;
  server_url?: string;
}

interface PairingPollPendingData {
  status: 'pending';
}

interface PairingPollTerminalData {
  status: 'denied' | 'expired';
}

type PairingPollData = PairingPollApprovedData | PairingPollPendingData | PairingPollTerminalData;

interface PairingClaimData {
  status: 'claimed';
  workspace_name?: string;
  status_token: string;
}

interface PairingCreateData {
  code: string;
  expires_at?: string;
  status_token: string;
}

async function storePairingCredentials(
  data: PairingPollApprovedData,
  serverUrl: string,
): Promise<void> {
  const manager = new ConfigManager();
  await manager.load();
  const existing = manager.getDaemonConfig() ?? {};
  const existingRelay = existing.relay ?? {};

  let relayEndpoint = data.relay_endpoint ?? existingRelay.endpoint;
  if (!relayEndpoint) {
    relayEndpoint = inferRelayEndpointFromServer(data.server_url ?? serverUrl);
  }

  const nextIssueToken = data.token?.trim() ? data.token.trim() : existingRelay.issueToken;

  await manager.setDaemonConfig({
    server: {
      ...(existing.server ?? {}),
      url: data.server_url ?? serverUrl,
    },
    relay: {
      ...existingRelay,
      enabled: true,
      endpoint: relayEndpoint,
      serverUrl: data.server_url ?? serverUrl,
      workspaceId: data.workspace_id,
      installId: data.install_id,
      projectMachineBindingId: data.project_machine_binding_id,
      machineId: data.machine_id,
      issueToken: nextIssueToken,
    },
  });
}

function applyRuntimeOverrides(
  launch: Awaited<ReturnType<typeof resolveDaemonSettingsFromSources>>['launch'],
  runtimeState: Awaited<ReturnType<typeof readDaemonRuntimeState>>,
): Awaited<ReturnType<typeof resolveDaemonSettingsFromSources>>['launch'] {
  if (!runtimeState) {
    return launch;
  }

  return {
    ...launch,
    listen:
      runtimeState.listen ??
      (runtimeState.socketPath
        ? `unix://${runtimeState.socketPath}`
        : `${runtimeState.host}:${runtimeState.port}`),
    host: runtimeState.host,
    port: runtimeState.socketPath ? 0 : runtimeState.port,
    socketPath: runtimeState.socketPath,
    profile: runtimeState.profile ?? launch.profile,
    allowedHostsRaw: runtimeState.allowedHostsRaw ?? launch.allowedHostsRaw,
    allowedOriginsRaw: runtimeState.allowedOriginsRaw ?? launch.allowedOriginsRaw,
    authEnabled: runtimeState.authEnabled ?? launch.authEnabled,
    logPath: runtimeState.logPath ?? launch.logPath,
    relayEnabled: launch.relayEnabled,
    relayEndpoint: launch.relayEndpoint ?? runtimeState.relayEndpoint,
    relayServerUrl: launch.relayServerUrl ?? runtimeState.relayServerUrl,
    relayWorkspaceId: launch.relayWorkspaceId ?? runtimeState.relayWorkspaceId,
    relayProjectMachineBindingId:
      launch.relayProjectMachineBindingId ?? runtimeState.relayProjectMachineBindingId,
    relayMachineId: launch.relayMachineId ?? runtimeState.relayMachineId,
    relayTlsVerify: launch.relayTlsVerify ?? runtimeState.relayTlsVerify,
  };
}

function applyRuntimeTlsEnvironment(
  runtimeState: Awaited<ReturnType<typeof readDaemonRuntimeState>>,
): () => void {
  const keys = [
    'VIEWPORT_TLS',
    'VIEWPORT_TLS_HOST',
    'VIEWPORT_TLS_CERT_DIR',
    'VIEWPORT_TLS_CERT',
    'VIEWPORT_TLS_KEY',
    'VIEWPORT_PROJECT_CONFIG_DIR',
    'VPD_PROJECT_CONFIG_DIR',
  ];
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
  }

  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined || value === '') {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

  if (runtimeState?.tlsEnabled) {
    setEnv('VIEWPORT_TLS', '1');
    setEnv('VIEWPORT_TLS_HOST', runtimeState.tlsHost?.trim() || 'localhost');
    const certDir = runtimeState.tlsCertDir?.trim() || undefined;
    setEnv('VIEWPORT_TLS_CERT_DIR', certDir);
    if (certDir) {
      setEnv('VIEWPORT_TLS_CERT', undefined);
      setEnv('VIEWPORT_TLS_KEY', undefined);
    } else {
      setEnv('VIEWPORT_TLS_CERT', runtimeState.tlsCertPath?.trim() || undefined);
      setEnv('VIEWPORT_TLS_KEY', runtimeState.tlsKeyPath?.trim() || undefined);
    }
  } else if (runtimeState?.tlsEnabled === false) {
    setEnv('VIEWPORT_TLS', '0');
    setEnv('VIEWPORT_TLS_HOST', undefined);
    setEnv('VIEWPORT_TLS_CERT_DIR', undefined);
    setEnv('VIEWPORT_TLS_CERT', undefined);
    setEnv('VIEWPORT_TLS_KEY', undefined);
  }

  if (runtimeState?.projectConfigDir) {
    setEnv('VIEWPORT_PROJECT_CONFIG_DIR', runtimeState.projectConfigDir);
    setEnv('VPD_PROJECT_CONFIG_DIR', runtimeState.projectConfigDir);
  }

  return () => {
    for (const [key, value] of previous.entries()) {
      setEnv(key, value);
    }
  };
}

async function hardRestartFromRuntimeState(runtimeState: DaemonRuntimeState | null): Promise<void> {
  if (runtimeState?.ownerPid) {
    await stopPid(runtimeState.ownerPid, {
      timeoutMs: 1_500,
      force: true,
      useProcessGroup: true,
    });
    await clearDaemonRuntimeState();
  }

  const resolved = await resolveDaemonSettingsFromSources();
  const launch = applyRuntimeOverrides(resolved.launch, runtimeState);
  const restoreEnv = applyRuntimeTlsEnvironment(runtimeState);
  try {
    await startWithLaunchConfig(launch, { silent: true });
    await waitForDaemonReady({ requireRelayConnected: false, timeoutMs: 45_000 });
  } finally {
    restoreEnv();
  }
}

async function restartDaemon(): Promise<void> {
  const runtimeState = await readDaemonRuntimeState();
  await hardRestartFromRuntimeState(runtimeState);
}

async function autoRestartDaemon(silent: boolean): Promise<void> {
  if (!silent) {
    console.log('Restarting daemon...');
  }
  try {
    await restartDaemon();
    if (!silent) {
      console.log('Daemon restarted.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!silent) {
      console.log(`Could not restart the daemon automatically: ${message}`);
      console.log('Run `vpd restart` and check `vpd status` if the daemon is still restarting.');
    }
    throw new Error(message);
  }

  try {
    await waitForDaemonReady({ requireRelayConnected: true, timeoutMs: 10_000 });
    if (!silent) {
      console.log('Relay connection active.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!silent) {
      console.log(`Relay is still reconnecting: ${message}`);
      console.log('Check `vpd status` if it does not connect shortly.');
    }
  }
}

async function pollForApproval(
  code: string,
  server: PairingServerTransportConfig,
  statusToken: string,
  asJson: boolean,
): Promise<PairingPollApprovedData> {
  const spinner = ['-', '\\', '|', '/'];
  let attempt = 0;

  while (attempt < PAIRING_POLL_MAX_ATTEMPTS) {
    let res: Response;
    try {
      res = await transportFetch(
        joinPairingUrl(server.url, `/api/pairing-codes/${encodeURIComponent(code)}/status`),
        {
          headers: {
            'X-Viewport-Pairing-Token': statusToken,
          },
          tlsVerify: server.tlsVerify,
          caCertPath: server.caCertPath,
          tlsPins: server.tlsPins,
        },
      );
    } catch (err) {
      attempt++;
      if (attempt >= PAIRING_POLL_MAX_ATTEMPTS) {
        throw new Error(
          `Network error while polling for approval: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await new Promise((r) => setTimeout(r, PAIRING_POLL_INTERVAL_MS));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Failed to poll pairing status (HTTP ${res.status}): ${body}`);
    }

    const data = (await res.json()) as PairingPollData;

    if (data.status === 'approved') {
      if (!asJson) {
        // Clear spinner line
        process.stdout.write('\r' + ' '.repeat(40) + '\r');
      }
      return data as PairingPollApprovedData;
    }

    if (data.status === 'denied') {
      if (!asJson) {
        process.stdout.write('\r' + ' '.repeat(40) + '\r');
      }
      throw new Error('Pairing was denied by the workspace owner.');
    }

    if (data.status === 'expired') {
      if (!asJson) {
        process.stdout.write('\r' + ' '.repeat(40) + '\r');
      }
      throw new Error('Pairing code expired. Run `vpd pair` again to generate a new code.');
    }

    // Still pending
    if (!asJson) {
      process.stdout.write(`\r  ${spinner[attempt % spinner.length]} Waiting for approval...`);
    }
    attempt++;
    await new Promise((r) => setTimeout(r, PAIRING_POLL_INTERVAL_MS));
  }

  throw new Error('Timed out waiting for pairing approval. Run `vpd pair` again.');
}

async function pairWithCode(
  code: string,
  explicitServerUrl: string | undefined,
  asJson: boolean,
): Promise<void> {
  const relayIdentity = await loadOrCreateRelayIdentity();
  const name = await resolveDefaultPairingName();
  const server = await resolvePairingServerTransport(explicitServerUrl);
  const runtimeIdentity = resolveDaemonRuntimeIdentity({
    daemonVersion: resolveDisplayVersion(),
    daemonConfig: server.daemonConfig,
  });
  const installCapabilities = toInstallCapabilities({
    ...runtimeIdentity,
    serverUrl: server.url,
    relayServerUrl: server.url,
  });

  if (!asJson) {
    console.log(`Claiming pairing code ${code}...`);
  }

  let claimRes: Response;
  try {
    claimRes = await transportFetch(
      joinPairingUrl(server.url, `/api/pairing-codes/${encodeURIComponent(code)}/claim`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          public_key: relayIdentity.publicKey,
          device_id: relayIdentity.deviceId,
          daemon_version: installCapabilities.runtime.daemonVersion,
          runtime_kind: installCapabilities.runtime.runtimeKind,
          daemon_home_scope: installCapabilities.runtime.daemonHomeScope,
          profile: installCapabilities.runtime.profile,
          server_url: installCapabilities.runtime.serverUrl,
          relay_endpoint: installCapabilities.runtime.relayEndpoint,
          relay_server_url: installCapabilities.runtime.relayServerUrl,
        }),
        tlsVerify: server.tlsVerify,
        caCertPath: server.caCertPath,
        tlsPins: server.tlsPins,
      },
    );
  } catch (err) {
    throw new Error(
      `Network error claiming pairing code: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!claimRes.ok) {
    const body = (await claimRes.json().catch(() => null)) as Record<string, unknown> | null;
    const message = typeof body?.message === 'string' ? body.message : `HTTP ${claimRes.status}`;
    throw new Error(`Failed to claim pairing code: ${message}`);
  }

  const appUrl = server.appUrl;
  const claimData = (await claimRes.json()) as PairingClaimData;

  if (typeof claimData.status_token !== 'string' || claimData.status_token.trim() === '') {
    throw new Error('Pairing claim did not return a status token.');
  }

  if (!asJson) {
    console.log('Code claimed. Waiting for approval...');
    console.log(`  Approve in your browser at: ${appUrl}`);
    console.log('');
  }

  const approved = await pollForApproval(code, server, claimData.status_token, asJson);
  await storePairingCredentials(approved, server.url);
  await autoRestartDaemon(asJson);

  if (asJson) {
    printJson({
      command: 'pair',
      ok: true,
      flow: 'code-claim',
      code,
      workspaceId: approved.workspace_id,
      workspaceName: approved.workspace_name,
      restarted: true,
    });
    return;
  }

  console.log('Paired successfully!');
  if (approved.workspace_name) {
    console.log(`  Workspace: ${approved.workspace_name}`);
  }
  console.log('');
}

async function pairWithoutCode(
  explicitServerUrl: string | undefined,
  asJson: boolean,
): Promise<void> {
  const relayIdentity = await loadOrCreateRelayIdentity();
  const name = await resolveDefaultPairingName();
  const server = await resolvePairingServerTransport(explicitServerUrl);
  const runtimeIdentity = resolveDaemonRuntimeIdentity({
    daemonVersion: resolveDisplayVersion(),
    daemonConfig: server.daemonConfig,
  });
  const installCapabilities = toInstallCapabilities({
    ...runtimeIdentity,
    serverUrl: server.url,
    relayServerUrl: server.url,
  });

  let createRes: Response;
  try {
    createRes = await transportFetch(joinPairingUrl(server.url, '/api/pairing-codes'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        public_key: relayIdentity.publicKey,
        device_id: relayIdentity.deviceId,
        daemon_version: installCapabilities.runtime.daemonVersion,
        runtime_kind: installCapabilities.runtime.runtimeKind,
        daemon_home_scope: installCapabilities.runtime.daemonHomeScope,
        profile: installCapabilities.runtime.profile,
        server_url: installCapabilities.runtime.serverUrl,
        relay_endpoint: installCapabilities.runtime.relayEndpoint,
        relay_server_url: installCapabilities.runtime.relayServerUrl,
      }),
      tlsVerify: server.tlsVerify,
      caCertPath: server.caCertPath,
      tlsPins: server.tlsPins,
    });
  } catch (err) {
    throw new Error(
      `Network error creating pairing code: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!createRes.ok) {
    const body = (await createRes.json().catch(() => null)) as Record<string, unknown> | null;
    const message = typeof body?.message === 'string' ? body.message : `HTTP ${createRes.status}`;
    throw new Error(`Failed to create pairing code: ${message}`);
  }

  const data = (await createRes.json()) as PairingCreateData;
  const code = data.code;
  const statusToken = typeof data.status_token === 'string' ? data.status_token.trim() : '';
  if (statusToken === '') {
    throw new Error('Pairing code response missing status token.');
  }

  const appUrl = server.appUrl;
  const pairUrl = `${appUrl}/pair?code=${encodeURIComponent(code)}`;

  if (!asJson) {
    console.log('');
    console.log('  Enter this code in the Viewport web app:');
    console.log('');
    console.log(`    ${code}`);
    console.log('');
    console.log(`  Or visit: ${pairUrl}`);
    console.log('');
  }

  // Try to open browser (best effort, macOS/Linux/Windows)
  try {
    openPairingUrl(pairUrl);
  } catch {
    // Ignore — opening browser is best effort
  }

  const approved = await pollForApproval(code, server, statusToken, asJson);
  await storePairingCredentials(approved, server.url);
  await autoRestartDaemon(asJson);

  if (asJson) {
    printJson({
      command: 'pair',
      ok: true,
      flow: 'code-create',
      code,
      workspaceId: approved.workspace_id,
      workspaceName: approved.workspace_name,
      restarted: true,
    });
    return;
  }

  console.log('Paired successfully!');
  if (approved.workspace_name) {
    console.log(`  Workspace: ${approved.workspace_name}`);
  }
  console.log('');
}

export async function pair(): Promise<void> {
  const asJson = isJsonMode();
  const args = getArgs();
  const pairCommandIndex = args[0] === 'daemon' && args[1] === 'pair' ? 1 : 0;
  const pairSubcommand = args[pairCommandIndex + 1];

  if (pairSubcommand === 'rotate-token') {
    const result = await rotateAuthToken();
    if (asJson) {
      printJson({
        command: 'pair rotate-token',
        ok: true,
        previousTokenExisted: result.previousTokenExisted,
        restarted: false,
      });
      return;
    }
    console.log('Rotated daemon auth token on disk.');
    console.log('Restart the daemon for the new token to take effect.');
    return;
  }

  if (pairSubcommand === 'anchor') {
    const anchor = await getOrCreateTrustAnchor();
    if (asJson) {
      printJson({
        command: 'pair anchor',
        ok: true,
        trustAnchor: anchor.fingerprint,
        trustAnchorId: anchor.id,
        createdAt: anchor.createdAt,
      });
      return;
    }
    console.log(`Trust anchor: ${anchor.fingerprint}`);
    console.log(`Anchor ID:    ${anchor.id}`);
    console.log(`Created:      ${new Date(anchor.createdAt).toISOString()}`);
    return;
  }

  // New pairing code flow (default)
  // Determine if a pairing code was provided as a positional argument.
  // A code is a short alphanumeric string (not a subcommand, not a flag).
  const possibleCode = pairSubcommand;
  const isCode =
    possibleCode && !possibleCode.startsWith('--') && /^[A-Za-z0-9]{4,12}$/.test(possibleCode);

  if (isCode) {
    await pairWithCode(possibleCode, undefined, asJson);
  } else {
    await pairWithoutCode(undefined, asJson);
  }
}

export async function resolveDefaultPairingName(): Promise<string> {
  const explicitName = sanitizePairingName(process.env['VIEWPORT_MACHINE_NAME']);
  if (explicitName) return explicitName;

  if (process.platform === 'darwin') {
    const computerName = sanitizePairingName(
      await readCommandText('scutil', ['--get', 'ComputerName']),
    );
    if (computerName) return computerName;

    const localHostName = sanitizePairingName(
      await readCommandText('scutil', ['--get', 'LocalHostName']),
    );
    if (localHostName) return localHostName;
  }

  if (process.platform === 'linux') {
    const prettyName = sanitizePairingName(await readCommandText('hostnamectl', ['--pretty']));
    if (prettyName) return prettyName;
  }

  return sanitizePairingName(os.hostname()) ?? 'Viewport machine';
}

function sanitizePairingName(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.slice(0, 80);
}

function readCommandText(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 1_000);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? output : null);
    });
  });
}

function runCommand(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Command exited via signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function update(): Promise<void> {
  const asJson = isJsonMode();
  const packageName = resolvePackageName();
  const state = await readDaemonRuntimeState();
  const resolvedNode = resolvePreferredNodePath({
    daemonPid: state?.ownerPid ?? null,
    fallbackNodePath: process.execPath,
  });
  const npm = resolveNpmInvocationFromNode(resolvedNode.nodePath);

  const exitCode = await runCommand(npm.command, [
    ...npm.argsPrefix,
    'install',
    '-g',
    `${packageName}@latest`,
  ]);
  if (exitCode !== 0) {
    if (asJson) {
      printJson({
        command: 'update',
        ok: false,
        error: `Update command failed with exit code ${exitCode}`,
      });
      return;
    }
    throw new Error(`Update command failed with exit code ${exitCode}`);
  }

  const shouldRestart = hasFlag('yes') || hasFlag('restart');
  if (shouldRestart) {
    await restartDaemon();
  }

  if (asJson) {
    printJson({
      command: 'update',
      ok: true,
      package: packageName,
      restarted: shouldRestart,
      runtimeNode: resolvedNode.nodePath,
      runtimeNpm: formatNpmInvocation(npm),
    });
    return;
  }

  if (!shouldRestart) {
    console.log('Update complete. Restart skipped. Run `vpd restart` when ready.');
    return;
  }
  console.log('Update complete. Daemon restart requested.');
}

export function showHelp(): void {
  console.log('Viewport Daemon (vpd) — monitor and control AI coding agents\n');
  console.log('Usage: vpd <command> [options]\n');
  console.log('Output: --json or --format text|json|yaml|table (table where supported)\n');
  console.log('Commands:');
  console.log(
    '  start [--foreground] [--listen <host:port|port|/path.sock>] [--profile local|lan|relay] [--allowed-hosts <hosts>] [--allowed-origins <hosts>] [--auth] [--home <path>]',
  );
  console.log('                               Start the daemon (detached by default)');
  console.log(
    '  daemon <subcommand>          Lifecycle ops (start, doctor, status, stop, restart, pair, update, service, setup)',
  );
  console.log('  setup [--yes|--choose]       First-run guided setup (recommended or custom)');
  console.log('  install [--json]             Detect available agents and install hooks');
  console.log('  add <path> [--json]          Register a directory');
  console.log('  remove <path> [--json]       Unregister a directory');
  console.log('  list [--json]                List directories + active sessions');
  console.log(
    '  doctor [--json]              Show daemon identity, runtime mode, and active targets',
  );
  console.log('  status [--json] [--check-updates]');
  console.log('                               Daemon health and runtime status');
  console.log('  stop [--json] [--timeout <seconds>] [--force]');
  console.log('                               Stop daemon gracefully (with optional forced kill)');
  console.log('  restart                       Stop then start daemon');
  console.log('  run [<dir>] --prompt <text>  Launch a session (auto-registers directory)');
  console.log(
    '  ls [--scope all|active|discovered] [--directory <id>] [--agent <id>] [--json|--format <fmt>]',
  );
  console.log('                               List active/discovered sessions');
  console.log('  session stop <sid> [--json|--format <fmt>]  Stop an active session');
  console.log('  send <sid> --prompt <text>   Send a prompt to an active session');
  console.log('  logs <sid> [--follow]        Replay or follow session updates');
  console.log('  wait <sid> [--timeout <s>]   Block until a session ends');
  console.log('  attach <sid>                 Follow session updates until completion');
  console.log('  permit ls [--session <sid>] [--json|--format <fmt>]');
  console.log('  permit allow <sid> <rid> [--always] [--json|--format <fmt>]');
  console.log('  permit deny <sid> <rid> [--message <reason>] [--json|--format <fmt>]');
  console.log('                               Manage pending permission requests');
  console.log('  agent mode <sid> [detect|bypass] [--json|--format <fmt>]');
  console.log(
    '                               Read/set operator control mode for an active session',
  );
  console.log('  worktree ls [--session <sid>] [--json|--format <fmt>]');
  console.log('  worktree diffs <sid> [--json|--format <fmt>]');
  console.log('  worktree summary <sid> [--json|--format <fmt>]');
  console.log('  worktree rollback <sid> <sha> [--json|--format <fmt>]');
  console.log('  worktree retry <sid> <sha> [--json|--format <fmt>]');
  console.log(
    '  worktree squash <sid> [--target <branch>] [--message <text>] [--json|--format <fmt>]',
  );
  console.log('                               Worktree and git-step operator controls');
  console.log('  workflow validate <file> [--json]');
  console.log(
    '  workflow run <file> [--directory <path>] [--input k=v] [--input-json k=json] [--json]',
  );
  console.log('  workflow runs [--json]');
  console.log('  workflow show <run-id> [--json]');
  console.log('  workflow rerun <run-id> [--detach] [--json]');
  console.log('  workflow approve <run-id> <node-id> [--deny] [--message <text>] [--json]');
  console.log('  workflow cancel <run-id> [--message <text>] [--json]');
  console.log(
    '                               Validate, run, inspect, approve, and cancel local workflows',
  );
  console.log('  hook notify --event <EventName>');
  console.log('  hook plan                    Send a plan proposal hook from stdin');
  console.log('  hook capabilities [--adapter <name>] [--json]');
  console.log('  pair [<code>] [--server <url>] [--app-url <url>] [--json]');
  console.log('                               Pair with Viewport via pairing code');
  console.log('  pair anchor [--json]         Show daemon trust anchor fingerprint');
  console.log('  pair rotate-token [--json]   Rotate auth token on disk (restart required)');
  console.log('  update [--json] [--yes]      Update daemon package, optionally restart');
  console.log('  service <install|uninstall|status> [--json]');
  console.log('                               Manage OS user service (launchd/systemd)');
  console.log(
    '  remote <login|status|enable|disable|logout> [--server <url>] [--workspace <id>] [--token <issue-token>]',
  );
  console.log('                               Configure daemon-native relay transport');
  console.log('  help                         Show this help message');
  console.log('');
  console.log('Agents are auto-detected from the built-in registry.');
  console.log('Directories are auto-discovered from agent storage on startup.');
}
