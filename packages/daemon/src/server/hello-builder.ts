/**
 * Bootstrap snapshot builder — constructs the current daemon state snapshot.
 *
 * `hello` is the initial bootstrap emitted on connect.
 * `sync-snapshot` is the explicit resync payload used after transport setup
 * changes such as reconnect or relay key exchange.
 */

import type { Daemon } from '../core/daemon.js';
import type { AgentRegistry } from '../core/agent-registry.js';
import { logger } from '../core/logger.js';
import { resolveDisplayVersion } from '../core/package-meta.js';
import { resolveDaemonRuntimeIdentity } from '../core/runtime-identity.js';

const MAX_DISCOVERED_HELLO_SESSIONS = 1_000;
const log = logger.child({ module: 'hello-builder' });

// ---------------------------------------------------------------------------
// Connected client interface (shared with ws-server)
// ---------------------------------------------------------------------------

export interface ConnectedClient {
  send: (data: string) => void;
  subscriptions: Set<string>;
  watchedDiscoveredSessions: Set<string>;
  /** Bytes queued for this client but not yet flushed by the kernel. */
  pendingBytes: number;
}

export interface SnapshotPayload {
  protocolVersion: 2;
  machine: {
    id: string;
    daemonVersion: string;
    runtimeKind: 'managed' | 'local-dev' | 'self-hosted';
    daemonHomeScope: 'global' | 'project-override';
    profile?: 'local' | 'lan' | 'relay';
    serverUrl?: string;
    relayEndpoint?: string;
    relayServerUrl?: string;
  };
  directories: Array<{
    id: string;
    path: string;
    name: string;
  }>;
  activeSessions: Array<{
    id: string;
    directoryId: string;
    state: string;
  }>;
  discoveredSessions: Array<{
    id: string;
    agentId: string;
    directoryId: string;
    summary: string;
    lastActivity: number;
    messageCount: number;
    resumable: boolean;
  }>;
  discoveredSessionsTruncated: boolean;
  availableAgents: string[];
  agents: Array<unknown>;
  models: Array<unknown>;
}

export function buildSnapshotPayload(daemon: Daemon, registry?: AgentRegistry): SnapshotPayload {
  const directories = daemon.directoryManager.list().map((d) => ({
    id: d.id,
    path: d.path,
    name: d.path.split('/').pop() ?? d.path,
  }));

  const activeSessions = daemon.getActiveSessions().map((id) => {
    const info = daemon.getSessionInfo(id);
    return { id, directoryId: info.directoryId, state: info.state };
  });

  // Include discovered sessions from JSONL files
  const discoveredSessions: Array<{
    id: string;
    agentId: string;
    directoryId: string;
    summary: string;
    lastActivity: number;
    messageCount: number;
    resumable: boolean;
  }> = [];

  for (const [directoryId, sessions] of daemon.getDiscoveredSessions()) {
    for (const s of sessions) {
      if (discoveredSessions.length >= MAX_DISCOVERED_HELLO_SESSIONS) break;
      discoveredSessions.push({
        id: s.sessionId,
        agentId: s.agentId,
        directoryId,
        summary: s.summary,
        lastActivity: s.lastModified,
        messageCount: s.messageCount ?? 0,
        resumable: s.resumable,
      });
    }
    if (discoveredSessions.length >= MAX_DISCOVERED_HELLO_SESSIONS) break;
  }

  // Rich agent info with capabilities (if registry available)
  const agents = registry
    ? registry.toHelloPayload()
    : daemon.getAvailableAgents().map((id) => ({
        id,
        displayName: id,
        tier: 'sdk' as const,
        available: true,
        capabilities: {
          structuredToolCalls: true,
          permissionCallbacks: true,
          tokenUsage: true,
          resume: true,
          extendedThinking: true,
        },
      }));

  // Include available models from agent SDKs (cached after first fetch)
  const models = registry ? registry.getCachedModels() : [];
  const machine = resolveDaemonRuntimeIdentity({
    daemonConfig: daemon.configManager.getDaemonConfig(),
    machineId: daemon.configManager.getMachineId(),
    daemonVersion: resolveDisplayVersion(),
  });

  return {
    protocolVersion: 2,
    machine: {
      id: machine.machineId ?? daemon.configManager.getMachineId(),
      daemonVersion: machine.daemonVersion,
      runtimeKind: machine.runtimeKind,
      daemonHomeScope: machine.daemonHomeScope,
      profile: machine.profile,
      serverUrl: machine.serverUrl,
      relayEndpoint: machine.relayEndpoint,
      relayServerUrl: machine.relayServerUrl,
    },
    directories,
    activeSessions,
    discoveredSessions,
    discoveredSessionsTruncated: discoveredSessions.length >= MAX_DISCOVERED_HELLO_SESSIONS,
    availableAgents: daemon.getAvailableAgents(),
    agents,
    models,
  };
}

function logSnapshotDelivery(kind: 'hello' | 'sync-snapshot', snapshot: SnapshotPayload): void {
  log.debug(
    {
      type: kind,
      directories: snapshot.directories.length,
      activeSessions: snapshot.activeSessions.length,
      discoveredSessions: snapshot.discoveredSessions.length,
      discoveredSessionsTruncated: snapshot.discoveredSessionsTruncated,
      availableAgents: snapshot.availableAgents.length,
      models: snapshot.models.length,
    },
    'Sending daemon snapshot payload',
  );
}

export function sendHello(client: ConnectedClient, daemon: Daemon, registry?: AgentRegistry): void {
  const snapshot = buildSnapshotPayload(daemon, registry);
  logSnapshotDelivery('hello', snapshot);
  client.send(JSON.stringify({ type: 'hello', ...snapshot }));
}

export function sendSyncSnapshot(
  client: ConnectedClient,
  daemon: Daemon,
  registry?: AgentRegistry,
): void {
  const snapshot = buildSnapshotPayload(daemon, registry);
  logSnapshotDelivery('sync-snapshot', snapshot);
  client.send(JSON.stringify({ type: 'sync-snapshot', ...snapshot }));
}
