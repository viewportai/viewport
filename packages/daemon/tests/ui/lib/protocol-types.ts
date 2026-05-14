/**
 * TypeScript types inferred from Zod schemas.
 *
 * Single source of truth: schemas in protocol.ts -> types here via z.infer<>.
 * Never define these types manually.
 */

import { type z } from 'zod';
import type {
  // Incoming messages
  HelloMessageSchema,
  AckMessageSchema,
  SessionStartedMessageSchema,
  SessionUpdateMessageSchema,
  SessionEndedMessageSchema,
  SessionAlertMessageSchema,
  BranchRetryCreatedMessageSchema,
  SessionListMessageSchema,
  DiscoveredSessionTailMessageSchema,
  DiscoveredSessionsUpdatedMessageSchema,
  DiscoveredSessionWaitingMessageSchema,
  IncomingMessageSchema,
  // Hook event messages
  HookSessionStartMessageSchema,
  HookSessionEndMessageSchema,
  HookPermissionRequestMessageSchema,
  HookNotificationMessageSchema,
  HookToolCompletedMessageSchema,
  HookToolFailedMessageSchema,
  HookStopMessageSchema,
  HookSubagentStartMessageSchema,
  HookSubagentStopMessageSchema,
  // Update payloads
  AgentMessageUpdateSchema,
  AgentMessageChunkUpdateSchema,
  AgentThoughtChunkUpdateSchema,
  UserMessageUpdateSchema,
  ToolCallUpdateSchema,
  ToolCallStatusUpdateSchema,
  ToolCallDetailSchema,
  TokenUsageUpdateSchema,
  SystemStatusUpdateSchema,
  StateChangeUpdateSchema,
  StepCommittedUpdateSchema,
  PermissionRequestUpdateSchema,
  PermissionResolvedUpdateSchema,
  AttentionUpdateSchema,
  StreamingStateUpdateSchema,
  SessionUpdatePayloadSchema,
  // Outgoing messages
  LaunchCommandSchema,
  KillCommandSchema,
  PromptCommandSchema,
  RespondPermissionCommandSchema,
  SubscribeCommandSchema,
  UnsubscribeCommandSchema,
  RollbackCommandSchema,
  BranchRetryCommandSchema,
  SquashMergeCommandSchema,
  ResumeCommandSchema,
  SuperviseCommandSchema,
  RespondHookPermissionCommandSchema,
  OutgoingMessageSchema,
} from './protocol';

// ---------------------------------------------------------------------------
// Incoming message types
// ---------------------------------------------------------------------------

export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type AckMessage = z.infer<typeof AckMessageSchema>;
export type SessionStartedMessage = z.infer<typeof SessionStartedMessageSchema>;
export type SessionUpdateMessage = z.infer<typeof SessionUpdateMessageSchema>;
export type SessionEndedMessage = z.infer<typeof SessionEndedMessageSchema>;
export type SessionAlertMessage = z.infer<typeof SessionAlertMessageSchema>;
export type BranchRetryCreatedMessage = z.infer<typeof BranchRetryCreatedMessageSchema>;
export type SessionListMessage = z.infer<typeof SessionListMessageSchema>;
export type DiscoveredSessionTailMessage = z.infer<typeof DiscoveredSessionTailMessageSchema>;
export type DiscoveredSessionsUpdatedMessage = z.infer<
  typeof DiscoveredSessionsUpdatedMessageSchema
>;
export type DiscoveredSessionWaitingMessage = z.infer<typeof DiscoveredSessionWaitingMessageSchema>;
export type HookSessionStartMessage = z.infer<typeof HookSessionStartMessageSchema>;
export type HookSessionEndMessage = z.infer<typeof HookSessionEndMessageSchema>;
export type HookPermissionRequestMessage = z.infer<typeof HookPermissionRequestMessageSchema>;
export type HookNotificationMessage = z.infer<typeof HookNotificationMessageSchema>;
export type HookToolCompletedMessage = z.infer<typeof HookToolCompletedMessageSchema>;
export type HookToolFailedMessage = z.infer<typeof HookToolFailedMessageSchema>;
export type HookStopMessage = z.infer<typeof HookStopMessageSchema>;
export type HookSubagentStartMessage = z.infer<typeof HookSubagentStartMessageSchema>;
export type HookSubagentStopMessage = z.infer<typeof HookSubagentStopMessageSchema>;
export type IncomingMessage = z.infer<typeof IncomingMessageSchema>;

// ---------------------------------------------------------------------------
// Update payload types
// ---------------------------------------------------------------------------

export type AgentMessageUpdate = z.infer<typeof AgentMessageUpdateSchema>;
export type AgentMessageChunkUpdate = z.infer<typeof AgentMessageChunkUpdateSchema>;
export type AgentThoughtChunkUpdate = z.infer<typeof AgentThoughtChunkUpdateSchema>;
export type UserMessageUpdate = z.infer<typeof UserMessageUpdateSchema>;
export type ToolCallUpdate = z.infer<typeof ToolCallUpdateSchema>;
export type ToolCallDetail = z.infer<typeof ToolCallDetailSchema>;
export type ToolCallStatusUpdate = z.infer<typeof ToolCallStatusUpdateSchema>;
export type TokenUsageUpdate = z.infer<typeof TokenUsageUpdateSchema>;
export type SystemStatusUpdate = z.infer<typeof SystemStatusUpdateSchema>;
export type StateChangeUpdate = z.infer<typeof StateChangeUpdateSchema>;
export type StepCommittedUpdate = z.infer<typeof StepCommittedUpdateSchema>;
export type PermissionRequestUpdate = z.infer<typeof PermissionRequestUpdateSchema>;
export type PermissionResolvedUpdate = z.infer<typeof PermissionResolvedUpdateSchema>;
export type AttentionUpdate = z.infer<typeof AttentionUpdateSchema>;
export type StreamingStateUpdate = z.infer<typeof StreamingStateUpdateSchema>;
export type SessionUpdatePayload = z.infer<typeof SessionUpdatePayloadSchema>;

// ---------------------------------------------------------------------------
// Session state (matches daemon SessionState)
// ---------------------------------------------------------------------------

export type SessionState =
  | 'starting'
  | 'running'
  | 'waiting_permission'
  | 'idle'
  | 'completed'
  | 'errored';

// ---------------------------------------------------------------------------
// Outgoing command types
// ---------------------------------------------------------------------------

export type LaunchCommand = z.infer<typeof LaunchCommandSchema>;
export type KillCommand = z.infer<typeof KillCommandSchema>;
export type PromptCommand = z.infer<typeof PromptCommandSchema>;
export type RespondPermissionCommand = z.infer<typeof RespondPermissionCommandSchema>;
export type SubscribeCommand = z.infer<typeof SubscribeCommandSchema>;
export type UnsubscribeCommand = z.infer<typeof UnsubscribeCommandSchema>;
export type RollbackCommand = z.infer<typeof RollbackCommandSchema>;
export type BranchRetryCommand = z.infer<typeof BranchRetryCommandSchema>;
export type SquashMergeCommand = z.infer<typeof SquashMergeCommandSchema>;
export type ResumeCommand = z.infer<typeof ResumeCommandSchema>;
export type SuperviseCommand = z.infer<typeof SuperviseCommandSchema>;
export type RespondHookPermissionCommand = z.infer<typeof RespondHookPermissionCommandSchema>;
export type OutgoingMessage = z.infer<typeof OutgoingMessageSchema>;

// ---------------------------------------------------------------------------
// Convenience types for stores
// ---------------------------------------------------------------------------

export interface DirectoryInfo {
  id: string;
  path: string;
  name: string;
}

export interface ActiveSessionInfo {
  id: string;
  directoryId: string;
  state: SessionState;
  capabilities?: SessionInteractionCapabilities;
}

export interface MachineInfo {
  id: string;
}

export interface DiscoveredSessionInfo {
  id: string;
  agentId?: string;
  directoryId: string;
  summary: string;
  nativeTitle?: string;
  generatedTitle?: string;
  displayTitle?: string;
  titleSource?: 'native' | 'generated' | 'first_prompt' | 'fallback';
  firstPrompt?: string;
  lastPrompt?: string;
  latestModel?: string;
  approvalPolicy?: string;
  sandboxMode?: string;
  reasoningEffort?: string;
  lastActivity: number;
  messageCount: number;
  resumable: boolean;
  capabilities?: SessionInteractionCapabilities;
  waiting?: boolean;
  waitingToolName?: string;
}

export interface SessionInteractionCapabilities {
  readTranscript: boolean;
  tailTranscript: boolean;
  resume: boolean;
  sendPrompt: boolean;
  interrupt: boolean;
  respondToPermissions: boolean;
  modelOverride: boolean;
}

// ---------------------------------------------------------------------------
// Rich session messages — structured content blocks from JSONL history
// ---------------------------------------------------------------------------

export type RichSessionMessage =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string; ts: string; uuid: string }
  | {
      kind: 'tool_use';
      toolName: string;
      toolId: string;
      input: Record<string, unknown>;
      ts: string;
      uuid: string;
    }
  | {
      kind: 'tool_result';
      toolId: string;
      output: string;
      isError: boolean;
      ts: string;
      uuid: string;
    }
  | {
      kind: 'command';
      command: string;
      cwd?: string;
      status: 'started' | 'completed';
      exitCode?: number | null;
      output?: string;
      durationMs?: number | null;
      ts: string;
      uuid: string;
    }
  | {
      kind: 'file_change';
      path?: string;
      diff?: string;
      operation?: string;
      ts: string;
      uuid: string;
    }
  | {
      kind: 'approval';
      title: string;
      body: string;
      input?: Record<string, unknown>;
      ts: string;
      uuid: string;
    }
  | {
      kind: 'event';
      title: string;
      body: string;
      tone?: 'default' | 'success' | 'warning' | 'danger' | 'muted';
      ts: string;
      uuid: string;
    }
  | {
      kind: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      ts: string;
      uuid: string;
    }
  | { kind: 'thinking'; text: string; ts: string; uuid: string };

// ---------------------------------------------------------------------------
// Model info (from hello message — dynamic model list from SDK)
// ---------------------------------------------------------------------------

export interface ModelInfo {
  /** Model identifier to use in API calls. */
  value: string;
  /** Human-readable display name. */
  displayName: string;
  /** Description of the model's capabilities. */
  description: string;
  /** Whether this model supports effort levels. */
  supportsEffort?: boolean;
  /** Available effort levels. */
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'max')[];
  /** Whether this model supports adaptive thinking. */
  supportsAdaptiveThinking?: boolean;
}

// ---------------------------------------------------------------------------
// Agent info (from hello message — rich agent capabilities)
// ---------------------------------------------------------------------------

export type AgentTier = 'sdk' | 'pty';

export interface AgentCapabilities {
  structuredToolCalls: boolean;
  permissionCallbacks: boolean;
  tokenUsage: boolean;
  resume: boolean;
  extendedThinking: boolean;
}

export interface AgentInfo {
  id: string;
  displayName: string;
  tier: AgentTier;
  available: boolean;
  capabilities: AgentCapabilities;
}
