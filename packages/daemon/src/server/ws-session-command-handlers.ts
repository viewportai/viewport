import type { Daemon } from '../core/daemon.js';
import { ErrorCodes } from '../core/error-codes.js';
import { ViewportError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import {
  resolveSessionResourceManifestSync,
  type SessionResourceManifest,
} from '../config-resolution/index.js';
import type { RichSessionMessage } from '../discovery/jsonl-reader.js';
import {
  createGitMetadataResolver,
  type GitRepositoryMetadata,
} from '../session-enrichment/git.js';
import { discoveredWatchKey, removeDiscoveredWatch } from './discovered-watch-key.js';
import type { ConnectedClient } from './hello-builder.js';
import type { RingBuffer } from './ring-buffer.js';
import {
  parseSessionMessageLimit,
  parseSessionMessageOffset,
  readDaemonSessionMessagePage,
} from './session-message-reader.js';
import type { AckSender } from './ws-command-handlers.js';
import type { IncomingMessage } from './ws-protocol.js';

const MAX_CLIENT_SUBSCRIPTIONS = 1024;
const MAX_CLIENT_DISCOVERED_WATCHES = 2048;
// Relay E2EE wraps the ack JSON into a base64 ciphertext envelope. Keep the plaintext
// well below the 1 MiB relay frame limit so large transcripts truncate instead of
// timing out after the relay drops an oversized encrypted frame.
export const SESSION_MESSAGES_ACK_PLAINTEXT_LIMIT_BYTES = 512_000;
const MAX_SESSION_MESSAGE_FIELD_BYTES = 96_000;
const log = logger.child({ module: 'ws-session-command-handlers' });

type IncomingByType<T extends IncomingMessage['type']> = Extract<IncomingMessage, { type: T }>;

type SessionCommandHandlerMap = {
  [K in Extract<
    IncomingMessage['type'],
    | 'list-sessions'
    | 'read-session-messages'
    | 'resume'
    | 'watch-discovered-session'
    | 'unwatch-discovered-session'
  >]: (client: ConnectedClient, msg: IncomingByType<K>) => Promise<void>;
};

interface SessionListSource {
  sessionId: string;
  agentId: string;
  summary: string;
  lastModified: number;
  messageCount?: number;
  resumable: boolean;
  cwd?: string;
  worktreePath?: string;
}

interface SessionCommandContext {
  daemon: Daemon;
  sendAck: AckSender;
  getOrCreateBuffer: (sessionId: string) => RingBuffer;
  addBoundedSetEntry: (set: Set<string>, value: string, maxEntries: number) => void;
}

export function createWsSessionCommandHandlers(
  ctx: SessionCommandContext,
): SessionCommandHandlerMap {
  const { daemon, sendAck, getOrCreateBuffer, addBoundedSetEntry } = ctx;

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
    'list-sessions': async (client, msg) => {
      const discovered = daemon.getDiscoveredSessions(msg.directoryId);
      const sessions = discovered.get(msg.directoryId) ?? [];
      const offset = Math.max(0, msg.offset ?? 0);
      const limit = Math.min(200, Math.max(1, msg.limit ?? 50));
      const sliced = sessions.slice(offset, offset + limit);
      const dir = daemon.directoryManager?.get?.(msg.directoryId);
      const workingDirectoryFallback = dir?.path ?? null;
      const gitMetadataFor = createGitMetadataResolver();

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
          offset,
          limit,
          sessions: sliced.map((session) => ({
            ...toSessionListEntry(
              session,
              msg.directoryId,
              session.cwd ?? session.worktreePath ?? workingDirectoryFallback,
              gitMetadataFor,
            ),
          })),
          total: sessions.length,
          hasMore: offset + limit < sessions.length,
        }),
      );
      sendAck(client, msg.requestId, 'ok');
    },

    'read-session-messages': async (client, msg) => {
      try {
        const startedAt = Date.now();
        log.debug(
          {
            directoryId: msg.directoryId,
            sessionId: msg.sessionId,
            limit: msg.limit,
            offset: msg.offset,
          },
          'Reading discovered session messages',
        );
        const page = await readDaemonSessionMessagePage(daemon, msg.directoryId, msg.sessionId, {
          limit: parseSessionMessageLimit(msg.limit),
          offset: parseSessionMessageOffset(msg.offset),
        });
        const fit = fitMessagesForAck(page.messages);
        log.debug(
          {
            directoryId: msg.directoryId,
            sessionId: msg.sessionId,
            returned: fit.messages.length,
            originalReturned: page.messages.length,
            truncated: fit.truncated,
            hasMoreBefore: page.hasMoreBefore,
            nextOffset: page.nextOffset,
            durationMs: Date.now() - startedAt,
          },
          'Read discovered session messages',
        );
        if (msg.delivery === 'event-stream' && msg.requestId) {
          client.send(
            JSON.stringify({
              type: 'session-messages-page',
              requestId: msg.requestId,
              directoryId: msg.directoryId,
              sessionId: msg.sessionId,
              ...fit,
              hasMoreBefore: page.hasMoreBefore || fit.droppedCount > 0,
              nextOffset: parseSessionMessageOffset(msg.offset) + fit.messages.length,
              final: true,
            }),
          );
          sendAck(client, msg.requestId, 'ok', undefined, {
            originalReturned: fit.originalReturned,
            droppedCount: fit.droppedCount,
            truncated: fit.truncated,
            hasMoreBefore: page.hasMoreBefore || fit.droppedCount > 0,
            nextOffset: parseSessionMessageOffset(msg.offset) + fit.messages.length,
            streamed: true,
          });
          return;
        }
        sendAck(client, msg.requestId, 'ok', undefined, {
          ...fit,
          hasMoreBefore: page.hasMoreBefore || fit.droppedCount > 0,
          nextOffset: parseSessionMessageOffset(msg.offset) + fit.messages.length,
        });
      } catch (error) {
        const viewportError =
          error instanceof ViewportError
            ? error
            : new ViewportError(
                ErrorCodes.INTERNAL_ERROR,
                error instanceof Error ? error.message : 'Session messages not found',
              );
        sendAck(client, msg.requestId, 'error', viewportError.message, {
          errorCode: viewportError.code,
        });
      }
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
      const discoveredMatch = discoveredList.find((session) => session.sessionId === msg.sessionId);
      if (!discoveredMatch) {
        sendAck(client, msg.requestId, 'error', `Discovered session not found: ${msg.sessionId}`, {
          errorCode: ErrorCodes.DISCOVERED_SESSION_NOT_FOUND,
        });
        return;
      }

      const resourceId = msg.resourceId;
      const overrides = {
        ...(msg.model ? { model: msg.model } : {}),
        ...(resourceId ? { resourceId } : {}),
        agent: discoveredMatch.agentId,
      };
      const initialPrompt = msg.prompt?.trim() ?? '';
      const resumeSessionId = await daemon.resumeSession(
        msg.sessionId,
        msg.directoryId,
        initialPrompt,
        overrides,
      );
      addBoundedSetEntry(client.subscriptions, resumeSessionId, MAX_CLIENT_SUBSCRIPTIONS);
      client.send(
        JSON.stringify({
          type: 'session-started',
          sessionId: resumeSessionId,
          directoryId: msg.directoryId,
          cwd: resumeDir.path,
          agent: discoveredMatch.agentId,
          resourceId,
          summary: discoveredMatch.summary,
          resourceManifest: resolveManifest(resumeDir.path),
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
  };
}

interface FitMessagesForAckResult {
  messages: RichSessionMessage[];
  originalReturned: number;
  droppedCount: number;
  truncated: boolean;
}

export function fitMessagesForAck(messages: RichSessionMessage[]): FitMessagesForAckResult {
  let safe = messages;
  while (safe.length > 1 && !fitsAckPayload(safe)) {
    safe = safe.slice(Math.max(1, Math.floor(safe.length / 2)));
  }
  const trimmed = fitsAckPayload(safe) ? safe : safe.map((message) => trimLargeMessage(message));
  const droppedCount = messages.length - trimmed.length;
  const fieldTrimmed = trimmed.some(
    (message, index) => safe[index] && JSON.stringify(message) !== JSON.stringify(safe[index]),
  );
  return {
    messages: trimmed,
    originalReturned: messages.length,
    droppedCount,
    truncated: droppedCount > 0 || fieldTrimmed,
  };
}

function fitsAckPayload(messages: RichSessionMessage[]): boolean {
  return (
    Buffer.byteLength(
      JSON.stringify({
        type: 'ack',
        requestId: 'size-check',
        status: 'ok',
        messages,
        originalReturned: messages.length,
        droppedCount: 0,
        truncated: false,
      }),
    ) <= SESSION_MESSAGES_ACK_PLAINTEXT_LIMIT_BYTES
  );
}

function trimLargeMessage(message: RichSessionMessage): RichSessionMessage {
  if (message.kind === 'text') {
    return { ...message, text: trimString(message.text) };
  }
  if (message.kind === 'thinking') {
    return { ...message, text: trimString(message.text) };
  }
  if (message.kind === 'tool_result') {
    return { ...message, output: trimString(message.output) };
  }
  return {
    ...message,
    input: trimLargeInput(message.input),
  };
}

function trimLargeInput(input: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded) <= MAX_SESSION_MESSAGE_FIELD_BYTES) return input;
  return {
    __viewport_truncated: true,
    preview: trimString(encoded),
  };
}

function trimString(value: string): string {
  if (Buffer.byteLength(value) <= MAX_SESSION_MESSAGE_FIELD_BYTES) return value;
  return `${value.slice(0, MAX_SESSION_MESSAGE_FIELD_BYTES)}\n\n[Viewport truncated this field for transport safety.]`;
}

function toSessionListEntry(
  session: SessionListSource,
  directoryId: string,
  workingDirectory: string | null,
  gitMetadataFor: (directoryPath?: string | null) => GitRepositoryMetadata,
): Record<string, unknown> {
  const git = gitMetadataFor(workingDirectory);
  return {
    id: session.sessionId,
    agentId: session.agentId,
    directoryId,
    summary: session.summary,
    lastActivity: session.lastModified,
    messageCount: session.messageCount ?? 0,
    resumable: session.resumable,
    workingDirectory,
    repoRoot: git.repoRoot,
    repoRemoteUrl: git.repoRemoteUrl,
    repoBranch: git.repoBranch,
    repoSha: git.repoSha,
    resourceManifest: resolveManifest(workingDirectory),
  };
}

function resolveManifest(workingDirectory: string | null | undefined): SessionResourceManifest {
  return resolveSessionResourceManifestSync({
    workingDirectory: workingDirectory ?? process.cwd(),
  });
}
