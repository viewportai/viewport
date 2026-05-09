import {
  encodeProjectDir,
  pageFromTailMessages,
  readRichSessionMessagesTailPageFromFile,
  readRichSessionMessagesTailFromFile,
  readSessionMessagesRich,
  type RichSessionTailPage,
} from '../discovery/jsonl-reader.js';
import {
  readCodexSessionMessagesPageRich,
  readCodexSessionMessagesRich,
} from '../discovery/codex.js';
import type { Daemon } from '../core/daemon.js';
import { ErrorCodes } from '../core/error-codes.js';
import { ViewportError } from '../core/errors.js';
import { readPersistedReplayMeta, readPersistedSessionMessagesRich } from './ring-buffer.js';

export const DEFAULT_SESSION_MESSAGE_LIMIT = 100;
export const MAX_SESSION_MESSAGE_LIMIT = 2_000;

export function parseSessionMessageLimit(value: string | number | undefined): number {
  if (value === undefined) return DEFAULT_SESSION_MESSAGE_LIMIT;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SESSION_MESSAGE_LIMIT;
  return Math.min(MAX_SESSION_MESSAGE_LIMIT, Math.floor(parsed));
}

export function parseSessionMessageOffset(value: string | number | undefined): number {
  if (value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export function limitSessionMessages<T>(messages: T[], limit: number | undefined): T[] {
  if (!limit || messages.length <= limit) return messages;
  return messages.slice(-limit);
}

export async function readDaemonSessionMessages(
  daemon: Daemon,
  directoryId: string,
  sessionId: string,
  options: { limit?: number } = {},
): Promise<unknown[]> {
  const dir = daemon.directoryManager.get(directoryId);
  if (!dir) {
    throw new ViewportError(ErrorCodes.DIRECTORY_NOT_FOUND, `Directory not found: ${directoryId}`);
  }

  const discovered = daemon.getDiscoveredSessions(directoryId).get(directoryId) ?? [];
  const discoveredSession = discovered.find((session) => session.sessionId === sessionId);
  const activeHistoryMeta = readPersistedReplayMeta(sessionId);
  if (activeHistoryMeta?.directoryId === directoryId) {
    const messages = readPersistedSessionMessagesRich(sessionId);
    if (messages.length > 0 || !discoveredSession) {
      return limitSessionMessages(messages, options.limit);
    }
  }

  if (!discoveredSession) {
    throw new ViewportError(
      ErrorCodes.DISCOVERED_SESSION_NOT_FOUND,
      `Discovered session not found: ${sessionId}`,
    );
  }

  try {
    if (discoveredSession.agentId === 'codex') {
      const messages = await readCodexSessionMessagesRich(sessionId, discoveredSession.sourcePath, {
        limit: options.limit,
      });
      return limitSessionMessages(messages, options.limit);
    }

    const projectDirName = encodeProjectDir(dir.path);
    if (options.limit && options.limit > 0) {
      const filePath = discoveredSession.sourcePath;
      if (filePath) {
        const messages = await readRichSessionMessagesTailFromFile(filePath, options.limit);
        return limitSessionMessages(messages, options.limit);
      }
    }
    const messages = await readSessionMessagesRich(projectDirName, sessionId);
    return limitSessionMessages(messages, options.limit);
  } catch (error) {
    if (error instanceof ViewportError) throw error;
    const message = error instanceof Error ? error.message : 'Failed to read session messages';
    throw new ViewportError(ErrorCodes.INTERNAL_ERROR, message);
  }
}

export async function readDaemonSessionMessagePage(
  daemon: Daemon,
  directoryId: string,
  sessionId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<RichSessionTailPage> {
  const limit = parseSessionMessageLimit(options.limit);
  const offset = parseSessionMessageOffset(options.offset);
  const dir = daemon.directoryManager.get(directoryId);
  if (!dir) {
    throw new ViewportError(ErrorCodes.DIRECTORY_NOT_FOUND, `Directory not found: ${directoryId}`);
  }

  const discovered = daemon.getDiscoveredSessions(directoryId).get(directoryId) ?? [];
  const discoveredSession = discovered.find((session) => session.sessionId === sessionId);
  const activeHistoryMeta = readPersistedReplayMeta(sessionId);
  if (activeHistoryMeta?.directoryId === directoryId) {
    const messages = readPersistedSessionMessagesRich(sessionId);
    if (messages.length > 0 || !discoveredSession) {
      return pageFromTailMessages(messages, limit, offset);
    }
  }

  if (!discoveredSession) {
    throw new ViewportError(
      ErrorCodes.DISCOVERED_SESSION_NOT_FOUND,
      `Discovered session not found: ${sessionId}`,
    );
  }

  try {
    if (discoveredSession.agentId === 'codex') {
      return readCodexSessionMessagesPageRich(sessionId, discoveredSession.sourcePath, {
        limit,
        offset,
      });
    }

    if (discoveredSession.sourcePath) {
      return readRichSessionMessagesTailPageFromFile(discoveredSession.sourcePath, limit, offset);
    }

    const projectDirName = encodeProjectDir(dir.path);
    const messages = await readSessionMessagesRich(projectDirName, sessionId);
    return pageFromTailMessages(messages, limit, offset);
  } catch (error) {
    if (error instanceof ViewportError) throw error;
    const message = error instanceof Error ? error.message : 'Failed to read session messages';
    throw new ViewportError(ErrorCodes.INTERNAL_ERROR, message);
  }
}
