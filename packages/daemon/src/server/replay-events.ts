import type { RichSessionMessage } from '../discovery/jsonl-reader.js';
import type { SessionUpdateEntry } from './replay-types.js';

export function richMessagesFromUpdates(entries: SessionUpdateEntry[]): RichSessionMessage[] {
  const blocks: RichSessionMessage[] = [];

  for (const entry of entries) {
    const updateType =
      typeof entry.update['updateType'] === 'string' ? entry.update['updateType'] : '';
    const timestamp = updateTimestamp(entry.update);
    const uuid = `replay-${entry.seq}`;

    switch (updateType) {
      case 'user-message':
        if (
          typeof entry.update['text'] === 'string' &&
          typeof entry.update['messageId'] === 'string'
        ) {
          blocks.push({
            kind: 'text',
            role: 'user',
            text: entry.update['text'],
            ts: timestamp,
            uuid: entry.update['messageId'],
          });
        }
        break;
      case 'agent-message':
        if (
          typeof entry.update['text'] === 'string' &&
          typeof entry.update['messageId'] === 'string'
        ) {
          blocks.push({
            kind: 'text',
            role: 'assistant',
            text: entry.update['text'],
            ts: timestamp,
            uuid: entry.update['messageId'],
          });
        }
        break;
      case 'tool-call':
        if (
          typeof entry.update['toolCallId'] === 'string' &&
          typeof entry.update['toolName'] === 'string'
        ) {
          blocks.push({
            kind: 'tool_use',
            toolId: entry.update['toolCallId'],
            toolName: entry.update['toolName'],
            input:
              typeof entry.update['input'] === 'object' && entry.update['input'] !== null
                ? (entry.update['input'] as Record<string, unknown>)
                : {},
            ts: timestamp,
            uuid,
          });
        }
        break;
      case 'tool-call-update':
        if (typeof entry.update['toolCallId'] === 'string') {
          blocks.push({
            kind: 'tool_result',
            toolId: entry.update['toolCallId'],
            output: typeof entry.update['output'] === 'string' ? entry.update['output'] : '',
            isError: entry.update['status'] === 'error',
            ts: timestamp,
            uuid,
          });
        }
        break;
      default:
        break;
    }
  }

  return blocks;
}

export function entryHasTimestamp(entry: SessionUpdateEntry, cutoff: number): boolean {
  const timestamp = entry.update['timestamp'];
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return false;
  }
  return timestamp >= cutoff;
}

export function isDurableUpdate(update: Record<string, unknown>): boolean {
  const updateType = update['updateType'];
  if (typeof updateType !== 'string') {
    return false;
  }
  const timestamp = update['timestamp'];
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return false;
  }

  switch (updateType) {
    case 'agent-message':
    case 'user-message':
    case 'tool-call':
    case 'tool-call-update':
    case 'token-usage':
    case 'state-change':
    case 'step-committed':
    case 'step-rollback':
    case 'step-branch-retry':
    case 'step-squash-merged':
    case 'permission-request':
    case 'permission-resolved':
    case 'attention':
      return true;
    default:
      return false;
  }
}

function updateTimestamp(update: Record<string, unknown>): string {
  const timestamp = typeof update['timestamp'] === 'number' ? update['timestamp'] : Date.now();
  return new Date(timestamp).toISOString();
}
