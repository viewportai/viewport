import { ConfigManager } from '../core/config.js';
import type { ViewportConfig } from '../core/config.js';
import { sanitizeMachineDisplayName } from '../core/machine-name.js';
import { getFlag, hasFlag } from './args.js';
import { parseCsvList, parseTlsVerifyMode, transportFetch } from './network.js';
import { inferRelayEndpointFromServer } from './remote-commands.js';
import {
  createRelayMachineId,
  ensureRelayBindingMachineId,
  seedRelayBindings,
  upsertRelayBinding,
} from './relay-binding-config.js';

const DEFAULT_PAIRING_SERVER = 'https://api.getviewport.com';
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

function inferRelayTokenJwksUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/api/.well-known/jwks.json`;
}

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
      `This daemon is already paired to workspace ${existingRelay.workspaceId}. Re-run with --replace to delete that binding and replace it with ${data.workspace_id}. Use --add to keep both organizations paired.`,
    );
  }

  let relayEndpoint = data.relay_endpoint ?? existingRelay.endpoint;
  if (!relayEndpoint) {
    relayEndpoint = inferRelayEndpointFromServer(nextServerUrl);
  }

  const nextIssueToken = data.token?.trim() ? data.token.trim() : existingRelay.issueToken;
  const machineName = sanitizeMachineDisplayName(data.daemon_name) ?? existingRelay.machineName;
  const seededBindings = seedRelayBindings(existingRelay);
  const nextBinding = ensureRelayBindingMachineId({
    enabled: true,
    endpoint: relayEndpoint,
    serverUrl: nextServerUrl,
    workspaceId: data.workspace_id,
    installId: data.install_id,
    runtimeTargetId: data.runtime_target_id,
    machineId: data.machine_id ?? createRelayMachineId(),
    machineName,
    issueToken: nextIssueToken,
    tokenIssuer: existingRelay.tokenIssuer,
    tokenAudience: existingRelay.tokenAudience,
    tokenJwksUrl: existingRelay.tokenJwksUrl ?? inferRelayTokenJwksUrl(nextServerUrl),
    signingKeys: existingRelay.signingKeys,
    tokenClockSkewSec: existingRelay.tokenClockSkewSec,
  });
  const nextBindings = addBinding
    ? upsertRelayBinding(seededBindings, nextBinding, hasFlag('replace'))
    : [nextBinding];
  const primaryBinding =
    addBinding && existingRelay.workspaceId
      ? (nextBindings.find(
          (binding) =>
            binding.workspaceId === existingRelay.workspaceId &&
            binding.serverUrl === existingRelay.serverUrl,
        ) ??
        nextBindings[0] ??
        nextBinding)
      : nextBinding;

  await manager.setDaemonConfig({
    server: {
      ...(existing.server ?? {}),
      url: nextServerUrl,
    },
    relay: {
      ...existingRelay,
      enabled: true,
      bindings: nextBindings,
      endpoint: primaryBinding.endpoint,
      serverUrl: primaryBinding.serverUrl,
      workspaceId: primaryBinding.workspaceId,
      installId: primaryBinding.installId,
      runtimeTargetId: primaryBinding.runtimeTargetId,
      machineId: primaryBinding.machineId,
      machineName: primaryBinding.machineName,
      issueToken: primaryBinding.issueToken,
    },
  });
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
    if (url.hostname === 'getviewport.test' || url.hostname === 'api.getviewport.test') {
      url.hostname = 'app.getviewport.test';
      return url.toString().replace(/\/$/, '');
    }
    if (url.hostname === 'getviewport.dev' || url.hostname === 'api.getviewport.dev') {
      url.hostname = 'app.getviewport.dev';
      return url.toString().replace(/\/$/, '');
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return input.serverUrl;
  }
}
