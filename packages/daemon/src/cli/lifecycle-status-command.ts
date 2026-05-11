import { configDir, ConfigManager } from '../core/config.js';
import { hasFlag } from './args.js';
import { resolveDaemonEndpoint } from './daemon-client.js';
import type { DaemonEndpoint } from './daemon-client.js';
import { isPidRunning, readDaemonRuntimeState } from './daemon-lifecycle.js';
import { relayRecoveryHint } from './relay-diagnostics.js';
import {
  compareSemver,
  fetchLatestVersion,
  formatNpmInvocation,
  resolveNpmInvocationFromNode,
  resolvePreferredNodePath,
  type NpmInvocation,
} from './runtime-toolchain.js';
import { isJsonMode, printJson, readDaemonHealth, shortError } from './command-shared.js';
import {
  formatDaemonHomeLabel,
  formatRuntimeKindLabel,
  resolveDaemonRuntimeIdentity,
} from '../core/runtime-identity.js';
import {
  resolveDisplayVersion,
  resolvePackageName,
  resolvePackageSourceInfo,
} from '../core/package-meta.js';
import { resolveLocalOrgBindingSync, resolveWorkspaceOrgHintSync } from './org-binding.js';

interface RelayBindingStatusView {
  workspaceId?: string;
  relayEndpoint?: string;
  state?: string;
  reconnectAttempt?: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

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
  const daemonConfig = manager.getDaemonConfig();
  const configuredRelayBindings = daemonConfig?.relay?.bindings ?? [];
  const healthRelayBindings = readRelayBindingStatuses(health);
  const configuredRelayBindingStatuses: RelayBindingStatusView[] = configuredRelayBindings.map(
    (binding) => ({
      workspaceId: binding.workspaceId,
      relayEndpoint: binding.endpoint,
      state: binding.enabled === false ? 'stopped' : undefined,
    }),
  );
  const relayBindingStatuses = mergeRelayBindingStatuses(
    configuredRelayBindingStatuses,
    healthRelayBindings,
  );
  const activeRelayWorkspaceIds = new Set(
    [
      daemonConfig?.relay?.workspaceId,
      ...configuredRelayBindings.map((binding) => binding.workspaceId),
      ...relayBindingStatuses.map((binding) => binding.workspaceId),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  const cliVersion = resolveDisplayVersion();
  const cliSource = resolvePackageSourceInfo();
  const runtimeIdentity = resolveDaemonRuntimeIdentity({
    daemonConfig: manager.getDaemonConfig(),
    machineId: manager.getMachineId(),
    daemonVersion: health?.machine?.daemonVersion ?? state?.version ?? cliVersion,
  });
  const cwdBinding = resolveLocalOrgBindingSync(process.cwd());
  const cwdHint = resolveWorkspaceOrgHintSync(process.cwd());
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
    relayWorkspaceId: daemonConfig?.relay?.workspaceId ?? null,
    relayBindings: relayBindingStatuses,
    cwdBinding: cwdBinding
      ? {
          directory: cwdBinding.directory,
          organizationId: cwdBinding.organizationId,
          streamEnabled: cwdBinding.streamEnabled,
          matchesActiveOrg: activeRelayWorkspaceIds.has(cwdBinding.organizationId),
        }
      : null,
    cwdHint: cwdHint
      ? {
          directory: cwdHint.directory,
          organizationId: cwdHint.organizationId,
        }
      : null,
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
    relayRecoveryHint: relayRecoveryHint({
      state: health?.relay?.state ?? null,
      reconnectAttempt: health?.relay?.reconnectAttempt ?? null,
      lastErrorCode: health?.relay?.lastErrorCode ?? null,
      lastErrorMessage: health?.relay?.lastErrorMessage ?? null,
    }),
    note,
    configSource: configPaths.resourceOverridePath
      ? `resource override (${configPaths.resourceOverridePath})`
      : `global (${configPaths.globalPath})`,
    configReason: runtimeIdentity.resourceOverrideConfigSource
      ? runtimeIdentity.resourceOverrideConfigSource === 'explicit'
        ? 'explicit VIEWPORT_RESOURCE_OVERRIDE_DIR override'
        : 'nearest ancestor .viewport/config.yaml'
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
  console.log(`Org:         ${payload.relayWorkspaceId ?? '-'}`);
  console.log(`Relay WS:    ${payload.relayEndpoint ?? '-'}`);
  console.log(`Relay API:   ${payload.relayServerUrl ?? '-'}`);
  console.log(`Relay state: ${payload.relayState ?? '-'}`);
  if (payload.relayBindings.length > 0) {
    console.log(`Relays:      ${payload.relayBindings.length}`);
    for (const binding of payload.relayBindings) {
      const last =
        binding.lastErrorCode || binding.lastErrorMessage
          ? ` last=${binding.lastErrorCode ?? 'UNKNOWN'}${binding.lastErrorMessage ? `:${binding.lastErrorMessage}` : ''}`
          : '';
      console.log(
        `  - ${binding.workspaceId ?? '-'} ${binding.relayEndpoint ?? '-'} ${binding.state ?? 'configured'}${last}`,
      );
    }
  }
  if (payload.relayReconnectAttempt) {
    console.log(`Relay tries: ${payload.relayReconnectAttempt}`);
  }
  if (payload.relayLastErrorCode || payload.relayLastErrorMessage) {
    console.log(
      `Relay last:  ${payload.relayLastErrorCode ?? 'UNKNOWN'}${payload.relayLastErrorMessage ? ` — ${payload.relayLastErrorMessage}` : ''}`,
    );
  }
  if (payload.relayRecoveryHint) {
    console.log(`Relay hint:  ${payload.relayRecoveryHint}`);
  }
  console.log(`Node:        ${payload.runtimeNode}`);
  console.log(`npm:         ${payload.runtimeNpm}`);
  console.log(`CLI:         ${payload.cliVersion}`);
  console.log(`CLI source:  ${payload.cliSource}`);
  console.log(`Latest CLI:  ${payload.latestCliVersion}`);
  console.log(`Update:      ${payload.updateStatus}`);
  console.log(`Config:      ${payload.configSource}`);
  console.log(`Reason:      ${payload.configReason}`);
  if (payload.cwdBinding) {
    console.log(
      `Binding:     ${payload.cwdBinding.directory} -> ${payload.cwdBinding.organizationId} (${payload.cwdBinding.streamEnabled ? 'streaming' : 'disabled'}${payload.cwdBinding.matchesActiveOrg ? ', active' : ', not active'})`,
    );
  } else if (payload.cwdHint) {
    console.log(
      `Binding:     unbound; repo hint ${payload.cwdHint.organizationId} at ${payload.cwdHint.directory}`,
    );
  } else {
    console.log('Binding:     unbound (remote streaming disabled for this directory)');
  }
  if (payload.health) {
    console.log(`Sessions:    ${payload.health.sessions}`);
    console.log(`Directories: ${payload.health.directories}`);
    console.log(`Agents:      ${payload.health.agents}`);
  }
  if (payload.note) {
    console.log(`Note:        ${payload.note}`);
  }
}

function readRelayBindingStatuses(health: unknown): RelayBindingStatusView[] {
  if (!health || typeof health !== 'object' || Array.isArray(health)) return [];
  const relay = (health as { relay?: unknown }).relay;
  if (!relay || typeof relay !== 'object' || Array.isArray(relay)) return [];
  const bindings = (relay as { bindings?: unknown }).bindings;
  if (!Array.isArray(bindings)) return [];
  return bindings.flatMap((item): RelayBindingStatusView[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return [
      {
        workspaceId: typeof record['workspaceId'] === 'string' ? record['workspaceId'] : undefined,
        relayEndpoint:
          typeof record['relayEndpoint'] === 'string'
            ? record['relayEndpoint']
            : typeof record['endpoint'] === 'string'
              ? record['endpoint']
              : undefined,
        state: typeof record['state'] === 'string' ? record['state'] : undefined,
        reconnectAttempt:
          typeof record['reconnectAttempt'] === 'number' ? record['reconnectAttempt'] : undefined,
        lastErrorCode:
          typeof record['lastErrorCode'] === 'string' ? record['lastErrorCode'] : undefined,
        lastErrorMessage:
          typeof record['lastErrorMessage'] === 'string' ? record['lastErrorMessage'] : undefined,
      },
    ];
  });
}

function mergeRelayBindingStatuses(
  configured: RelayBindingStatusView[],
  health: RelayBindingStatusView[],
): RelayBindingStatusView[] {
  if (configured.length === 0) {
    return health;
  }

  const healthByWorkspace = new Map(
    health
      .filter((binding) => binding.workspaceId)
      .map((binding) => [binding.workspaceId as string, binding]),
  );
  const merged: RelayBindingStatusView[] = configured.map((binding) => {
    const live = binding.workspaceId ? healthByWorkspace.get(binding.workspaceId) : undefined;
    return {
      ...binding,
      ...live,
      workspaceId: binding.workspaceId ?? live?.workspaceId,
      relayEndpoint: live?.relayEndpoint ?? binding.relayEndpoint,
      state: live?.state ?? binding.state,
    };
  });
  const configuredKeys = new Set(configured.map((binding) => binding.workspaceId).filter(Boolean));

  for (const binding of health) {
    if (binding.workspaceId && configuredKeys.has(binding.workspaceId)) {
      continue;
    }
    merged.push(binding);
  }

  return merged;
}
