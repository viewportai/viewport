import type { WebSocket as WsType } from 'ws';
import WebSocket from 'ws';
import { resolveRelayTlsOptions, wsOpen } from './bridge-network.js';

type RelayWs = WsType;

export interface OpenDaemonSocketOptions {
  daemonWsUrl: string;
  daemonAuthToken?: string;
  daemonTlsVerify?: 'auto' | '0' | '1';
  daemonCaCertPath?: string;
  daemonTlsPins?: string[];
}

export interface RelayDaemonUrlOptions {
  relayEndpoint: string;
  workspaceId: string;
  projectMachineBindingId?: string;
}

export interface OpenRelayDaemonSocketOptions extends RelayDaemonUrlOptions {
  relayToken: string;
  relayTlsVerify?: 'auto' | '0' | '1';
  relayCaCertPath?: string;
  relayTlsPins?: string[];
}

export function daemonAuthHeaders(token: string | undefined): Record<string, string> | undefined {
  if (!token) return undefined;
  return { authorization: `Bearer ${token}` };
}

export function relayDaemonUrl(options: RelayDaemonUrlOptions): string {
  return (
    `${options.relayEndpoint}?role=workspace-daemon` +
    `&workspaceId=${encodeURIComponent(options.workspaceId)}` +
    (options.projectMachineBindingId
      ? `&projectMachineBindingId=${encodeURIComponent(options.projectMachineBindingId)}`
      : '')
  );
}

export async function openDaemonSocket(options: OpenDaemonSocketOptions): Promise<RelayWs> {
  const daemonWs = new WebSocket(options.daemonWsUrl, {
    ...resolveRelayTlsOptions(
      options.daemonWsUrl,
      options.daemonTlsVerify ?? 'auto',
      options.daemonCaCertPath,
      options.daemonTlsPins,
    ),
    headers: daemonAuthHeaders(options.daemonAuthToken),
  });
  await wsOpen(daemonWs);
  return daemonWs;
}

export async function openRelayDaemonSocket(
  options: OpenRelayDaemonSocketOptions,
): Promise<RelayWs> {
  const relayUrl = relayDaemonUrl(options);
  const relayWs = new WebSocket(relayUrl, {
    ...resolveRelayTlsOptions(
      relayUrl,
      options.relayTlsVerify ?? 'auto',
      options.relayCaCertPath,
      options.relayTlsPins,
    ),
    headers: {
      authorization: `Bearer ${options.relayToken}`,
    },
  });
  await wsOpen(relayWs);
  return relayWs;
}
