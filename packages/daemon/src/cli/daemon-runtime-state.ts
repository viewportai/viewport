import type { DeploymentProfile } from '../server/security.js';

export interface DaemonProcessInfo {
  pid: number;
  uid?: number;
  startedAt?: string;
  command?: string;
}

export interface DaemonRuntimeState {
  pid: number;
  ownerPid: number;
  workerPid?: number;
  port: number;
  host: string;
  listen?: string;
  socketPath?: string;
  startedAt: number;
  version: string;
  mode: 'supervisor' | 'worker';
  ownerUid?: number;
  ownerHostname?: string;
  ownerStartedAt?: string;
  ownerCommand?: string;
  logPath?: string;
  profile?: DeploymentProfile;
  authEnabled?: boolean;
  allowedHostsRaw?: string;
  allowedOriginsRaw?: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayServerUrl?: string;
  relayWorkspaceId?: string;
  relayRuntimeTargetId?: string;
  relayMachineId?: string;
  relayTlsVerify?: 'auto' | '0' | '1';
  tlsEnabled?: boolean;
  tlsHost?: string;
  tlsCertDir?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  runtimeKind?: 'managed' | 'local-dev' | 'self-hosted';
  daemonHome?: string;
  daemonHomeScope?: 'global' | 'resource-override';
  serverUrl?: string;
  resourceOverrideConfigDir?: string;
  resourceOverrideConfigSource?: 'explicit' | 'ancestor';
}
