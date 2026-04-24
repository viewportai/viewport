import { getFlag, hasFlag } from './args.js';
import { loadConfig } from '../core/config.js';
import { resolveDisplayVersion } from '../core/package-meta.js';
import { buildSecurityProfile } from '../server/security.js';
import type { DeploymentProfile } from '../server/security.js';
import { parseListenTarget, type DaemonListenTarget } from './listen-target.js';
import type { RuntimeLaunchConfig } from './supervisor-protocol.js';

export interface DaemonResolvedSettings {
  launch: RuntimeLaunchConfig;
  listenTarget: DaemonListenTarget;
  allowedOriginsRaw?: string;
}

type AllowedValue = string[] | true | undefined;

function parseProfile(value: string | undefined): DeploymentProfile | undefined {
  if (!value) return undefined;
  const lowered = value.trim().toLowerCase();
  if (lowered === 'local' || lowered === 'lan' || lowered === 'relay') {
    return lowered;
  }
  throw new Error(`Invalid profile value: ${value}. Expected local|lan|relay.`);
}

function parseAllowedValue(raw: string | undefined): AllowedValue {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === 'true') return true;
  return trimmed
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function mergeAllowed(values: AllowedValue[]): AllowedValue {
  let merged: string[] = [];
  for (const value of values) {
    if (value === true) return true;
    if (!value) continue;
    merged = merged.concat(value);
  }
  return Array.from(new Set(merged));
}

function stringifyAllowedValue(value: AllowedValue): string | undefined {
  if (value === true) return 'true';
  if (!value || value.length === 0) return undefined;
  return value.join(',');
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  const lowered = value.trim().toLowerCase();
  if (lowered === '1' || lowered === 'true' || lowered === 'yes' || lowered === 'on') return true;
  if (lowered === '0' || lowered === 'false' || lowered === 'no' || lowered === 'off') return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseRelayTlsVerify(value: string | undefined): 'auto' | '0' | '1' | undefined {
  if (!value) return undefined;
  const lowered = value.trim().toLowerCase();
  if (lowered === 'auto') return 'auto';
  if (lowered === '1' || lowered === 'true' || lowered === 'yes' || lowered === 'on') return '1';
  if (lowered === '0' || lowered === 'false' || lowered === 'no' || lowered === 'off') return '0';
  throw new Error(`Invalid relay tls verify value: ${value}. Expected auto|0|1.`);
}

function parseCsvList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer value: ${value}`);
  }
  return parsed;
}

function parseSigningKeys(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Invalid relay token signing keys JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid relay token signing keys JSON: expected object');
  }
  const result: Record<string, string> = {};
  for (const [kid, key] of Object.entries(parsed)) {
    if (typeof kid !== 'string' || typeof key !== 'string') continue;
    const normalizedKid = kid.trim();
    const normalizedKey = key.trim();
    if (!normalizedKid || !normalizedKey) continue;
    result[normalizedKid] = normalizedKey;
  }
  if (Object.keys(result).length === 0) {
    throw new Error('Invalid relay token signing keys JSON: no non-empty keys found');
  }
  return result;
}

function envValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveListenInput(configListen: string | undefined): string {
  const explicitListen = getFlag('listen');
  if (explicitListen) return explicitListen;

  const host = getFlag('host');
  const port = getFlag('port');
  if (host && port) return `${host}:${port}`;
  if (port) return port;
  if (host) return `${host}:7070`;

  const envListen = envValue('VPD_LISTEN', 'VIEWPORT_LISTEN');
  if (envListen) return envListen;

  if (configListen && configListen.trim().length > 0) return configListen.trim();
  return '127.0.0.1:7070';
}

function resolveProfile(configProfile: DeploymentProfile | undefined): DeploymentProfile {
  const cliProfile = parseProfile(getFlag('profile'));
  if (cliProfile) return cliProfile;
  const envProfile = parseProfile(envValue('VPD_PROFILE', 'VIEWPORT_PROFILE'));
  if (envProfile) return envProfile;
  return configProfile ?? 'local';
}

function resolveAuthEnabled(configAuthEnabled: boolean | undefined): boolean {
  if (hasFlag('auth')) return true;
  const envAuth = parseBoolean(envValue('VPD_AUTH', 'VIEWPORT_AUTH'));
  if (envAuth !== undefined) return envAuth;
  return configAuthEnabled ?? false;
}

function resolveDetachedDefault(configDetached?: boolean): boolean {
  if (hasFlag('foreground')) return false;
  if (hasFlag('detached')) return true;
  if (configDetached !== undefined) return configDetached;
  return true;
}

export async function resolveDaemonSettingsFromSources(): Promise<DaemonResolvedSettings> {
  const config = await loadConfig();
  const daemonConfig = config.daemon;

  const listenInput = resolveListenInput(daemonConfig?.listen);
  const listenTarget = parseListenTarget(listenInput);
  const hostForSecurity = listenTarget.type === 'tcp' ? listenTarget.host : '127.0.0.1';

  const profile = resolveProfile(daemonConfig?.profile);

  const mergedAllowedHosts = mergeAllowed([
    daemonConfig?.allowedHosts,
    parseAllowedValue(envValue('VPD_ALLOWED_HOSTS', 'VIEWPORT_ALLOWED_HOSTS')),
    parseAllowedValue(getFlag('allowed-hosts')),
  ]);
  const allowedHostsRaw = stringifyAllowedValue(mergedAllowedHosts);

  const mergedAllowedOrigins = mergeAllowed([
    daemonConfig?.allowedOrigins,
    parseAllowedValue(envValue('VPD_ALLOWED_ORIGINS', 'VIEWPORT_ALLOWED_ORIGINS')),
    parseAllowedValue(getFlag('allowed-origins')),
  ]);
  const allowedOriginsRaw = stringifyAllowedValue(mergedAllowedOrigins);

  const authEnabled = resolveAuthEnabled(daemonConfig?.authEnabled);
  const securityProfile = buildSecurityProfile({
    profile,
    host: hostForSecurity,
    allowedHostsRaw,
    allowedOriginsRaw,
    explicitAuthFlag: authEnabled,
  });

  const logPath =
    getFlag('log-file') ??
    envValue('VPD_LOG_FILE', 'VIEWPORT_LOG_FILE') ??
    daemonConfig?.logFile ??
    undefined;

  const relayEnabledFromEnv = parseBoolean(envValue('VPD_RELAY_ENABLED', 'VIEWPORT_RELAY_ENABLED'));
  const relayEnabled = hasFlag('relay')
    ? true
    : hasFlag('no-relay')
      ? false
      : (relayEnabledFromEnv ?? daemonConfig?.relay?.enabled ?? false);
  const relayEndpoint =
    getFlag('relay-endpoint') ??
    envValue('VPD_RELAY_ENDPOINT', 'VIEWPORT_RELAY_ENDPOINT') ??
    daemonConfig?.relay?.endpoint;
  const relayServerUrl =
    getFlag('relay-server') ??
    envValue('VPD_RELAY_SERVER', 'VIEWPORT_RELAY_SERVER') ??
    daemonConfig?.relay?.serverUrl;
  const relayWorkspaceId =
    getFlag('relay-workspace') ??
    envValue('VPD_RELAY_WORKSPACE', 'VIEWPORT_RELAY_WORKSPACE') ??
    daemonConfig?.relay?.workspaceId;
  const relayProjectMachineBindingId =
    getFlag('relay-project-machine-binding') ??
    envValue('VPD_RELAY_PROJECT_MACHINE_BINDING', 'VIEWPORT_RELAY_PROJECT_MACHINE_BINDING') ??
    daemonConfig?.relay?.projectMachineBindingId;
  const relayMachineId =
    getFlag('relay-machine') ??
    envValue('VPD_RELAY_MACHINE', 'VIEWPORT_RELAY_MACHINE') ??
    daemonConfig?.relay?.machineId;
  const relayIssueToken =
    getFlag('relay-issue-token') ??
    envValue('VPD_RELAY_ISSUE_TOKEN', 'VIEWPORT_RELAY_ISSUE_TOKEN') ??
    daemonConfig?.relay?.issueToken;
  const relayTlsVerify =
    parseRelayTlsVerify(getFlag('relay-tls-verify')) ??
    parseRelayTlsVerify(envValue('VPD_RELAY_TLS_VERIFY', 'VIEWPORT_RELAY_TLS_VERIFY')) ??
    daemonConfig?.relay?.tlsVerify ??
    'auto';
  const relayCaCertPath =
    getFlag('relay-ca-cert') ??
    envValue('VPD_RELAY_CA_CERT', 'VIEWPORT_RELAY_CA_CERT') ??
    daemonConfig?.relay?.caCertPath;
  const relayTlsPins =
    parseCsvList(getFlag('relay-tls-pins')) ??
    parseCsvList(envValue('VPD_RELAY_TLS_PINS', 'VIEWPORT_RELAY_TLS_PINS')) ??
    daemonConfig?.relay?.tlsPins;
  const relayTokenIssuer =
    getFlag('relay-token-issuer') ??
    envValue('VPD_RELAY_TOKEN_ISSUER', 'VIEWPORT_RELAY_TOKEN_ISSUER') ??
    daemonConfig?.relay?.tokenIssuer;
  const relayTokenAudience =
    getFlag('relay-token-audience') ??
    envValue('VPD_RELAY_TOKEN_AUDIENCE', 'VIEWPORT_RELAY_TOKEN_AUDIENCE') ??
    daemonConfig?.relay?.tokenAudience;
  const relayTokenJwksUrl =
    getFlag('relay-token-jwks-url') ??
    envValue('VPD_RELAY_TOKEN_JWKS_URL', 'VIEWPORT_RELAY_TOKEN_JWKS_URL') ??
    daemonConfig?.relay?.tokenJwksUrl ??
    (relayServerUrl
      ? `${relayServerUrl.replace(/\/+$/, '')}/api/.well-known/jwks.json`
      : undefined);
  const relayTokenSigningKeys =
    parseSigningKeys(getFlag('relay-token-signing-keys-json')) ??
    parseSigningKeys(
      envValue('VPD_RELAY_TOKEN_SIGNING_KEYS_JSON', 'VIEWPORT_RELAY_TOKEN_SIGNING_KEYS_JSON'),
    ) ??
    daemonConfig?.relay?.signingKeys;
  const relayTokenClockSkewSec =
    parsePositiveInt(getFlag('relay-token-clock-skew-sec')) ??
    parsePositiveInt(
      envValue('VPD_RELAY_TOKEN_CLOCK_SKEW_SEC', 'VIEWPORT_RELAY_TOKEN_CLOCK_SKEW_SEC'),
    ) ??
    daemonConfig?.relay?.tokenClockSkewSec;

  const launch: RuntimeLaunchConfig = {
    listen: listenTarget.listen,
    host: listenTarget.type === 'tcp' ? listenTarget.host : '127.0.0.1',
    port: listenTarget.type === 'tcp' ? listenTarget.port : 0,
    socketPath: listenTarget.type === 'socket' ? listenTarget.path : undefined,
    version: resolveDisplayVersion(),
    profile: securityProfile.profile,
    allowedHostsRaw,
    allowedOriginsRaw,
    authEnabled: securityProfile.requireAuth,
    detached: resolveDetachedDefault(undefined),
    logPath,
    serverUrl:
      getFlag('server-url') ??
      envValue('VPD_SERVER_URL', 'VIEWPORT_SERVER_URL') ??
      daemonConfig?.server?.url ??
      relayServerUrl,
    serverTlsVerify:
      parseRelayTlsVerify(getFlag('server-tls-verify')) ??
      parseRelayTlsVerify(envValue('VPD_SERVER_TLS_VERIFY', 'VIEWPORT_SERVER_TLS_VERIFY')) ??
      daemonConfig?.server?.tlsVerify ??
      'auto',
    serverCaCertPath:
      getFlag('server-ca-cert') ??
      envValue('VPD_SERVER_CA_CERT', 'VIEWPORT_SERVER_CA_CERT') ??
      daemonConfig?.server?.caCertPath,
    serverTlsPins:
      parseCsvList(getFlag('server-tls-pins')) ??
      parseCsvList(envValue('VPD_SERVER_TLS_PINS', 'VIEWPORT_SERVER_TLS_PINS')) ??
      daemonConfig?.server?.tlsPins,
    relayEnabled,
    relayEndpoint,
    relayServerUrl,
    relayWorkspaceId,
    relayProjectMachineBindingId,
    relayMachineId,
    relayIssueToken,
    relayTlsVerify,
    relayCaCertPath,
    relayTlsPins,
    relayTokenIssuer,
    relayTokenAudience,
    relayTokenJwksUrl,
    relayTokenSigningKeys,
    relayTokenClockSkewSec,
  };

  return {
    launch,
    listenTarget,
    allowedOriginsRaw,
  };
}
