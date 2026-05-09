import { ConfigManager } from '../core/config.js';
import {
  formatDaemonHomeLabel,
  formatRuntimeKindLabel,
  resolveDaemonRuntimeIdentity,
} from '../core/runtime-identity.js';
import {
  resolveCliEntrypointPath,
  resolveDisplayVersion,
  resolvePackageRoot,
  resolvePackageSourceInfo,
} from '../core/package-meta.js';
import { isJsonMode, printJson, readDaemonHealth } from './command-shared.js';
import { readDaemonRuntimeState } from './daemon-lifecycle.js';
import { relayRecoveryHint } from './relay-diagnostics.js';

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
    relayRecoveryHint: relayRecoveryHint({
      state: health?.relay?.state ?? null,
      reconnectAttempt: health?.relay?.reconnectAttempt ?? null,
      lastErrorCode: health?.relay?.lastErrorCode ?? null,
      lastErrorMessage: health?.relay?.lastErrorMessage ?? null,
    }),
    configSource: configPaths.resourceOverridePath
      ? `resource override (${configPaths.resourceOverridePath})`
      : `global (${configPaths.globalPath})`,
    configReason: identity.resourceOverrideConfigSource
      ? identity.resourceOverrideConfigSource === 'explicit'
        ? 'explicit VIEWPORT_RESOURCE_OVERRIDE_DIR override'
        : 'nearest ancestor .viewport/config.yaml'
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
  if (payload.relayRecoveryHint) {
    console.log(`Relay hint:   ${payload.relayRecoveryHint}`);
  }
}
