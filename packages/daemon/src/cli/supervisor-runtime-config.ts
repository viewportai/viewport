import type { RuntimeLaunchConfig } from './supervisor-protocol.js';

export function encodeRuntimeConfig(config: RuntimeLaunchConfig): string {
  return Buffer.from(JSON.stringify(config), 'utf-8').toString('base64url');
}

export function decodeRuntimeConfig(raw: string | undefined): RuntimeLaunchConfig {
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
    relayProjectMachineBindingId:
      typeof parsed.relayProjectMachineBindingId === 'string'
        ? parsed.relayProjectMachineBindingId
        : undefined,
    relayMachineId: typeof parsed.relayMachineId === 'string' ? parsed.relayMachineId : undefined,
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
