import type { Daemon } from '../core/daemon.js';
import type { AgentRegistry } from '../core/agent-registry.js';
import { logger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';
import type { HookRouter } from '../hooks/router.js';
import type { SupervisionManager } from '../hooks/supervision.js';
import type { ConnectedClient } from './hello-builder.js';
import { sendHello } from './hello-builder.js';
import { messageToUpdate, permissionToUpdate, stepToUpdate } from './message-normalizers.js';
import type { RingBuffer } from './ring-buffer.js';
import { resolveMatchedDiscoveredWatch } from './discovered-watch-key.js';
import { createGitMetadataResolver } from '../session-enrichment/git.js';
import {
  resolveSessionResourceManifestSync,
  type SessionResourceManifest,
} from '../config-resolution/index.js';
import { isRecentlyDiscoveredSession } from './discovered-session-window.js';

const log = logger.child({ module: 'ws-daemon-event-bridge' });

const MAX_DISCOVERED_BROADCAST = 1_000;
const BUFFER_EVICTION_MS = 60_000;
const BUFFER_CLEANUP_INTERVAL_MS = 30_000;
const MAX_ENDED_SESSION_TRACKING = 4096;

function isErrorReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return (
    normalized.startsWith('error:') ||
    normalized.includes('exited with code') ||
    normalized.includes('history_poisoned') ||
    normalized.includes('failed')
  );
}

interface RegisterWsDaemonEventBridgeOptions {
  daemon: Daemon;
  registry?: AgentRegistry;
  clients: Set<ConnectedClient>;
  ringBuffers: Map<string, RingBuffer>;
  sessionStreaming: Map<string, boolean>;
  broadcastUpdate: (sessionId: string, update: Record<string, unknown>) => void;
  hookRouter?: HookRouter;
  supervision?: SupervisionManager;
}

/**
 * Wires daemon events into WS client broadcasts and returns a cleanup function.
 */
export function registerWsDaemonEventBridge(
  options: RegisterWsDaemonEventBridgeOptions,
): () => void {
  const {
    daemon,
    registry,
    clients,
    ringBuffers,
    sessionStreaming,
    broadcastUpdate,
    hookRouter,
    supervision,
  } = options;

  const sessionEndTimes = new Map<string, number>();
  const enforceEndedSessionTrackingCapacity = (): void => {
    while (sessionEndTimes.size > MAX_ENDED_SESSION_TRACKING) {
      const oldest = sessionEndTimes.keys().next();
      if (oldest.done) break;
      sessionEndTimes.delete(oldest.value);
    }
  };
  const resolveDirectoryId = (sessionId: string): string | undefined => {
    try {
      return daemon.getSessionInfo(sessionId).directoryId;
    } catch {
      return undefined;
    }
  };
  const broadcastSessionAlert = (payload: {
    sessionId: string;
    directoryId?: string;
    requiresAttention: boolean;
    reason?: 'permission' | 'completed' | 'errored' | 'idle_timeout';
    toolName?: string;
    requestId?: string;
    detail?: string;
    timestamp: number;
  }): void => {
    const msg = JSON.stringify({
      type: 'session-alert',
      ...payload,
    });
    for (const client of clients) {
      client.send(msg);
    }
  };
  const sendToSessionSubscribers = (sessionId: string, payload: Record<string, unknown>): void => {
    const msg = JSON.stringify(payload);
    for (const client of clients) {
      if (client.subscriptions.has(sessionId)) {
        client.send(msg);
      }
    }
  };

  daemon.on('session:message', ({ sessionId, message }) => {
    broadcastUpdate(sessionId, messageToUpdate(message));

    const isStreaming =
      message.type === 'agent_message_chunk' || message.type === 'agent_thought_chunk';
    const wasStreaming = sessionStreaming.get(sessionId) ?? false;
    if (isStreaming !== wasStreaming) {
      sessionStreaming.set(sessionId, isStreaming);
      broadcastUpdate(sessionId, {
        updateType: 'streaming-state',
        streaming: isStreaming,
        timestamp: Date.now(),
      });
    }
  });

  daemon.on('session:state-changed', ({ sessionId, state }) => {
    const stateChangedAt = Date.now();
    broadcastUpdate(sessionId, { updateType: 'state-change', state, timestamp: stateChangedAt });
    if (state === 'errored') {
      broadcastUpdate(sessionId, {
        updateType: 'attention',
        requiresAttention: true,
        reason: 'errored',
        timestamp: stateChangedAt,
      });
    }
  });

  daemon.on('session:ended', ({ sessionId, reason }) => {
    const errored = isErrorReason(reason);
    const endedAt = Date.now();
    broadcastUpdate(sessionId, {
      updateType: 'state-change',
      state: errored ? 'errored' : 'completed',
      reason,
      timestamp: endedAt,
    });
    broadcastUpdate(sessionId, {
      updateType: 'attention',
      requiresAttention: true,
      reason: errored ? 'errored' : 'completed',
      timestamp: endedAt,
    });
    broadcastSessionAlert({
      sessionId,
      directoryId: resolveDirectoryId(sessionId),
      requiresAttention: true,
      reason: errored ? 'errored' : 'completed',
      detail: reason,
      timestamp: endedAt,
    });

    const endedMsg = JSON.stringify({
      type: 'session-ended',
      sessionId,
      reason,
      timestamp: endedAt,
    });
    for (const client of clients) {
      if (client.subscriptions.has(sessionId)) {
        client.send(endedMsg);
      }
    }

    sessionStreaming.delete(sessionId);
    sessionEndTimes.set(sessionId, Date.now());
    enforceEndedSessionTrackingCapacity();
  });

  daemon.on('step:committed', ({ sessionId, step }) => {
    broadcastUpdate(sessionId, stepToUpdate(step));
  });

  daemon.on('step:rollback', ({ sessionId, toSha }) => {
    broadcastUpdate(sessionId, { updateType: 'step-rollback', toSha, timestamp: Date.now() });
  });

  daemon.on('step:branch-retry', ({ sessionId, fromSha, retryPath }) => {
    broadcastUpdate(sessionId, {
      updateType: 'step-branch-retry',
      fromSha,
      retryPath,
      timestamp: Date.now(),
    });
  });

  daemon.on('step:squash-merged', ({ sessionId, targetBranch }) => {
    broadcastUpdate(sessionId, {
      updateType: 'step-squash-merged',
      targetBranch,
      timestamp: Date.now(),
    });
  });

  daemon.on('permission:requested', ({ sessionId, request }) => {
    broadcastUpdate(sessionId, permissionToUpdate(request));
    broadcastSessionAlert({
      sessionId,
      directoryId: resolveDirectoryId(sessionId),
      requiresAttention: true,
      reason: 'permission',
      toolName: request.toolName,
      requestId: request.requestId,
      timestamp: Date.now(),
    });
    broadcastUpdate(sessionId, {
      updateType: 'attention',
      requiresAttention: true,
      reason: 'permission',
      toolName: request.toolName,
      timestamp: Date.now(),
    });
  });

  daemon.on('permission:responded', ({ sessionId, requestId }) => {
    const now = Date.now();
    broadcastUpdate(sessionId, {
      updateType: 'permission-resolved',
      requestId,
      timestamp: now,
    });
    broadcastUpdate(sessionId, {
      updateType: 'attention',
      requiresAttention: false,
      timestamp: now,
    });
    broadcastSessionAlert({
      sessionId,
      directoryId: resolveDirectoryId(sessionId),
      requiresAttention: false,
      reason: 'permission',
      requestId,
      timestamp: now,
    });
  });

  daemon.on('session:attention', ({ sessionId, attention }) => {
    const timestamp = attention.timestamp ?? Date.now();
    broadcastUpdate(sessionId, {
      updateType: 'attention',
      requiresAttention: attention.requiresAttention,
      reason: attention.reason,
      toolName: attention.toolName,
      timestamp,
    });
    broadcastSessionAlert({
      sessionId,
      directoryId: resolveDirectoryId(sessionId),
      requiresAttention: attention.requiresAttention,
      reason: attention.reason,
      toolName: attention.toolName,
      timestamp,
    });
  });

  daemon.on('discovery:updated', () => {
    const gitMetadataFor = createGitMetadataResolver();
    const sessions: Array<{
      id: string;
      agentId: string;
      directoryId: string;
      summary: string;
      lastActivity: number;
      messageCount: number;
      resumable: boolean;
      workingDirectory: string | null;
      repoRoot: string | null;
      repoRemoteUrl: string | null;
      repoBranch: string | null;
      repoSha: string | null;
      resourceManifest: SessionResourceManifest;
    }> = [];

    const now = Date.now();
    for (const [directoryId, discovered] of daemon.getDiscoveredSessions()) {
      for (const s of discovered) {
        if (sessions.length >= MAX_DISCOVERED_BROADCAST) break;
        if (!isRecentlyDiscoveredSession(s, now)) continue;
        const directoryPath = daemon.directoryManager.get(directoryId)?.path;
        const workingDirectory = s.cwd ?? s.worktreePath ?? directoryPath ?? null;
        const git = gitMetadataFor(workingDirectory);
        sessions.push({
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
          resourceManifest: resolveSessionResourceManifestSync({
            workingDirectory: workingDirectory ?? process.cwd(),
          }),
        });
      }
      if (sessions.length >= MAX_DISCOVERED_BROADCAST) break;
    }

    const updateMsg = JSON.stringify({
      type: 'discovered-sessions-updated',
      sessions,
      truncated: sessions.length >= MAX_DISCOVERED_BROADCAST,
    });

    for (const client of clients) {
      client.send(updateMsg);
    }
    metrics.increment('ws.discovery.broadcast');
  });

  daemon.on('directory:registered', () => {
    for (const client of clients) {
      sendHello(client, daemon, registry);
    }
  });

  daemon.on('directory:unregistered', () => {
    for (const client of clients) {
      sendHello(client, daemon, registry);
    }
  });

  daemon.on('workflow:run-updated', ({ run }) => {
    const msg = JSON.stringify({ type: 'workflow-run-updated', run });
    for (const client of clients) {
      client.send(msg);
    }
  });

  daemon.on('discovery:session-tail', ({ sessionId, sessionIds, directoryId, newBlocks }) => {
    const aliases = Array.from(new Set([sessionId, ...(sessionIds ?? [])]));
    for (const client of clients) {
      const matchedSessionId = resolveMatchedDiscoveredWatch(
        client.watchedDiscoveredSessions,
        aliases,
        directoryId,
      );
      if (!matchedSessionId) continue;
      const msg = JSON.stringify({
        type: 'discovered-session-tail',
        // Echo the matched watched id so UI stays scoped to the currently open view.
        sessionId: matchedSessionId,
        directoryId,
        blocks: newBlocks,
      });
      client.send(msg);
    }
  });

  daemon.on(
    'discovery:session-waiting',
    ({ sessionId, directoryId, waiting, toolName, toolInput }) => {
      const msg = JSON.stringify({
        type: 'discovered-session-waiting',
        sessionId,
        directoryId,
        waiting,
        toolName,
        toolInput,
      });
      for (const client of clients) {
        client.send(msg);
      }
    },
  );

  daemon.on('hook:session-start', (data) => {
    const msg = JSON.stringify({ type: 'hook-session-start', ...data, timestamp: Date.now() });
    for (const client of clients) client.send(msg);
  });

  daemon.on('hook:session-end', (data) => {
    const msg = JSON.stringify({ type: 'hook-session-end', ...data, timestamp: Date.now() });
    for (const client of clients) client.send(msg);
    hookRouter?.releaseSession(data.sessionId);
  });

  daemon.on('hook:permission-request', (data) => {
    const msg = JSON.stringify({
      type: 'hook-permission-request',
      ...data,
      timestamp: Date.now(),
    });
    if (supervision) {
      const supervisors = supervision.getSupervisors(data.sessionId);
      if (supervisors.size > 0) {
        for (const client of supervisors) client.send(msg);
      }
    }
    for (const client of clients) client.send(msg);
  });

  daemon.on('hook:notification', (data) => {
    const msg = JSON.stringify({ type: 'hook-notification', ...data, timestamp: Date.now() });
    for (const client of clients) client.send(msg);
  });

  daemon.on('hook:tool-completed', (data) => {
    const msg = JSON.stringify({ type: 'hook-tool-completed', ...data, timestamp: Date.now() });
    for (const client of clients) client.send(msg);
  });

  daemon.on('hook:tool-failed', (data) => {
    const msg = JSON.stringify({ type: 'hook-tool-failed', ...data, timestamp: Date.now() });
    for (const client of clients) client.send(msg);
  });

  daemon.on('hook:stop', (data) => {
    sendToSessionSubscribers(data.sessionId, {
      type: 'hook-stop',
      sessionId: data.sessionId,
      adapter: data.adapter,
      timestamp: Date.now(),
    });
  });

  daemon.on('hook:subagent-start', (data) => {
    const msg = JSON.stringify({ type: 'hook-subagent-start', ...data, timestamp: Date.now() });
    for (const client of clients) client.send(msg);
  });

  daemon.on('hook:subagent-stop', (data) => {
    const msg = JSON.stringify({ type: 'hook-subagent-stop', ...data, timestamp: Date.now() });
    for (const client of clients) client.send(msg);
  });

  daemon.on('hook:plan-proposed', (data) => {
    sendToSessionSubscribers(data.sessionId, {
      type: 'hook-plan-proposed',
      sessionId: data.sessionId,
      adapter: data.adapter,
      title: data.title,
      summary: data.summary,
      body: data.body,
      source: data.source,
      sourceRef: data.sourceRef,
      metadata: data.metadata,
      timestamp: Date.now(),
    });
  });

  const bufferCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, endedAt] of sessionEndTimes) {
      if (now - endedAt < BUFFER_EVICTION_MS) continue;
      const hasSubscribers = [...clients].some((c) => c.subscriptions.has(sessionId));
      if (!hasSubscribers) {
        ringBuffers.delete(sessionId);
        sessionEndTimes.delete(sessionId);
      }
    }
  }, BUFFER_CLEANUP_INTERVAL_MS);

  return () => {
    clearInterval(bufferCleanupInterval);
    log.debug('WS daemon event bridge cleaned up');
  };
}
