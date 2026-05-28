import { createHash } from 'node:crypto';
import type { SessionMessage } from '../core/types.js';
import type {
  AgentAdapterDescriptor,
  AgentRunResult,
  AgentRunStopReason,
  AgentRunToolCall,
  AgentRunUsage,
} from '../core/interfaces.js';
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
  agentRunResult(options: {
    agent: AgentAdapterDescriptor;
    model?: string;
    executionMode?: 'plan' | 'read_only' | 'implement' | 'review';
    startedAt: number;
    completedAt: number;
    reason: string;
  }): AgentRunResult;
}

export function createSessionOutputCollector(): SessionOutputCollector {
  const finalMessages = new Map<string, string>();
  const chunkMessages = new Map<string, string[]>();
  const toolCalls = new Map<string, AgentRunToolCall>();
  const usage: AgentRunUsage = {
    available: false,
    reason: 'stream_missing_final_usage',
  };
  const permissionDenials: Array<{ toolName: string; reason: string; timestamp: number }> = [];

  return {
    push(message: SessionMessage): void {
      if (message.type === 'agent_message') {
        finalMessages.set(message.messageId, message.text);
      } else if (message.type === 'agent_message_chunk') {
        const chunks = chunkMessages.get(message.messageId) ?? [];
        chunks.push(message.text);
        chunkMessages.set(message.messageId, chunks);
      } else if (message.type === 'token_usage') {
        usage.available = true;
        delete usage.reason;
        usage.inputTokens = (usage.inputTokens ?? 0) + message.inputTokens;
        usage.inputTokenScope =
          usage.inputTokenScope === 'raw_provider' || message.inputTokenScope === 'raw_provider'
            ? 'raw_provider'
            : 'billable';
        usage.outputTokens = (usage.outputTokens ?? 0) + message.outputTokens;
        usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        if (typeof message.cacheReadInputTokens === 'number') {
          usage.cacheReadInputTokens =
            (usage.cacheReadInputTokens ?? 0) + message.cacheReadInputTokens;
        }
        if (typeof message.cacheCreationInputTokens === 'number') {
          usage.cacheCreationInputTokens =
            (usage.cacheCreationInputTokens ?? 0) + message.cacheCreationInputTokens;
        }
        usage.billableInputTokens =
          typeof message.billableInputTokens === 'number'
            ? (usage.billableInputTokens ?? 0) + message.billableInputTokens
            : message.inputTokenScope === 'raw_provider'
              ? usage.billableInputTokens
              : Math.max(0, (usage.inputTokens ?? 0) - (usage.cacheReadInputTokens ?? 0));
        usage.budgetedTotalTokens =
          typeof message.budgetedTotalTokens === 'number'
            ? (usage.budgetedTotalTokens ?? 0) + message.budgetedTotalTokens
            : message.inputTokenScope === 'raw_provider'
              ? (usage.budgetedTotalTokens ?? 0) + message.outputTokens
              : (usage.billableInputTokens ?? 0) + (usage.outputTokens ?? 0);
        if (typeof message.totalCostUsd === 'number') {
          usage.totalCostUsd = (usage.totalCostUsd ?? 0) + message.totalCostUsd;
        }
        if (typeof message.durationMs === 'number') {
          usage.durationMs = Math.max(usage.durationMs ?? 0, message.durationMs);
        }
        if (typeof message.numTurns === 'number') {
          usage.numTurns = Math.max(usage.numTurns ?? 0, message.numTurns);
        }
        if (message.modelUsage) {
          usage.modelUsage = mergeModelUsage(usage.modelUsage, message.modelUsage);
        }
      } else if (message.type === 'tool_call') {
        toolCalls.set(message.toolCallId, {
          id: message.toolCallId,
          name: message.toolName,
          status: message.status,
          title: message.title,
          startedAt: message.timestamp,
          ...(message.input ? { inputDigest: digestRecord(message.input) } : {}),
        });
      } else if (message.type === 'tool_call_update') {
        const existing = toolCalls.get(message.toolCallId);
        const status = message.status === 'error' ? 'error' : 'completed';
        toolCalls.set(message.toolCallId, {
          id: message.toolCallId,
          name: message.toolName ?? existing?.name ?? 'unknown',
          status,
          title: message.title ?? existing?.title,
          startedAt: existing?.startedAt,
          completedAt: message.timestamp,
          inputDigest: existing?.inputDigest,
        });
        if (status === 'error') {
          permissionDenials.push({
            toolName: message.toolName ?? existing?.name ?? 'unknown',
            reason: message.output ?? 'tool error',
            timestamp: message.timestamp,
          });
        }
      }
    },

    text(): string {
      const chunksWithoutFinal = [...chunkMessages.entries()]
        .filter(([messageId]) => !finalMessages.has(messageId))
        .map(([, chunks]) => chunks.join(''));
      return [...chunksWithoutFinal, ...finalMessages.values()].join('').trim();
    },

    agentRunResult(options): AgentRunResult {
      const output = this.text();
      const executionMode = options.executionMode ?? 'implement';
      const completedAt = new Date(options.completedAt).toISOString();
      const startedAt = new Date(options.startedAt).toISOString();
      return {
        schema: 'viewport.agent_run_result/v1',
        agentId: options.agent.agentId,
        adapterVersion: options.agent.adapterVersion,
        ...(options.model ? { model: options.model } : {}),
        executionMode,
        enforcement: {
          executionMode,
          planMode: options.agent.capabilities.executionModes.plan,
          readOnlyMode: options.agent.capabilities.executionModes.read_only,
          toolAllowlist: options.agent.capabilities.toolAllowlist,
          structuredOutput: options.agent.capabilities.structuredOutput,
          sandbox: 'hard',
        },
        output,
        usage:
          usage.available === true
            ? { ...usage }
            : {
                available: false,
                reason:
                  options.agent.capabilities.usageReporting === 'unavailable'
                    ? 'adapter_no_usage'
                    : 'stream_missing_final_usage',
              },
        toolCalls: [...toolCalls.values()],
        permissionDenials,
        stopReason: normalizeStopReason(options.reason),
        startedAt,
        completedAt,
        durationMs: Math.max(0, options.completedAt - options.startedAt),
      };
    },
  };
}

function normalizeStopReason(reason: string): AgentRunStopReason {
  if (reason === 'idle') return 'idle';
  if (reason === 'completed' || reason === 'ended') return 'completed';
  if (reason === 'timeout') return 'timeout';
  if (reason === 'killed' || reason === 'canceled') return 'canceled';
  if (reason.includes('permission')) return 'tool_denied';
  if (reason.startsWith('error')) return 'error';
  return 'unknown';
}

function mergeModelUsage(
  current: AgentRunUsage['modelUsage'] | undefined,
  next: NonNullable<AgentRunUsage['modelUsage']>,
): NonNullable<AgentRunUsage['modelUsage']> {
  const merged: NonNullable<AgentRunUsage['modelUsage']> = { ...(current ?? {}) };
  for (const [model, value] of Object.entries(next)) {
    const existing = merged[model];
    merged[model] = {
      inputTokens: (existing?.inputTokens ?? 0) + value.inputTokens,
      outputTokens: (existing?.outputTokens ?? 0) + value.outputTokens,
      costUsd: (existing?.costUsd ?? 0) + value.costUsd,
      ...((existing?.cacheReadInputTokens ?? 0) + (value.cacheReadInputTokens ?? 0) > 0
        ? {
            cacheReadInputTokens:
              (existing?.cacheReadInputTokens ?? 0) + (value.cacheReadInputTokens ?? 0),
          }
        : {}),
      ...((existing?.cacheCreationInputTokens ?? 0) + (value.cacheCreationInputTokens ?? 0) > 0
        ? {
            cacheCreationInputTokens:
              (existing?.cacheCreationInputTokens ?? 0) + (value.cacheCreationInputTokens ?? 0),
          }
        : {}),
    };
  }
  return merged;
}

function digestRecord(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
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
