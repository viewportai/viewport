/**
 * Core type definitions for the Viewport daemon.
 *
 * These types are the shared vocabulary across all modules — adapters, trackers,
 * permissions, server, and UI protocol. Keep them stable.
 */

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export type SessionState =
  | 'starting'
  | 'running'
  | 'waiting_permission'
  | 'idle'
  | 'completed'
  | 'errored';

export type SessionTrust = 'operator' | 'automated' | 'external';
export type SessionAgentMode = 'detect' | 'bypass';

// ---------------------------------------------------------------------------
// Attention state — centralizes "this session needs your attention"
// ---------------------------------------------------------------------------

export type AttentionReason = 'permission' | 'completed' | 'errored' | 'idle_timeout';

export interface AttentionState {
  requiresAttention: boolean;
  reason?: AttentionReason;
  /** Tool name if reason is 'permission'. */
  toolName?: string;
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Streaming state
// ---------------------------------------------------------------------------

export interface StreamStats {
  messagesPerSec: number;
  bytesPerSec: number;
  bufferDepth: number;
  streaming: boolean;
  lastUpdated: number;
}

// ---------------------------------------------------------------------------
// Steps (git-tracked units of work)
// ---------------------------------------------------------------------------

export interface Step {
  /** Sequential step number within the session. */
  step: number;
  /** Git commit SHA, or null if the commit is pending/skipped. */
  sha: string | null;
  /** Message type that triggered this step (e.g. 'tool_call'). */
  type: string;
  /** Tool name if this step was triggered by a tool call. */
  toolName?: string;
  /** Human-readable description of what happened. */
  description: string;
  /** Unix timestamp (ms) when this step occurred. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Session messages (normalized across all adapters)
// ---------------------------------------------------------------------------

export type SessionMessage =
  | UserMessage
  | AgentMessage
  | AgentMessageChunk
  | AgentThoughtChunk
  | ToolCall
  | ToolCallUpdate
  | TokenUsage
  | SystemStatus;

export interface UserMessage {
  type: 'user_message';
  text: string;
  messageId: string;
  timestamp: number;
}

export interface AgentMessage {
  type: 'agent_message';
  text: string;
  messageId: string;
  timestamp: number;
}

export interface AgentMessageChunk {
  type: 'agent_message_chunk';
  text: string;
  messageId: string;
  timestamp: number;
}

export interface AgentThoughtChunk {
  type: 'agent_thought_chunk';
  text: string;
  messageId: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Typed tool call details (discriminated union — structured tool data)
// ---------------------------------------------------------------------------

export type ToolCallDetail =
  | {
      kind: 'shell';
      command: string;
      cwd?: string;
      output?: string;
      exitCode?: number;
      timeout?: number;
    }
  | { kind: 'read'; filePath: string; offset?: number; limit?: number; output?: string }
  | {
      kind: 'edit';
      filePath: string;
      oldString?: string;
      newString?: string;
      replaceAll?: boolean;
      output?: string;
    }
  | { kind: 'write'; filePath: string; content?: string; output?: string }
  | {
      kind: 'search';
      pattern: string;
      path?: string;
      glob?: string;
      type?: string;
      outputMode?: string;
      output?: string;
    }
  | { kind: 'glob'; pattern: string; path?: string; output?: string }
  | { kind: 'agent'; subagentType?: string; description?: string; prompt?: string; output?: string }
  | { kind: 'web'; url?: string; query?: string; prompt?: string; output?: string }
  | {
      kind: 'notebook';
      notebookPath?: string;
      editMode?: string;
      cellType?: string;
      output?: string;
    }
  | { kind: 'unknown'; toolName: string; input?: Record<string, unknown>; output?: string };

/**
 * Map a tool name + input to a typed ToolCallDetail.
 * Centralizes the SDK → structured detail mapping so both adapters
 * and message normalizers use the same logic.
 */
export function toToolCallDetail(
  toolName: string,
  input?: Record<string, unknown>,
): ToolCallDetail {
  switch (toolName) {
    case 'Bash':
      return {
        kind: 'shell',
        command: String(input?.command ?? ''),
        cwd: input?.cwd ? String(input.cwd) : undefined,
        timeout: typeof input?.timeout === 'number' ? input.timeout : undefined,
      };
    case 'Read':
      return {
        kind: 'read',
        filePath: String(input?.file_path ?? ''),
        offset: typeof input?.offset === 'number' ? input.offset : undefined,
        limit: typeof input?.limit === 'number' ? input.limit : undefined,
      };
    case 'Edit':
    case 'MultiEdit':
      return {
        kind: 'edit',
        filePath: String(input?.file_path ?? ''),
        oldString: input?.old_string ? String(input.old_string) : undefined,
        newString: input?.new_string ? String(input.new_string) : undefined,
        replaceAll: input?.replace_all === true,
      };
    case 'Write':
      return {
        kind: 'write',
        filePath: String(input?.file_path ?? ''),
        content: input?.content ? String(input.content) : undefined,
      };
    case 'Grep':
      return {
        kind: 'search',
        pattern: String(input?.pattern ?? ''),
        path: input?.path ? String(input.path) : undefined,
        glob: input?.glob ? String(input.glob) : undefined,
        type: input?.type ? String(input.type) : undefined,
        outputMode: input?.output_mode ? String(input.output_mode) : undefined,
      };
    case 'Glob':
      return {
        kind: 'glob',
        pattern: String(input?.pattern ?? ''),
        path: input?.path ? String(input.path) : undefined,
      };
    case 'Agent':
    case 'Task':
      return {
        kind: 'agent',
        subagentType: input?.subagent_type ? String(input.subagent_type) : undefined,
        description: input?.description ? String(input.description) : undefined,
        prompt: input?.prompt ? String(input.prompt) : undefined,
      };
    case 'WebSearch':
      return {
        kind: 'web',
        query: input?.query ? String(input.query) : undefined,
      };
    case 'WebFetch':
      return {
        kind: 'web',
        url: input?.url ? String(input.url) : undefined,
        prompt: input?.prompt ? String(input.prompt) : undefined,
      };
    case 'NotebookEdit':
      return {
        kind: 'notebook',
        notebookPath: input?.notebook_path ? String(input.notebook_path) : undefined,
        editMode: input?.edit_mode ? String(input.edit_mode) : undefined,
        cellType: input?.cell_type ? String(input.cell_type) : undefined,
      };
    default:
      return { kind: 'unknown', toolName, input };
  }
}

export interface ToolCall {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  title: string;
  input?: Record<string, unknown>;
  detail?: ToolCallDetail;
  status: 'in_progress' | 'completed' | 'error';
  timestamp: number;
}

export interface ToolCallUpdate {
  type: 'tool_call_update';
  toolCallId: string;
  toolName?: string;
  status: 'completed' | 'error';
  title?: string;
  output?: string;
  timestamp: number;
}

export interface TokenUsage {
  type: 'token_usage';
  inputTokens: number;
  outputTokens: number;
  totalCostUsd?: number;
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
  durationMs?: number;
  numTurns?: number;
  timestamp: number;
}

export interface SystemStatus {
  type: 'system_status';
  status: string;
  sessionId: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  /** Unique ID for this permission request. */
  requestId: string;
  /** The tool requesting permission. */
  toolName: string;
  /** Human-readable description of what the tool wants to do. */
  description: string;
  /** Raw tool input (shown to user for context). */
  input?: Record<string, unknown>;
  /** Reason the SDK gives for why this needs permission. */
  decisionReason?: string;
  /** File path that triggered the permission request, if applicable. */
  blockedPath?: string;
}

export interface PendingPermissionRequest {
  sessionId: string;
  requestId: string;
  toolName: string;
  description: string;
  input?: Record<string, unknown>;
  decisionReason?: string;
  blockedPath?: string;
  createdAt: number;
}

/**
 * User's response to a permission request.
 * Note: SDK only supports 'allow' | 'deny'. No 'allow-always' at the SDK level.
 * "Always allow" is implemented by passing updatedPermissions back to the SDK.
 */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SessionConfig {
  agent: string;
  model?: string;
  /** Provider sandbox posture for agents that support it, such as Codex. */
  sandboxMode?: string;
  /** Provider approval posture for agents that support it, such as Codex. */
  approvalPolicy?: string;
  /** Explicit resource context selected by the launcher/operator. */
  resourceId?: string;
  gitTracker: GitTrackerConfig;
  permissions: PermissionsConfig;
  costCapUsd?: number;
  trust: SessionTrust;
}

export interface GitTrackerConfig {
  enabled: boolean;
  /** Tool names that trigger a micro-commit (e.g. ['Edit', 'Write', 'Bash']). */
  commitOn: string[];
  /** Glob patterns to exclude from commits. */
  ignore: string[];
  /** Automatically squash-merge viewport branch when session completes. */
  autoSquashOnComplete: boolean;
  /** Branch name prefix for viewport tracking branches. */
  branchPrefix: string;
  /** Git author string for viewport commits. */
  commitAuthor: string;
  /** Stop committing after this many commits per session. */
  maxCommitsPerSession: number;
  /** Root directory for worktrees, relative to project root. */
  worktreeRoot: string;
  /** Max estimated staged bytes per auto-commit; commits above this are skipped. */
  maxCommitSizeBytes?: number;
  /**
   * Max time to wait for pending commit queue during teardown before forcing cleanup.
   * Use 0/negative to wait indefinitely.
   */
  teardownCommitDrainMs?: number;
}

export interface PermissionsConfig {
  /** Tools that are auto-approved without prompting. */
  autoApprove: string[];
  /** Tools that require explicit user approval. */
  requireApproval: string[];
  /** Tools that are always denied. */
  deny: string[];
}

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

export interface DirectoryInfo {
  /** Unique identifier (derived from path). */
  id: string;
  /** Absolute filesystem path. */
  path: string;
  /** Per-directory config overrides. */
  config?: Partial<SessionConfig>;
  /** Active session IDs in this directory. */
  activeSessions: string[];
}
