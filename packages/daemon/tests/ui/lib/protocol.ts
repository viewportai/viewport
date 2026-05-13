/**
 * Zod schemas for the Viewport WebSocket wire protocol.
 *
 * These schemas mirror the daemon's ws-server.ts exactly. Every incoming
 * message is validated through these before reaching stores. Every outgoing
 * message is constructed to match the daemon's IncomingMessageSchema.
 *
 * Types are inferred from schemas via z.infer<> in protocol-types.ts.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const TimestampSchema = z.number();
const MessageIdSchema = z.string();
const ToolCallIdSchema = z.string();
const ShaSchema = z.string().regex(/^[a-f0-9]{7,40}$/);

// ---------------------------------------------------------------------------
// Session update types (daemon -> client, inside session-update.update)
// ---------------------------------------------------------------------------

export const AgentMessageUpdateSchema = z.object({
  updateType: z.literal('agent-message'),
  messageId: MessageIdSchema,
  text: z.string(),
  timestamp: TimestampSchema,
});

export const AgentMessageChunkUpdateSchema = z.object({
  updateType: z.literal('agent-message-chunk'),
  messageId: MessageIdSchema,
  text: z.string(),
  timestamp: TimestampSchema,
});

export const AgentThoughtChunkUpdateSchema = z.object({
  updateType: z.literal('agent-thought-chunk'),
  messageId: MessageIdSchema,
  text: z.string(),
  timestamp: TimestampSchema,
});

export const UserMessageUpdateSchema = z.object({
  updateType: z.literal('user-message'),
  messageId: MessageIdSchema,
  text: z.string(),
  timestamp: TimestampSchema,
});

// Typed tool call details — discriminated union matching daemon's ToolCallDetail
export const ToolCallDetailSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('shell'),
    command: z.string(),
    cwd: z.string().optional(),
    output: z.string().optional(),
    exitCode: z.number().optional(),
    timeout: z.number().optional(),
  }),
  z.object({
    kind: z.literal('read'),
    filePath: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
    output: z.string().optional(),
  }),
  z.object({
    kind: z.literal('edit'),
    filePath: z.string(),
    oldString: z.string().optional(),
    newString: z.string().optional(),
    replaceAll: z.boolean().optional(),
    output: z.string().optional(),
  }),
  z.object({
    kind: z.literal('write'),
    filePath: z.string(),
    content: z.string().optional(),
    output: z.string().optional(),
  }),
  z.object({
    kind: z.literal('search'),
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional(),
    type: z.string().optional(),
    outputMode: z.string().optional(),
    output: z.string().optional(),
  }),
  z.object({
    kind: z.literal('glob'),
    pattern: z.string(),
    path: z.string().optional(),
    output: z.string().optional(),
  }),
  z.object({
    kind: z.literal('agent'),
    subagentType: z.string().optional(),
    description: z.string().optional(),
    prompt: z.string().optional(),
    output: z.string().optional(),
  }),
  z.object({
    kind: z.literal('web'),
    url: z.string().optional(),
    query: z.string().optional(),
    prompt: z.string().optional(),
    output: z.string().optional(),
  }),
  z.object({
    kind: z.literal('notebook'),
    notebookPath: z.string().optional(),
    editMode: z.string().optional(),
    cellType: z.string().optional(),
    output: z.string().optional(),
  }),
  z.object({
    kind: z.literal('unknown'),
    toolName: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    output: z.string().optional(),
  }),
]);

export const ToolCallUpdateSchema = z.object({
  updateType: z.literal('tool-call'),
  toolCallId: ToolCallIdSchema,
  toolName: z.string(),
  title: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
  detail: ToolCallDetailSchema.optional(),
  status: z.enum(['in_progress', 'completed', 'error']),
  timestamp: TimestampSchema,
});

export const ToolCallStatusUpdateSchema = z.object({
  updateType: z.literal('tool-call-update'),
  toolCallId: ToolCallIdSchema,
  status: z.enum(['completed', 'error']),
  title: z.string().optional(),
  output: z.string().optional(),
  timestamp: TimestampSchema,
});

export const TokenUsageUpdateSchema = z.object({
  updateType: z.literal('token-usage'),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().optional(),
  timestamp: TimestampSchema,
});

export const SystemStatusUpdateSchema = z.object({
  updateType: z.literal('system-status'),
  status: z.string(),
  timestamp: TimestampSchema,
});

export const StateChangeUpdateSchema = z.object({
  updateType: z.literal('state-change'),
  state: z.enum(['starting', 'running', 'waiting_permission', 'idle', 'completed', 'errored']),
  reason: z.string().optional(),
});

export const StepCommittedUpdateSchema = z.object({
  updateType: z.literal('step-committed'),
  step: z.number(),
  sha: z.string().nullable(),
  toolName: z.string().optional(),
  description: z.string(),
  timestamp: TimestampSchema,
});

export const PermissionRequestUpdateSchema = z.object({
  updateType: z.literal('permission-request'),
  requestId: z.string(),
  toolName: z.string(),
  description: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
  timestamp: TimestampSchema,
});

export const PermissionResolvedUpdateSchema = z.object({
  updateType: z.literal('permission-resolved'),
  requestId: z.string(),
  timestamp: TimestampSchema,
});

export const AttentionUpdateSchema = z.object({
  updateType: z.literal('attention'),
  requiresAttention: z.boolean(),
  reason: z.enum(['permission', 'completed', 'errored', 'idle_timeout']).optional(),
  toolName: z.string().optional(),
  timestamp: TimestampSchema,
});

export const StreamingStateUpdateSchema = z.object({
  updateType: z.literal('streaming-state'),
  streaming: z.boolean(),
  timestamp: TimestampSchema,
});

export const UnknownUpdateSchema = z.object({
  updateType: z.literal('unknown'),
  timestamp: TimestampSchema,
});

export const SessionUpdatePayloadSchema = z.discriminatedUnion('updateType', [
  AgentMessageUpdateSchema,
  AgentMessageChunkUpdateSchema,
  AgentThoughtChunkUpdateSchema,
  UserMessageUpdateSchema,
  ToolCallUpdateSchema,
  ToolCallStatusUpdateSchema,
  TokenUsageUpdateSchema,
  SystemStatusUpdateSchema,
  StateChangeUpdateSchema,
  StepCommittedUpdateSchema,
  PermissionRequestUpdateSchema,
  PermissionResolvedUpdateSchema,
  AttentionUpdateSchema,
  StreamingStateUpdateSchema,
  UnknownUpdateSchema,
]);

// ---------------------------------------------------------------------------
// Top-level incoming messages (daemon -> client)
// ---------------------------------------------------------------------------

export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().optional(),
  machine: z.object({
    id: z.string(),
  }),
  directories: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      name: z.string(),
    }),
  ),
  activeSessions: z.array(
    z.object({
      id: z.string(),
      directoryId: z.string(),
      state: z.enum(['starting', 'running', 'waiting_permission', 'idle', 'completed', 'errored']),
    }),
  ),
  discoveredSessions: z
    .array(
      z.object({
        id: z.string(),
        agentId: z.string().optional(),
        directoryId: z.string(),
        summary: z.string(),
        lastActivity: z.number(),
        messageCount: z.number(),
        resumable: z.boolean(),
        workflowRunId: z.string().optional(),
        workflowNodeId: z.string().optional(),
        parentDirectoryId: z.string().optional(),
        parentDirectoryPath: z.string().optional(),
        worktreePath: z.string().optional(),
      }),
    )
    .optional(),
  discoveredSessionsTruncated: z.boolean().optional(),
  availableAgents: z.array(z.string()).optional(),
  agents: z
    .array(
      z.object({
        id: z.string(),
        displayName: z.string(),
        tier: z.enum(['sdk', 'pty']),
        capabilities: z.object({
          structuredToolCalls: z.boolean(),
          permissionCallbacks: z.boolean(),
          tokenUsage: z.boolean(),
          resume: z.boolean(),
          extendedThinking: z.boolean(),
        }),
      }),
    )
    .optional(),
  models: z
    .array(
      z.object({
        value: z.string(),
        displayName: z.string(),
        description: z.string(),
        supportsEffort: z.boolean().optional(),
        supportedEffortLevels: z.array(z.enum(['low', 'medium', 'high', 'max'])).optional(),
        supportsAdaptiveThinking: z.boolean().optional(),
      }),
    )
    .optional(),
});

export const AckMessageSchema = z.object({
  type: z.literal('ack'),
  requestId: z.string().optional(),
  status: z.enum(['ok', 'error']),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  lastSeq: z.number().optional(),
  replayCount: z.number().optional(),
  messages: z.array(z.unknown()).optional(),
  originalReturned: z.number().optional(),
  droppedCount: z.number().optional(),
  truncated: z.boolean().optional(),
});

export const SessionStartedMessageSchema = z.object({
  type: z.literal('session-started'),
  sessionId: z.string(),
  directoryId: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  summary: z.string().optional(),
});

export const SessionUpdateMessageSchema = z.object({
  type: z.literal('session-update'),
  sessionId: z.string(),
  seq: z.number(),
  update: SessionUpdatePayloadSchema,
});

export const BranchRetryCreatedMessageSchema = z.object({
  type: z.literal('branch-retry-created'),
  path: z.string(),
});

export const SessionEndedMessageSchema = z.object({
  type: z.literal('session-ended'),
  sessionId: z.string(),
  reason: z.string().optional(),
  timestamp: z.number().optional(),
});

export const SessionAlertMessageSchema = z.object({
  type: z.literal('session-alert'),
  sessionId: z.string(),
  directoryId: z.string().optional(),
  requiresAttention: z.boolean(),
  reason: z.enum(['permission', 'completed', 'errored', 'idle_timeout']).optional(),
  toolName: z.string().optional(),
  requestId: z.string().optional(),
  detail: z.string().optional(),
  timestamp: z.number(),
});

export const SessionListMessageSchema = z.object({
  type: z.literal('session-list'),
  directoryId: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  sessions: z.array(
    z.object({
      id: z.string(),
      agentId: z.string().optional(),
      summary: z.string(),
      lastActivity: z.number(),
      messageCount: z.number(),
      resumable: z.boolean(),
    }),
  ),
  total: z.number(),
  hasMore: z.boolean(),
});

export const ReadSessionMessagesCommandSchema = z.object({
  type: z.literal('read-session-messages'),
  directoryId: z.string(),
  sessionId: z.string(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
  delivery: z.enum(['ack', 'event-stream']).optional(),
  requestId: z.string().optional(),
});

export const ContextCandidatePreviewCommandSchema = z.object({
  type: z.literal('context-candidate-preview'),
  contextResourceId: z.string(),
  workspaceId: z.string().optional(),
  actorName: z.string(),
  candidateEventId: z.string().optional(),
  payloadDigest: z.string().optional(),
  passphrase: z.string().optional(),
  recoveryCode: z.string().optional(),
  requestId: z.string().optional(),
});

export const DiscoveredSessionTailMessageSchema = z.object({
  type: z.literal('discovered-session-tail'),
  sessionId: z.string(),
  directoryId: z.string(),
  blocks: z.array(z.unknown()),
});

export const DiscoveredSessionsUpdatedMessageSchema = z.object({
  type: z.literal('discovered-sessions-updated'),
  truncated: z.boolean().optional(),
  sessions: z.array(
    z.object({
      id: z.string(),
      agentId: z.string().optional(),
      directoryId: z.string(),
      summary: z.string(),
      lastActivity: z.number(),
      messageCount: z.number(),
      resumable: z.boolean(),
    }),
  ),
});

export const DiscoveredSessionWaitingMessageSchema = z.object({
  type: z.literal('discovered-session-waiting'),
  sessionId: z.string(),
  directoryId: z.string(),
  waiting: z.boolean(),
  toolName: z.string().optional(),
  toolInput: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Hook event messages (daemon -> client, CLI hook integration)
// ---------------------------------------------------------------------------

export const HookSessionStartMessageSchema = z.object({
  type: z.literal('hook-session-start'),
  sessionId: z.string(),
  adapter: z.string().optional(),
  timestamp: TimestampSchema,
});

export const HookSessionEndMessageSchema = z.object({
  type: z.literal('hook-session-end'),
  sessionId: z.string(),
  adapter: z.string().optional(),
  timestamp: TimestampSchema,
});

export const HookPermissionRequestMessageSchema = z.object({
  type: z.literal('hook-permission-request'),
  hookRequestId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  description: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
  adapter: z.string().optional(),
  timestamp: TimestampSchema,
});

export const HookNotificationMessageSchema = z.object({
  type: z.literal('hook-notification'),
  sessionId: z.string(),
  message: z.string(),
  level: z.enum(['info', 'warning', 'error']).optional(),
  adapter: z.string().optional(),
  timestamp: TimestampSchema,
});

export const HookToolCompletedMessageSchema = z.object({
  type: z.literal('hook-tool-completed'),
  sessionId: z.string(),
  toolName: z.string(),
  title: z.string().optional(),
  adapter: z.string().optional(),
  timestamp: TimestampSchema,
});

export const HookToolFailedMessageSchema = z.object({
  type: z.literal('hook-tool-failed'),
  sessionId: z.string(),
  toolName: z.string(),
  error: z.string().optional(),
  adapter: z.string().optional(),
  timestamp: TimestampSchema,
});

export const HookStopMessageSchema = z.object({
  type: z.literal('hook-stop'),
  sessionId: z.string(),
  reason: z.string().optional(),
  adapter: z.string().optional(),
  timestamp: TimestampSchema,
});

export const HookSubagentStartMessageSchema = z.object({
  type: z.literal('hook-subagent-start'),
  sessionId: z.string(),
  subagentId: z.string(),
  adapter: z.string().optional(),
  timestamp: TimestampSchema,
});

export const HookSubagentStopMessageSchema = z.object({
  type: z.literal('hook-subagent-stop'),
  sessionId: z.string(),
  subagentId: z.string(),
  adapter: z.string().optional(),
  timestamp: TimestampSchema,
});

export const IncomingMessageSchema = z.discriminatedUnion('type', [
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
  HookSessionStartMessageSchema,
  HookSessionEndMessageSchema,
  HookPermissionRequestMessageSchema,
  HookNotificationMessageSchema,
  HookToolCompletedMessageSchema,
  HookToolFailedMessageSchema,
  HookStopMessageSchema,
  HookSubagentStartMessageSchema,
  HookSubagentStopMessageSchema,
]);

// ---------------------------------------------------------------------------
// Outgoing messages (client -> daemon)
// ---------------------------------------------------------------------------

export const LaunchCommandSchema = z.object({
  type: z.literal('launch'),
  directoryId: z.string(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  thinkingMode: z.string().optional(),
  images: z
    .array(
      z.object({
        data: z.string(),
        mediaType: z.string(),
      }),
    )
    .optional(),
  configOverrides: z
    .object({
      agent: z.string().optional(),
      model: z.string().optional(),
      costCapUsd: z.number().optional(),
      trust: z.enum(['operator', 'automated', 'external']).optional(),
    })
    .optional(),
  requestId: z.string().optional(),
});

export const KillCommandSchema = z.object({
  type: z.literal('kill'),
  sessionId: z.string(),
  requestId: z.string().optional(),
});

export const PromptCommandSchema = z.object({
  type: z.literal('prompt'),
  sessionId: z.string(),
  text: z.string().max(100000),
  images: z
    .array(
      z.object({
        data: z.string(),
        mediaType: z.string(),
      }),
    )
    .optional(),
  requestId: z.string().optional(),
});

export const RespondPermissionCommandSchema = z.object({
  type: z.literal('respond-permission'),
  sessionId: z.string(),
  permissionRequestId: z.string(),
  decision: z.object({
    behavior: z.enum(['allow', 'deny', 'allow-always']),
    message: z.string().optional(),
  }),
  requestId: z.string().optional(),
});

export const SubscribeCommandSchema = z.object({
  type: z.literal('subscribe'),
  sessionId: z.string(),
  lastSeq: z.number().int().nonnegative().optional(),
  requestId: z.string().optional(),
});

export const UnsubscribeCommandSchema = z.object({
  type: z.literal('unsubscribe'),
  sessionId: z.string(),
  requestId: z.string().optional(),
});

export const RollbackCommandSchema = z.object({
  type: z.literal('rollback'),
  sessionId: z.string(),
  toSha: ShaSchema,
  requestId: z.string().optional(),
});

export const BranchRetryCommandSchema = z.object({
  type: z.literal('branch-retry'),
  sessionId: z.string(),
  fromSha: ShaSchema,
  prompt: z.string(),
  requestId: z.string().optional(),
});

export const SquashMergeCommandSchema = z.object({
  type: z.literal('squash-merge'),
  sessionId: z.string(),
  targetBranch: z.string(),
  commitMessage: z.string(),
  requestId: z.string().optional(),
});

export const ResumeCommandSchema = z.object({
  type: z.literal('resume'),
  sessionId: z.string(),
  directoryId: z.string(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  requestId: z.string().optional(),
});

export const WatchDiscoveredSessionCommandSchema = z.object({
  type: z.literal('watch-discovered-session'),
  sessionId: z.string(),
  directoryId: z.string().optional(),
  requestId: z.string().optional(),
});

export const UnwatchDiscoveredSessionCommandSchema = z.object({
  type: z.literal('unwatch-discovered-session'),
  sessionId: z.string(),
  directoryId: z.string().optional(),
  requestId: z.string().optional(),
});

export const SuperviseCommandSchema = z.object({
  type: z.literal('supervise'),
  sessionId: z.string(),
  active: z.boolean(),
  requestId: z.string().optional(),
});

export const RespondHookPermissionCommandSchema = z.object({
  type: z.literal('respond-hook-permission'),
  hookRequestId: z.string(),
  decision: z.enum(['allow', 'deny', 'allow-always']),
  requestId: z.string().optional(),
});

export const OutgoingMessageSchema = z.discriminatedUnion('type', [
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
  ReadSessionMessagesCommandSchema,
  ContextCandidatePreviewCommandSchema,
  WatchDiscoveredSessionCommandSchema,
  UnwatchDiscoveredSessionCommandSchema,
  SuperviseCommandSchema,
  RespondHookPermissionCommandSchema,
]);
