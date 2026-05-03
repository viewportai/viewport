import type { SessionMessage } from '../core/types.js';
import {
  readRichSessionMessagesFromFile,
  type RichSessionMessage,
} from '../discovery/jsonl-reader.js';
import { readPersistedSessionMessagesRich } from '../server/ring-buffer.js';
import { CodexDiscovery } from '../discovery/codex.js';

export interface TranscriptExcerptMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface SessionOutputCollector {
  push(message: SessionMessage): void;
  text(): string;
}

export function createSessionOutputCollector(): SessionOutputCollector {
  const finalMessages = new Map<string, string>();
  const chunkMessages = new Map<string, string[]>();

  return {
    push(message: SessionMessage): void {
      if (message.type === 'agent_message') {
        finalMessages.set(message.messageId, message.text);
      } else if (message.type === 'agent_message_chunk') {
        const chunks = chunkMessages.get(message.messageId) ?? [];
        chunks.push(message.text);
        chunkMessages.set(message.messageId, chunks);
      }
    },

    text(): string {
      const chunksWithoutFinal = [...chunkMessages.entries()]
        .filter(([messageId]) => !finalMessages.has(messageId))
        .map(([, chunks]) => chunks.join(''));
      return [...chunksWithoutFinal, ...finalMessages.values()].join('').trim();
    },
  };
}

export function outputFromRichMessages(messages: RichSessionMessage[]): string {
  const text: string[] = [];
  for (const message of messages) {
    if (message.kind === 'text' && message.role === 'assistant') {
      text.push(message.text);
    }
  }
  return text.join('\n').trim();
}

export function transcriptExcerptFromRichMessages(
  messages: RichSessionMessage[],
  options: { maxMessages?: number; maxCharsPerMessage?: number } = {},
): TranscriptExcerptMessage[] {
  const maxMessages = options.maxMessages ?? 6;
  const maxCharsPerMessage = options.maxCharsPerMessage ?? 800;

  return messages
    .filter((message): message is Extract<RichSessionMessage, { kind: 'text' }> => {
      return message.kind === 'text' && message.text.trim().length > 0;
    })
    .slice(-maxMessages)
    .map((message) => ({
      role: message.role,
      text:
        message.text.length > maxCharsPerMessage
          ? `${message.text.slice(0, maxCharsPerMessage).trimEnd()}...`
          : message.text,
    }));
}

export function readPersistedSessionOutput(sessionId: string): string {
  return outputFromRichMessages(readPersistedSessionMessagesRich(sessionId));
}

export function readPersistedSessionTranscriptExcerpt(
  sessionId: string,
): TranscriptExcerptMessage[] {
  return transcriptExcerptFromRichMessages(readPersistedSessionMessagesRich(sessionId));
}

export async function readCodexWorktreeSessionOutput(
  worktreePath: string,
  sessionIds: string[] = [],
): Promise<string> {
  const sessions = await new CodexDiscovery().discoverSessions(worktreePath);
  const sourcePath = selectCodexSessionSourcePath(sessions, sessionIds);
  if (!sourcePath) return '';
  return outputFromRichMessages(await readRichSessionMessagesFromFile(sourcePath));
}

export async function readCodexWorktreeSessionTranscriptExcerpt(
  worktreePath: string,
  sessionIds: string[] = [],
): Promise<TranscriptExcerptMessage[]> {
  const sessions = await new CodexDiscovery().discoverSessions(worktreePath);
  const sourcePath = selectCodexSessionSourcePath(sessions, sessionIds);
  if (!sourcePath) return [];
  return transcriptExcerptFromRichMessages(await readRichSessionMessagesFromFile(sourcePath));
}

function selectCodexSessionSourcePath(
  sessions: Awaited<ReturnType<CodexDiscovery['discoverSessions']>>,
  sessionIds: string[],
): string | undefined {
  const ids = new Set(sessionIds.filter(Boolean));
  const match = ids.size > 0 ? sessions.find((session) => ids.has(session.sessionId)) : undefined;
  return match?.sourcePath ?? sessions[0]?.sourcePath;
}
