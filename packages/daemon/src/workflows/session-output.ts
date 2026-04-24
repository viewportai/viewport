import type { SessionMessage } from '../core/types.js';

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
