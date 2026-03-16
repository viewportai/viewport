export const SUPERVISOR_CONFIG_ENV = 'VPD_SUPERVISOR_CONFIG';
export const WORKER_CONFIG_ENV = 'VPD_WORKER_CONFIG';

export const WORKER_EXIT_SHUTDOWN = 64;
export const WORKER_EXIT_RESTART = 75;

export interface RuntimeLaunchConfig {
  listen: string;
  host: string;
  port: number;
  socketPath?: string;
  version: string;
  profile: 'local' | 'lan' | 'relay';
  allowedHostsRaw?: string;
  allowedOriginsRaw?: string;
  authEnabled: boolean;
  detached: boolean;
  logPath?: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayServerUrl?: string;
  relayWorkspaceId?: string;
  relayEnrollToken?: string;
  relayIssueToken?: string;
  relayTlsVerify?: 'auto' | '0' | '1';
  relayCaCertPath?: string;
  relayTlsPins?: string[];
  relayTokenIssuer?: string;
  relayTokenAudience?: string;
  relayTokenJwksUrl?: string;
  relayTokenSigningKeys?: Record<string, string>;
  relayTokenClockSkewSec?: number;
}
