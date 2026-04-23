import type { WebSocket } from 'ws';

export type RelayRole = 'workspace-daemon' | 'client';

export interface AdmissionClaims {
  clientId?: string;
  userId?: string;
  installId?: string;
  role?: RelayRole;
  workspaceId?: string;
  scope?: 'runtime' | 'pairing';
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
  installId?: string;
}

export interface DaemonConnectionMeta {
  installId: string;
  ws: WebSocket;
  issueGeneration: number | null;
}

export interface WorkspaceState {
  daemons: Map<string, DaemonConnectionMeta>;
  clients: Map<WebSocket, ClientConnectionMeta>;
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
  installId?: string;
  relayWsBaseUrl?: string;
}
