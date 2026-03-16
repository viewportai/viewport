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

  /** Start a new agent session in the given working directory. */
  startSession(cwd: string, options?: SessionOptions): Promise<Session>;

  /** Resume an existing session by ID. */
  resumeSession(sessionId: string, cwd: string, options?: SessionOptions): Promise<Session>;
}

export interface SessionOptions {
  /** Initial prompt to send to the agent. */
  initialPrompt?: string;
  /** Model override (e.g. 'claude-sonnet-4-6'). */
  model?: string;
  /** Permission handler — called before each tool execution. */
  canUseTool?: PermissionHandler;
  /** Resolved config for this session. */
  config?: SessionConfig;
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

export interface DiscoveredSession {
  /** Source agent that owns this session (e.g. 'claude', 'codex', 'gemini'). */
  agentId: string;
  /** Session ID (UUID from the agent). */
  sessionId: string;
  /** First user prompt or summary. */
  summary: string;
  /** Last modified timestamp (ms since epoch). */
  lastModified: number;
  /** Working directory for the session. */
  cwd?: string;
  /** Git branch at the end of the session. */
  gitBranch?: string;
  /** Whether this session can be resumed. */
  resumable: boolean;
  /** Number of messages in the session. */
  messageCount?: number;
  /** Optional source file backing this discovered session. */
  sourcePath?: string;
}
