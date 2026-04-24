import type { SessionMessage } from '../core/types.js';
import {
  readRichSessionMessagesFromFile,
  type RichSessionMessage,
} from '../discovery/jsonl-reader.js';
import { readPersistedSessionMessagesRich } from '../server/ring-buffer.js';
import { CodexDiscovery } from '../discovery/codex.js';

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

export function readPersistedSessionOutput(sessionId: string): string {
  return outputFromRichMessages(readPersistedSessionMessagesRich(sessionId));
}

export async function readCodexWorktreeSessionOutput(worktreePath: string): Promise<string> {
  const sessions = await new CodexDiscovery().discoverSessions(worktreePath);
  const sourcePath = sessions[0]?.sourcePath;
  if (!sourcePath) return '';
  return outputFromRichMessages(await readRichSessionMessagesFromFile(sourcePath));
}
