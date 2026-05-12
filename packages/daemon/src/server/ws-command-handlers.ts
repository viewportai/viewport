import type { Daemon } from '../core/daemon.js';
import type { AgentRegistry } from '../core/agent-registry.js';
import type { HookRouter } from '../hooks/router.js';
import type { SupervisionManager } from '../hooks/supervision.js';
import { sendSyncSnapshot, type ConnectedClient } from './hello-builder.js';
import type { RingBuffer } from './ring-buffer.js';
import type { IncomingMessage } from './ws-protocol.js';
import { ErrorCodes } from '../core/error-codes.js';
import { createWsWorkflowCommandHandlers } from './ws-workflow-command-handlers.js';
import { createWsSessionCommandHandlers } from './ws-session-command-handlers.js';
import {
  resolveSessionResourceManifestSync,
  type SessionResourceManifest,
} from '../config-resolution/index.js';

const MAX_CLIENT_SUBSCRIPTIONS = 1024;

export function addBoundedSetEntry(set: Set<string>, value: string, maxEntries: number): void {
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
      const resourceId = msg.resourceId;
      const overrides = {
        ...msg.configOverrides,
        ...(msg.model ? { model: msg.model } : {}),
        ...(resourceId ? { resourceId } : {}),
      };
      const initialPrompt = msg.prompt?.trim() ?? '';
      const sessionId = await daemon.launchSession(
        msg.directoryId,
        initialPrompt,
        Object.keys(overrides).length > 0 ? overrides : undefined,
      );
      addBoundedSetEntry(client.subscriptions, sessionId, MAX_CLIENT_SUBSCRIPTIONS);

      const dir = daemon.directoryManager.get(msg.directoryId);
      client.send(
        JSON.stringify({
          type: 'session-started',
          sessionId,
          directoryId: msg.directoryId,
          agent: overrides.agent ?? 'claude',
          model: overrides.model,
          resourceId,
          cwd: dir?.path,
          resourceManifest: resolveManifest(dir?.path ?? null),
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

    ...createWsSessionCommandHandlers({
      daemon,
      sendAck,
      getOrCreateBuffer,
      addBoundedSetEntry,
    }),

    'sync-request': async (client, msg) => {
      sendSyncSnapshot(client, daemon, registry);
      sendAck(client, msg.requestId, 'ok');
    },

    ...createWsWorkflowCommandHandlers({ daemon, sendAck }),

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

    'get-hook-plan-draft': async (client, msg) => {
      const draft = daemon.getEphemeralPlanDraft(msg.draftId);
      if (!draft) {
        sendAck(client, msg.requestId, 'error', 'Plan draft not found', {
          errorCode: ErrorCodes.INVALID_INPUT,
        });
        return;
      }

      client.send(
        JSON.stringify({
          type: 'hook-plan-draft',
          draftId: draft.draftId,
          schema: draft.schema,
          workspaceId: draft.workspaceId,
          title: draft.title,
          summary: draft.summary,
          body: draft.body,
          source: draft.source,
          sourceRef: draft.sourceRef,
          sessionId: draft.sessionId,
          hookRequestId: draft.hookRequestId,
          metadata: draft.metadata,
          createdAt: draft.createdAt,
          expiresAt: draft.expiresAt,
          timestamp: Date.now(),
        }),
      );
      sendAck(client, msg.requestId, 'ok');
    },
  };
}

function resolveManifest(workingDirectory: string | null | undefined): SessionResourceManifest {
  return resolveSessionResourceManifestSync({
    workingDirectory: workingDirectory ?? process.cwd(),
  });
}
