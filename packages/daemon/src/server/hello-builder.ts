/**
 * Bootstrap snapshot builder — constructs the current daemon state snapshot.
 *
 * `hello` is the initial bootstrap emitted on connect.
 * `sync-snapshot` is the explicit resync payload used after transport setup
 * changes such as reconnect or relay key exchange.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import type { Daemon } from '../core/daemon.js';
import type { AgentRegistry } from '../core/agent-registry.js';
import { logger } from '../core/logger.js';
import { sanitizeMachineDisplayName } from '../core/machine-name.js';
import { resolveDisplayVersion } from '../core/package-meta.js';
import { resolveDaemonRuntimeIdentity } from '../core/runtime-identity.js';
import {
  resolveSessionResourceManifestSync,
  type SessionResourceManifest,
} from '../config-resolution/index.js';
import { createGitMetadataResolver } from '../session-enrichment/git.js';
import { isRecentlyDiscoveredSession } from './discovered-session-window.js';

const MAX_DISCOVERED_HELLO_SESSIONS = 1_000;
const log = logger.child({ module: 'hello-builder' });
let cachedMachineDisplayName: string | undefined;

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
    name?: string;
    daemonVersion: string;
    runtimeKind: 'managed' | 'local-dev' | 'self-hosted';
    daemonHomeScope: 'global' | 'resource-override';
    profile?: 'local' | 'lan' | 'relay';
    serverUrl?: string;
    relayEndpoint?: string;
    relayServerUrl?: string;
  };
  directories: Array<{
    id: string;
    path: string;
    name: string;
    isGitRepository: boolean;
    repoRoot: string | null;
    repoRemoteUrl: string | null;
    repoBranch: string | null;
    repoSha: string | null;
  }>;
  activeSessions: Array<{
    id: string;
    directoryId: string;
    state: string;
    workingDirectory: string | null;
    repoRoot: string | null;
    repoRemoteUrl: string | null;
    repoBranch: string | null;
    repoSha: string | null;
    resourceManifest: SessionResourceManifest;
  }>;
  discoveredSessions: Array<{
    id: string;
    agentId: string;
    directoryId: string;
    summary: string;
    lastActivity: number;
    messageCount: number;
    resumable: boolean;
    workflowRunId?: string;
    workflowNodeId?: string;
    parentDirectoryId?: string;
    parentDirectoryPath?: string;
    worktreePath?: string;
    workingDirectory: string | null;
    repoRoot: string | null;
    repoRemoteUrl: string | null;
    repoBranch: string | null;
    repoSha: string | null;
    resourceManifest: SessionResourceManifest;
  }>;
  discoveredSessionsTruncated: boolean;
  availableAgents: string[];
  agents: Array<unknown>;
  models: Array<unknown>;
}

export function buildSnapshotPayload(daemon: Daemon, registry?: AgentRegistry): SnapshotPayload {
  const gitMetadataFor = createGitMetadataResolver();
  const directories = daemon.directoryManager.list().map((d) => {
    const git = gitMetadataFor(d.path);
    return {
      id: d.id,
      path: d.path,
      name: d.path.split('/').pop() ?? d.path,
      isGitRepository: git.isGitRepository,
      repoRoot: git.repoRoot,
      repoRemoteUrl: git.repoRemoteUrl,
      repoBranch: git.repoBranch,
      repoSha: git.repoSha,
    };
  });

  const activeSessions = daemon.getActiveSessions().map((id) => {
    const info = daemon.getSessionInfo(id);
    const dir = daemon.directoryManager.get(info.directoryId);
    const workingDirectory = dir?.path ?? null;
    const git = gitMetadataFor(workingDirectory);
    return {
      id,
      directoryId: info.directoryId,
      state: info.state,
      workingDirectory,
      repoRoot: git.repoRoot,
      repoRemoteUrl: git.repoRemoteUrl,
      repoBranch: git.repoBranch,
      repoSha: git.repoSha,
      resourceManifest: resolveManifest(workingDirectory),
    };
  });

  // Include only recent discovered sessions by default. Full local history stays
  // available through the explicit per-directory `list-sessions` command.
  const discoveredSessions: SnapshotPayload['discoveredSessions'] = [];
  const now = Date.now();

  for (const [directoryId, sessions] of daemon.getDiscoveredSessions()) {
    for (const s of sessions) {
      if (!isRecentlyDiscoveredSession(s, now)) continue;
      if (discoveredSessions.length >= MAX_DISCOVERED_HELLO_SESSIONS) break;
      const workingDirectory =
        s.cwd ?? s.worktreePath ?? daemon.directoryManager.get(directoryId)?.path ?? null;
      const git = gitMetadataFor(workingDirectory);
      const discoveredSession: SnapshotPayload['discoveredSessions'][number] = {
        id: s.sessionId,
        agentId: s.agentId,
        directoryId,
        summary: s.summary,
        lastActivity: s.lastModified,
        messageCount: s.messageCount ?? 0,
        resumable: s.resumable,
        workingDirectory,
        repoRoot: git.repoRoot,
        repoRemoteUrl: git.repoRemoteUrl,
        repoBranch: git.repoBranch,
        repoSha: git.repoSha,
        resourceManifest: resolveManifest(workingDirectory),
      };
      if (s.workflowRunId) discoveredSession.workflowRunId = s.workflowRunId;
      if (s.workflowNodeId) discoveredSession.workflowNodeId = s.workflowNodeId;
      if (s.parentDirectoryId) discoveredSession.parentDirectoryId = s.parentDirectoryId;
      if (s.parentDirectoryPath) discoveredSession.parentDirectoryPath = s.parentDirectoryPath;
      if (s.worktreePath) discoveredSession.worktreePath = s.worktreePath;
      discoveredSessions.push(discoveredSession);
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
  const machineName = resolveMachineDisplayName(
    daemon.configManager.getDaemonConfig()?.relay?.machineName,
  );

  return {
    protocolVersion: 2,
    machine: {
      id: machine.machineId ?? daemon.configManager.getMachineId(),
      name: machineName,
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

function resolveMachineDisplayName(configuredName: string | undefined): string | undefined {
  const fromConfig = sanitizeMachineDisplayName(configuredName);
  if (fromConfig) return fromConfig;
  const fromEnv = sanitizeMachineDisplayName(process.env['VIEWPORT_MACHINE_NAME']);
  if (fromEnv) return fromEnv;
  if (cachedMachineDisplayName !== undefined) return cachedMachineDisplayName || undefined;

  if (process.platform === 'darwin') {
    try {
      const computerName = execFileSync('scutil', ['--get', 'ComputerName'], {
        encoding: 'utf-8',
        timeout: 500,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const sanitized = sanitizeMachineDisplayName(computerName);
      if (sanitized) {
        cachedMachineDisplayName = sanitized;
        return cachedMachineDisplayName;
      }
    } catch {
      // Fall through to hostname.
    }
  }

  cachedMachineDisplayName = sanitizeMachineDisplayName(os.hostname()) ?? '';
  return cachedMachineDisplayName || undefined;
}

function resolveManifest(workingDirectory: string | null | undefined): SessionResourceManifest {
  return resolveSessionResourceManifestSync({
    workingDirectory: workingDirectory ?? process.cwd(),
  });
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
