import type { WebSocket } from 'ws';

export type RelayRole = 'workspace-daemon' | 'client' | 'worker';

export interface AdmissionClaims {
  clientId?: string;
  userId?: string;
  installId?: string;
  managedExecutorId?: string;
  runtimeTargetId?: string;
  machineId?: string;
  role?: RelayRole;
  workspaceId?: string;
  scope?: 'runtime' | 'pairing' | 'session-events';
  sessionIds?: string[];
  sessionChannels?: string[];
  e2eeProfile?: 'noise-ik' | 'noise-ikpsk2';
  policyMode?: string;
  daemonPublicKey?: string | null;
  pairingSecret?: string | null;
  relayWsBaseUrl?: string | null;
  iss?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number;
  nbf?: number;
  ver?: number;
  jti?: string;
  daemonIssueGeneration?: number;
}

export interface AdmissionResult {
  ok: boolean;
  status: number;
  reason: string;
  claims?: AdmissionClaims;
}

export interface ClientConnectionMeta {
  clientId: string;
  connectedAt: number;
}

export interface WorkspaceState {
  workspaceId: string;
  runtimeTargetId?: string;
  daemon: WebSocket | null;
  daemonIssueGeneration: number | null;
  clients: Map<WebSocket, ClientConnectionMeta>;
  sessionEventSubscribers: Map<string, Set<WebSocket>>;
  keyExchangeRequests: Map<
    string,
    {
      clientWs?: WebSocket;
      sourceRelayId?: string;
      createdAt: number;
    }
  >;
  sessionOwners: Map<
    string,
    {
      clientWs?: WebSocket;
      sourceRelayId?: string;
      createdAt: number;
    }
  >;
  pairingRequests: Map<
    string,
    {
      clientWs?: WebSocket;
      sourceRelayId?: string;
      createdAt: number;
    }
  >;
  lastActivityAt: number;
}

export interface RelayLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  details: Record<string, unknown>;
}

export interface RelayStatusPayload {
  type: 'relay_status';
  code: string;
  message: string;
  workspaceId: string;
  runtimeTargetId?: string;
  machineId?: string;
  retryable?: boolean;
  relayWsBaseUrl?: string;
}
