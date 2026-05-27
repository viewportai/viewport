/**
 * Plugin interfaces for the Viewport daemon.
 *
 * These contracts define how adapters, trackers, and discovery providers
 * integrate with the daemon. All agent-specific logic lives behind these
 * interfaces — the daemon core never imports SDK-specific code directly.
 */

import type { EventEmitter } from 'node:events';
import type {
  SessionState,
  SessionMessage,
  SessionConfig,
  SessionExecutionMode,
  Step,
  PermissionDecision,
  GitTrackerConfig,
} from './types.js';

// ---------------------------------------------------------------------------
// AgentAdapter — one per supported agent (Claude, Codex, Cursor, PTY)
// ---------------------------------------------------------------------------

export interface AgentAdapter {
  /** Unique identifier for this agent (e.g. 'claude', 'codex'). */
  readonly agentId: string;

  /** Describe the adapter's workflow-relevant capability and accounting contract. */
  describe(): AgentAdapterDescriptor;

  /**
   * Transactional workflow-agent entrypoint. Existing adapters may bridge this
   * through session streams during migration, but durable workflow accounting
   * must normalize into AgentRunResult.
   */
  runAgentTurn?(request: AgentRunRequest): Promise<AgentRunResult>;

  /** Start a new agent session in the given working directory. */
  startSession(cwd: string, options?: SessionOptions): Promise<Session>;

  /** Resume an existing session by ID. */
  resumeSession(sessionId: string, cwd: string, options?: SessionOptions): Promise<Session>;
}

export interface SessionOptions {
  /** Initial prompt to send to the agent. */
  initialPrompt?: string;
  /**
   * Internal daemon option: create the session without dispatching the initial
   * prompt so SessionManager can wire lifecycle/message listeners first.
   */
  deferInitialPrompt?: boolean;
  /** Model override (e.g. 'claude-sonnet-4-6'). */
  model?: string;
  /** Agent-specific reasoning/effort hint translated by adapters that support it. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * Exact tool allowlist for this session. An empty array means the adapter
   * should run the agent without tools when the provider supports it.
   */
  allowedTools?: string[];
  /** Permission handler — called before each tool execution. */
  canUseTool?: PermissionHandler;
  /** Resolved config for this session. */
  config?: SessionConfig;
}

export type AgentCapabilitySupport = 'hard' | 'provider' | 'prompt_only' | 'unsupported';
export type AgentReportingSupport = 'reported' | 'estimated' | 'unavailable';

export interface AgentAdapterDescriptor {
  schema: 'viewport.agent_adapter/v2';
  agentId: string;
  displayName: string;
  adapterVersion: string;
  capabilities: {
    executionModes: Record<SessionExecutionMode, AgentCapabilitySupport>;
    toolAllowlist: AgentCapabilitySupport;
    structuredOutput: AgentCapabilitySupport;
    permissionHooks: AgentCapabilitySupport;
    usageReporting: AgentReportingSupport;
    costReporting: AgentReportingSupport;
    maxTurns: AgentCapabilitySupport;
    maxBudget: AgentCapabilitySupport;
    hardTimeout: AgentCapabilitySupport;
  };
}

export type AgentRunStopReason =
  | 'completed'
  | 'idle'
  | 'max_turns'
  | 'budget_exceeded'
  | 'timeout'
  | 'tool_denied'
  | 'canceled'
  | 'error'
  | 'unknown';

export interface AgentRunUsage {
  available: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalCostUsd?: number;
  estimated?: boolean;
  reason?: 'adapter_no_usage' | 'provider_no_cost' | 'stream_missing_final_usage';
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
  durationMs?: number;
  numTurns?: number;
}

export interface AgentRunToolCall {
  id: string;
  name: string;
  status: 'in_progress' | 'completed' | 'error' | 'denied';
  title?: string;
  startedAt?: number;
  completedAt?: number;
  inputDigest?: string;
}

export interface AgentRunEnforcement {
  executionMode: SessionExecutionMode;
  planMode: AgentCapabilitySupport;
  readOnlyMode: AgentCapabilitySupport;
  toolAllowlist: AgentCapabilitySupport;
  structuredOutput: AgentCapabilitySupport;
  sandbox: AgentCapabilitySupport;
}

export interface AgentRunRequest {
  prompt: string;
  cwd: string;
  agentId: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  executionMode: SessionExecutionMode;
  allowedTools?: string[];
  timeoutMs?: number;
  budget?: {
    maxCostUsd?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxTurns?: number;
  };
  onEvent?: (event: AgentRunEvent) => void;
}

export type AgentRunEvent =
  | { type: 'started'; timestamp: number }
  | { type: 'text_delta'; text: string; timestamp: number }
  | { type: 'tool_call'; toolCall: AgentRunToolCall; timestamp: number }
  | { type: 'usage_delta'; usage: AgentRunUsage; timestamp: number }
  | { type: 'completed'; result: AgentRunResult; timestamp: number }
  | { type: 'failed'; error: string; timestamp: number };

export interface AgentRunResult {
  schema: 'viewport.agent_run_result/v1';
  agentId: string;
  adapterVersion: string;
  model?: string;
  executionMode: SessionExecutionMode;
  enforcement: AgentRunEnforcement;
  output: string;
  usage: AgentRunUsage;
  toolCalls: AgentRunToolCall[];
  permissionDenials: Array<{ toolName: string; reason: string; timestamp: number }>;
  stopReason: AgentRunStopReason;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

/**
 * Permission handler function. Matches the pattern of SDK's CanUseTool
 * but uses our PermissionDecision type for the response.
 */
export type PermissionHandler = (
  toolName: string,
  input: Record<string, unknown>,
  context: PermissionContext,
) => Promise<PermissionDecision>;

export interface PermissionContext {
  /** Abort signal for cancellation. */
  signal: AbortSignal;
  /** Unique ID for this specific tool call. */
  toolUseId: string;
  /** Explains why this permission request was triggered. */
  decisionReason?: string;
  /** File path that triggered the request, if applicable. */
  blockedPath?: string;
  /** Sub-agent ID, if running within a sub-agent. */
  agentId?: string;
}

// ---------------------------------------------------------------------------
// Session — a running agent session
// ---------------------------------------------------------------------------

export interface Session extends EventEmitter {
  /** Unique session identifier (UUID). */
  readonly id: string;
  /** Current session state. */
  state: SessionState;

  /** Send a follow-up prompt to the agent. */
  sendPrompt(text: string): Promise<void>;
  /** Interrupt and stop the session. */
  kill(): Promise<void>;

  // Events emitted:
  // 'message' → SessionMessage
  // 'state-change' → SessionState
  // 'ended' → string (reason)
}

// ---------------------------------------------------------------------------
// RunTracker — tracks file changes during a session (git or noop)
// ---------------------------------------------------------------------------

export interface RunTracker {
  /** Recorded steps with commit SHAs. */
  readonly steps: ReadonlyArray<Step>;

  /** Optional callback invoked when a step is committed (set by SessionManager). */
  onStepCommitted?: (step: Step) => void;

  /**
   * Set up tracking for a session. Returns the working directory path
   * where the agent should run (may be a git worktree).
   */
  setup(sessionId: string, projectPath: string): Promise<string>;

  /** Process a session message (may trigger a commit). */
  onMessage(msg: SessionMessage): void;

  /** Roll back to a specific commit SHA. */
  rollback(toSha: string): Promise<void>;

  /** Create a retry branch from a specific commit. Returns the new worktree path. */
  branchRetry(fromSha: string): Promise<string>;

  /** Squash-merge the viewport branch into the target branch. */
  squashMerge(targetBranch: string, commitMessage: string): Promise<void>;

  /** Flush any pending commits. Called before teardown on crash/end. */
  flushPendingCommits(): Promise<void>;

  /** Clean up: flush pending commits, remove worktree. */
  teardown(): Promise<void>;

  /** Get the diff for a specific commit. */
  getDiff(sha: string): Promise<string>;

  /** Get diffs for all tracked steps. */
  getStepDiffs(): Promise<Array<{ step: number; sha: string; diff: string }>>;

  /** Get the total diff across the entire session. */
  getSummaryDiff(): Promise<string>;
}

// ---------------------------------------------------------------------------
// RunTrackerFactory — creates trackers based on config
// ---------------------------------------------------------------------------

export type RunTrackerFactory = (config: GitTrackerConfig, sessionId: string) => RunTracker;

// ---------------------------------------------------------------------------
// SessionDiscovery — discovers existing sessions from an agent's files
// ---------------------------------------------------------------------------

export interface SessionDiscovery {
  /** Which agent this discovery provider is for. */
  readonly agentId: string;

  /** Discover existing sessions for a project path. */
  discoverSessions(projectPath: string): Promise<DiscoveredSession[]>;
}

export interface SessionInteractionCapabilities {
  /** Transcript/history can be read from the owning machine. */
  readTranscript: boolean;
  /** Transcript tail updates can be streamed while the source file changes. */
  tailTranscript: boolean;
  /** The provider can resume this session by id. */
  resume: boolean;
  /** The daemon can send a new prompt to the running session. */
  sendPrompt: boolean;
  /** The daemon can interrupt the running session. */
  interrupt: boolean;
  /** Pending permission requests can be answered through Viewport. */
  respondToPermissions: boolean;
  /** Resume accepts a model override. */
  modelOverride: boolean;
}

export interface DiscoveredSession {
  /** Source agent that owns this session (e.g. 'claude', 'codex', 'gemini'). */
  agentId: string;
  /** Session ID (UUID from the agent). */
  sessionId: string;
  /** First user prompt or summary. */
  summary: string;
  /** Provider-native user-facing title, when the agent stores one. */
  nativeTitle?: string;
  /** Viewport-generated fallback title, when no provider-native title exists. */
  generatedTitle?: string;
  /** Title the UI should render. */
  displayTitle?: string;
  /** Where displayTitle came from. */
  titleSource?: 'native' | 'generated' | 'first_prompt' | 'fallback';
  /** First meaningful user prompt, excluding injected environment/context metadata. */
  firstPrompt?: string;
  /** Last meaningful user prompt, excluding injected environment/context metadata. */
  lastPrompt?: string;
  /** Latest known provider/model label. */
  latestModel?: string;
  /** Latest known provider approval policy. */
  approvalPolicy?: string;
  /** Latest known sandbox mode. */
  sandboxMode?: string;
  /** Latest known reasoning effort or thinking mode. */
  reasoningEffort?: string;
  /** Last modified timestamp (ms since epoch). */
  lastModified: number;
  /** Working directory for the session. */
  cwd?: string;
  /** Git branch at the end of the session. */
  gitBranch?: string;
  /** Whether this session can be resumed. */
  resumable: boolean;
  /** Explicit interaction capabilities for this session. */
  capabilities?: SessionInteractionCapabilities;
  /** Number of messages in the session. */
  messageCount?: number;
  /** Optional source file backing this discovered session. */
  sourcePath?: string;
  /** Workflow run that spawned this session, when it came from a workflow node. */
  workflowRunId?: string;
  /** Workflow node that spawned this session, when it came from a workflow node. */
  workflowNodeId?: string;
  /** Original registered directory that launched a worktree-backed workflow session. */
  parentDirectoryId?: string;
  /** Original registered directory path that launched a worktree-backed workflow session. */
  parentDirectoryPath?: string;
  /** Working tree path used by the spawned session, when different from the parent directory. */
  worktreePath?: string;
}
