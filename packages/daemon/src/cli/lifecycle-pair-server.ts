import { ConfigManager } from '../core/config.js';
import type { ViewportConfig } from '../core/config.js';
import { sanitizeMachineDisplayName } from '../core/machine-name.js';
import { getFlag, hasFlag } from './args.js';
import { parseCsvList, parseTlsVerifyMode, transportFetch } from './network.js';
import { inferRelayEndpointFromServer } from './remote-commands.js';

const DEFAULT_PAIRING_SERVER = 'https://getviewport.com';
const DEFAULT_PAIRING_APP = 'https://app.getviewport.com';
const PAIRING_POLL_INTERVAL_MS = 2_000;
const PAIRING_POLL_MAX_ATTEMPTS = 150;

export interface PairingServerTransportConfig {
  url: string;
  appUrl: string;
  tlsVerify: 'auto' | '0' | '1';
  caCertPath?: string;
  tlsPins?: string[];
  daemonConfig?: ViewportConfig['daemon'];
}

export interface PairingPollApprovedData {
  status: 'approved';
  workspace_id: string;
  workspace_name?: string;
  install_id?: string;
  runtime_target_id?: string;
  machine_id?: string;
  daemon_name?: string;
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

export function joinPairingUrl(base: string, pathname: string): string {
  return `${base.replace(/\/+$/, '')}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

export async function resolvePairingServerTransport(
  explicitUrl?: string,
): Promise<PairingServerTransportConfig> {
  const manager = new ConfigManager();
  await manager.load();
  const daemonConfig = manager.getDaemonConfig();
  const serverConfig = daemonConfig?.server;
  const configuredServerUrl = serverConfig?.url?.trim();
  const resolvedUrl =
    explicitUrl ??
    getFlag('server') ??
    envValue(process.env, 'VPD_SERVER_URL', 'VIEWPORT_SERVER_URL', 'VIEWPORT_SERVER') ??
    configuredServerUrl ??
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

export async function storePairingCredentials(
  data: PairingPollApprovedData,
  serverUrl: string,
): Promise<void> {
  const manager = new ConfigManager();
  await manager.load();
  const existing = manager.getDaemonConfig() ?? {};
  const existingRelay = existing.relay ?? {};
  const nextServerUrl = data.server_url ?? serverUrl;
  const addBinding = hasFlag('add');
  const replacesExisting =
    Boolean(existingRelay.workspaceId) &&
    (existingRelay.workspaceId !== data.workspace_id || existingRelay.serverUrl !== nextServerUrl);
  if (replacesExisting && !addBinding && !hasFlag('replace')) {
    throw new Error(
      `This daemon is already paired to workspace ${existingRelay.workspaceId}. Re-run with --replace to replace it with ${data.workspace_id}.`,
    );
  }

  let relayEndpoint = data.relay_endpoint ?? existingRelay.endpoint;
  if (!relayEndpoint) {
    relayEndpoint = inferRelayEndpointFromServer(nextServerUrl);
  }

  const nextIssueToken = data.token?.trim() ? data.token.trim() : existingRelay.issueToken;
  const machineName = sanitizeMachineDisplayName(data.daemon_name) ?? existingRelay.machineName;
  const nextBinding = {
    enabled: true,
    endpoint: relayEndpoint,
    serverUrl: nextServerUrl,
    workspaceId: data.workspace_id,
    installId: data.install_id,
    runtimeTargetId: data.runtime_target_id,
    machineId: data.machine_id,
    machineName,
    issueToken: nextIssueToken,
  };

  await manager.setDaemonConfig({
    server: {
      ...(existing.server ?? {}),
      url: nextServerUrl,
    },
    relay: {
      ...existingRelay,
      enabled: true,
      bindings: addBinding
        ? upsertRelayBinding(seedRelayBindings(existingRelay), nextBinding, hasFlag('replace'))
        : undefined,
      endpoint: addBinding && existingRelay.workspaceId ? existingRelay.endpoint : relayEndpoint,
      serverUrl: addBinding && existingRelay.workspaceId ? existingRelay.serverUrl : nextServerUrl,
      workspaceId: addBinding && existingRelay.workspaceId ? existingRelay.workspaceId : data.workspace_id,
      installId: addBinding && existingRelay.workspaceId ? existingRelay.installId : data.install_id,
      runtimeTargetId:
        addBinding && existingRelay.workspaceId
          ? existingRelay.runtimeTargetId
          : data.runtime_target_id,
      machineId: addBinding && existingRelay.workspaceId ? existingRelay.machineId : data.machine_id,
      machineName: addBinding && existingRelay.workspaceId ? existingRelay.machineName : machineName,
      issueToken: addBinding && existingRelay.workspaceId ? existingRelay.issueToken : nextIssueToken,
    },
  });
}

type RelayConfig = NonNullable<NonNullable<ViewportConfig['daemon']>['relay']>;
type RelayBindingConfig = NonNullable<RelayConfig['bindings']>[number];

function seedRelayBindings(relayConfig: RelayConfig): RelayBindingConfig[] {
  const bindings = [...(relayConfig.bindings ?? [])];
  const hasLegacyBinding =
    relayConfig.workspaceId || relayConfig.endpoint || relayConfig.serverUrl || relayConfig.issueToken;
  if (!hasLegacyBinding) return bindings;
  const alreadySeeded = bindings.some(
    (binding) =>
      binding.workspaceId === relayConfig.workspaceId && binding.serverUrl === relayConfig.serverUrl,
  );
  if (!alreadySeeded) {
    bindings.unshift({
      enabled: relayConfig.enabled,
      endpoint: relayConfig.endpoint,
      serverUrl: relayConfig.serverUrl,
      workspaceId: relayConfig.workspaceId,
      installId: relayConfig.installId,
      runtimeTargetId: relayConfig.runtimeTargetId,
      machineId: relayConfig.machineId,
      machineName: relayConfig.machineName,
      issueToken: relayConfig.issueToken,
      tlsVerify: relayConfig.tlsVerify,
      caCertPath: relayConfig.caCertPath,
      tlsPins: relayConfig.tlsPins,
      tokenIssuer: relayConfig.tokenIssuer,
      tokenAudience: relayConfig.tokenAudience,
      tokenJwksUrl: relayConfig.tokenJwksUrl,
      signingKeys: relayConfig.signingKeys,
      tokenClockSkewSec: relayConfig.tokenClockSkewSec,
    });
  }
  return bindings;
}

function upsertRelayBinding(
  bindings: RelayBindingConfig[],
  next: RelayBindingConfig,
  replaceExisting: boolean,
): RelayBindingConfig[] {
  const exactIndex = bindings.findIndex(
    (binding) => binding.workspaceId === next.workspaceId && binding.serverUrl === next.serverUrl,
  );
  if (exactIndex >= 0) {
    const copy = [...bindings];
    copy[exactIndex] = { ...copy[exactIndex], ...next };
    return copy;
  }

  const workspaceIndex = bindings.findIndex((binding) => binding.workspaceId === next.workspaceId);
  if (workspaceIndex >= 0 && !replaceExisting) {
    throw new Error(
      `This daemon already has a binding for workspace ${next.workspaceId}. Re-run with --replace to replace that binding.`,
    );
  }
  if (workspaceIndex >= 0) {
    const copy = [...bindings];
    copy[workspaceIndex] = next;
    return copy;
  }

  return [...bindings, next];
}

export async function pollForApproval(
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

    if (!asJson) {
      process.stdout.write(`\r  ${spinner[attempt % spinner.length]} Waiting for approval...`);
    }
    attempt++;
    await new Promise((r) => setTimeout(r, PAIRING_POLL_INTERVAL_MS));
  }

  throw new Error('Timed out waiting for pairing approval. Run `vpd pair` again.');
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
