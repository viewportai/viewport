import type { Daemon } from '../core/daemon.js';
import type { AgentRegistry } from '../core/agent-registry.js';
import type { HookRouter } from '../hooks/router.js';
import type { SupervisionManager } from '../hooks/supervision.js';
import { sendSyncSnapshot, type ConnectedClient } from './hello-builder.js';
import type { RingBuffer } from './ring-buffer.js';
import type { IncomingMessage } from './ws-protocol.js';
import { discoveredWatchKey, removeDiscoveredWatch } from './discovered-watch-key.js';
import { ErrorCodes } from '../core/error-codes.js';
import { logger } from '../core/logger.js';

const MAX_CLIENT_SUBSCRIPTIONS = 1024;
const MAX_CLIENT_DISCOVERED_WATCHES = 2048;
const log = logger.child({ module: 'ws-command-handlers' });

function addBoundedSetEntry(set: Set<string>, value: string, maxEntries: number): void {
  if (set.has(value)) return;
  while (set.size >= maxEntries) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
  set.add(value);
}

type IncomingByType<T extends IncomingMessage['type']> = Extract<IncomingMessage, { type: T }>;

export interface AckSender {
  (
    client: ConnectedClient,
    requestId: string | undefined,
    status: 'ok' | 'error',
    error?: string,
    extra?: Record<string, unknown>,
  ): void;
}

interface HandlerContext {
  daemon: Daemon;
  registry?: AgentRegistry;
  hookRouter?: HookRouter;
  supervision?: SupervisionManager;
  sendAck: AckSender;
  getOrCreateBuffer: (sessionId: string) => RingBuffer;
}

type HandlerMap = {
  [K in IncomingMessage['type']]: (
    client: ConnectedClient,
    msg: IncomingByType<K>,
  ) => Promise<void>;
};

export function createWsCommandHandlers(ctx: HandlerContext): HandlerMap {
  const { daemon, registry, hookRouter, supervision, sendAck, getOrCreateBuffer } = ctx;

  function sendBufferedReplay(client: ConnectedClient, sessionId: string): void {
    const replay = getOrCreateBuffer(sessionId).getAll();
    for (const entry of replay) {
      client.send(
        JSON.stringify({
          type: 'session-update',
          sessionId: entry.sessionId,
          seq: entry.seq,
          update: entry.update,
        }),
      );
    }
  }

  return {
    launch: async (client, msg) => {
      const overrides = {
        ...msg.configOverrides,
        ...(msg.model ? { model: msg.model } : {}),
      };
      const initialPrompt = msg.prompt?.trim() ?? '';
      const sessionId = await daemon.launchSession(
        msg.directoryId,
        '',
        Object.keys(overrides).length > 0 ? overrides : undefined,
      );
      if (initialPrompt.length > 0) {
        await daemon.sendPrompt(sessionId, initialPrompt);
      }
      addBoundedSetEntry(client.subscriptions, sessionId, MAX_CLIENT_SUBSCRIPTIONS);

      const dir = daemon.directoryManager.get(msg.directoryId);
      client.send(
        JSON.stringify({
          type: 'session-started',
          sessionId,
          directoryId: msg.directoryId,
          agent: overrides.agent ?? 'claude',
          model: overrides.model,
          cwd: dir?.path,
        }),
      );
      sendBufferedReplay(client, sessionId);
      sendAck(client, msg.requestId, 'ok');
    },

    kill: async (client, msg) => {
      await daemon.killSession(msg.sessionId);
      sendAck(client, msg.requestId, 'ok');
    },

    prompt: async (client, msg) => {
      const text = msg.text.trim();
      if (text.length === 0) {
        sendAck(client, msg.requestId, 'error', 'Prompt text must be non-empty', {
          errorCode: ErrorCodes.EMPTY_PROMPT,
        });
        return;
      }
      await daemon.sendPrompt(msg.sessionId, text);
      sendAck(client, msg.requestId, 'ok');
    },

    'respond-permission': async (client, msg) => {
      if (msg.decision.behavior === 'allow-always') {
        const toolName = daemon.getRequestToolName(msg.permissionRequestId);
        if (toolName) {
          daemon.addAutoApprove(msg.sessionId, toolName);
        }
      }

      const behavior = msg.decision.behavior === 'allow-always' ? 'allow' : msg.decision.behavior;
      if (behavior === 'allow') {
        await daemon.respondPermission(msg.sessionId, msg.permissionRequestId, {
          behavior: 'allow',
        });
      } else {
        await daemon.respondPermission(msg.sessionId, msg.permissionRequestId, {
          behavior: 'deny',
          message: msg.decision.message,
        });
      }
      sendAck(client, msg.requestId, 'ok');
    },

    subscribe: async (client, msg) => {
      addBoundedSetEntry(client.subscriptions, msg.sessionId, MAX_CLIENT_SUBSCRIPTIONS);
      const buffer = getOrCreateBuffer(msg.sessionId);
      const replayWindow = buffer.getReplayWindow(msg.lastSeq ?? 0);

      for (const entry of replayWindow.entries) {
        client.send(
          JSON.stringify({
            type: 'session-update',
            sessionId: entry.sessionId,
            seq: entry.seq,
            update: entry.update,
          }),
        );
      }

      sendAck(client, msg.requestId, 'ok', undefined, {
        lastSeq: replayWindow.latestAvailableSeq,
        replayCount: replayWindow.entries.length,
        droppedWindow: replayWindow.droppedWindow,
        requestedLastSeq: replayWindow.requestedLastSeq,
        earliestAvailableSeq: replayWindow.earliestAvailableSeq,
        latestAvailableSeq: replayWindow.latestAvailableSeq,
      });
    },

    unsubscribe: async (client, msg) => {
      client.subscriptions.delete(msg.sessionId);
      sendAck(client, msg.requestId, 'ok');
    },

    rollback: async (client, msg) => {
      await daemon.rollback(msg.sessionId, msg.toSha);
      sendAck(client, msg.requestId, 'ok');
    },

    'branch-retry': async (client, msg) => {
      const retryPath = await daemon.branchRetry(msg.sessionId, msg.fromSha);
      sendAck(client, msg.requestId, 'ok', undefined, { retryPath });
    },

    'squash-merge': async (client, msg) => {
      await daemon.squashMerge(msg.sessionId, msg.targetBranch, msg.commitMessage);
      sendAck(client, msg.requestId, 'ok');
    },

    'list-sessions': async (client, msg) => {
      const discovered = daemon.getDiscoveredSessions(msg.directoryId);
      const sessions = discovered.get(msg.directoryId) ?? [];
      const offset = Math.max(0, msg.offset ?? 0);
      const limit = Math.min(200, Math.max(1, msg.limit ?? 50));
      const sliced = sessions.slice(offset, offset + limit);

      log.debug(
        {
          directoryId: msg.directoryId,
          total: sessions.length,
          offset,
          limit,
          returned: sliced.length,
        },
        'Listing discovered sessions',
      );

      client.send(
        JSON.stringify({
          type: 'session-list',
          directoryId: msg.directoryId,
          sessions: sliced.map((s) => ({
            id: s.sessionId,
            agentId: s.agentId,
            summary: s.summary,
            lastActivity: s.lastModified,
            messageCount: s.messageCount ?? 0,
            resumable: s.resumable,
          })),
          total: sessions.length,
          hasMore: offset + limit < sessions.length,
        }),
      );
      sendAck(client, msg.requestId, 'ok');
    },

    resume: async (client, msg) => {
      const resumeDir = daemon.directoryManager.get(msg.directoryId);
      if (!resumeDir) {
        sendAck(client, msg.requestId, 'error', `Directory not found: ${msg.directoryId}`, {
          errorCode: ErrorCodes.DIRECTORY_NOT_FOUND,
        });
        return;
      }

      const discovered = daemon.getDiscoveredSessions(msg.directoryId);
      const discoveredList = discovered.get(msg.directoryId) ?? [];
      const discoveredMatch = discoveredList.find((s) => s.sessionId === msg.sessionId);
      if (!discoveredMatch) {
        sendAck(client, msg.requestId, 'error', `Discovered session not found: ${msg.sessionId}`, {
          errorCode: ErrorCodes.DISCOVERED_SESSION_NOT_FOUND,
        });
        return;
      }
      const overrides = {
        ...(msg.model ? { model: msg.model } : {}),
        agent: discoveredMatch.agentId,
      };
      const initialPrompt = msg.prompt?.trim() ?? '';
      const resumeSessionId = await daemon.resumeSession(
        msg.sessionId,
        msg.directoryId,
        undefined,
        overrides,
      );
      if (initialPrompt.length > 0) {
        await daemon.sendPrompt(resumeSessionId, initialPrompt);
      }
      addBoundedSetEntry(client.subscriptions, resumeSessionId, MAX_CLIENT_SUBSCRIPTIONS);
      client.send(
        JSON.stringify({
          type: 'session-started',
          sessionId: resumeSessionId,
          directoryId: msg.directoryId,
          cwd: resumeDir.path,
          agent: discoveredMatch.agentId,
          summary: discoveredMatch?.summary,
        }),
      );
      sendBufferedReplay(client, resumeSessionId);
      sendAck(client, msg.requestId, 'ok');
    },

    'watch-discovered-session': async (client, msg) => {
      addBoundedSetEntry(
        client.watchedDiscoveredSessions,
        discoveredWatchKey(msg.sessionId, msg.directoryId),
        MAX_CLIENT_DISCOVERED_WATCHES,
      );
      sendAck(client, msg.requestId, 'ok');
    },

    'unwatch-discovered-session': async (client, msg) => {
      removeDiscoveredWatch(client.watchedDiscoveredSessions, msg.sessionId, msg.directoryId);
      sendAck(client, msg.requestId, 'ok');
    },

    'sync-request': async (client, msg) => {
      sendSyncSnapshot(client, daemon, registry);
      sendAck(client, msg.requestId, 'ok');
    },

    'workflow-run': async (client, msg) => {
      const run = await daemon.workflowRunner.startRun({
        workflowPath: msg.workflowPath,
        workflowYaml: msg.workflowYaml,
        workflowSourceRef: msg.workflowSourceRef,
        directoryId: msg.directoryId,
        inputs: msg.inputs,
        projectId: msg.projectId,
        projectMachineBindingId: msg.projectMachineBindingId,
        platformRunId: msg.platformRunId,
        executionPolicy: msg.executionPolicy,
        initiation: 'browser',
      });
      client.send(JSON.stringify({ type: 'workflow-run-started', run }));
      sendAck(client, msg.requestId, 'ok', undefined, { runId: run.id });
    },

    'workflow-list-runs': async (client, msg) => {
      const runs = await daemon.workflowRunner.listRuns(msg.limit);
      client.send(JSON.stringify({ type: 'workflow-runs', runs }));
      sendAck(client, msg.requestId, 'ok');
    },

    'workflow-show-run': async (client, msg) => {
      const run = await daemon.workflowRunner.getRun(msg.runId);
      if (!run) {
        sendAck(client, msg.requestId, 'error', `Workflow run not found: ${msg.runId}`, {
          errorCode: ErrorCodes.INVALID_INPUT,
        });
        return;
      }
      client.send(JSON.stringify({ type: 'workflow-run-detail', run }));
      sendAck(client, msg.requestId, 'ok');
    },

    'workflow-approve': async (client, msg) => {
      try {
        const run = await daemon.workflowRunner.decideApproval(msg.runId, msg.nodeId, {
          approved: msg.approved,
          ...(msg.message ? { message: msg.message } : {}),
        });
        client.send(JSON.stringify({ type: 'workflow-run-detail', run }));
        sendAck(client, msg.requestId, 'ok', undefined, { runId: run.id, nodeId: msg.nodeId });
      } catch (error) {
        sendAck(
          client,
          msg.requestId,
          'error',
          error instanceof Error ? error.message : 'Failed to resolve workflow approval',
          { errorCode: ErrorCodes.INVALID_INPUT },
        );
      }
    },

    supervise: async (client, msg) => {
      if (!supervision) {
        sendAck(client, msg.requestId, 'error', 'Hooks not enabled', {
          errorCode: ErrorCodes.INVALID_INPUT,
        });
        return;
      }
      if (msg.active) {
        supervision.supervise(msg.sessionId, client);
      } else {
        supervision.unsupervise(msg.sessionId, client);
      }
      sendAck(client, msg.requestId, 'ok', undefined, {
        supervised: msg.active,
        sessionId: msg.sessionId,
      });
    },

    'respond-hook-permission': async (client, msg) => {
      if (!hookRouter) {
        sendAck(client, msg.requestId, 'error', 'Hooks not enabled', {
          errorCode: ErrorCodes.INVALID_INPUT,
        });
        return;
      }
      const resolved = hookRouter.resolvePermission(msg.hookRequestId, msg.decision);
      if (!resolved) {
        sendAck(client, msg.requestId, 'error', 'No pending permission request found', {
          errorCode: ErrorCodes.HOOK_REQUEST_NOT_FOUND,
        });
        return;
      }
      sendAck(client, msg.requestId, 'ok');
    },
  };
}
