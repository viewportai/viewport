/**
 * SessionManager — manages the lifecycle of active agent sessions.
 *
 * Owns session storage, launch/resume/kill, event wiring, and tracker setup.
 * Uses the daemon's event bus for all inter-module communication.
 */

import type { AgentAdapter, RunTracker, RunTrackerFactory, Session } from './interfaces.js';
import type {
  SessionAgentMode,
  SessionConfig,
  SessionMessage,
  SessionState,
  Step,
} from './types.js';
import type { TypedEventEmitter } from './events.js';
import type { DaemonEvents } from './events.js';
import type { ConfigManager } from './config.js';
import type { DirectoryManager } from '../directories/manager.js';
import type { PermissionCoordinator } from './permission-coordinator.js';
import { NoopTracker } from '../tracking/noop-tracker.js';
import { ViewportError } from './errors.js';
import { logger } from './logger.js';
import { buildSessionPromptWithContext } from './session-context-prompt.js';

const log = logger.child({ module: 'session-manager' });

function defaultSessionAgentMode(config: SessionConfig): SessionAgentMode {
  return config.trust === 'automated' && config.approvalPolicy === 'never' ? 'bypass' : 'detect';
}

// ---------------------------------------------------------------------------
// Session record — internal tracking of active sessions
// ---------------------------------------------------------------------------

/** Listener references for cleanup on session end / shutdown. */
interface SessionListeners {
  onMessage: (msg: SessionMessage) => void;
  onStateChange: (state: SessionState) => void;
  onEnded: (reason: string) => Promise<void>;
}

export interface ActiveSession {
  session: Session;
  tracker: RunTracker;
  config: SessionConfig;
  startedAt: number;
  directoryId: string;
  worktreePath: string;
  listeners?: SessionListeners;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private sessionModes = new Map<string, SessionAgentMode>();
  private sessionEndReasons = new Map<string, string>();

  constructor(
    private readonly eventBus: TypedEventEmitter<DaemonEvents>,
    private readonly configManager: ConfigManager,
    private readonly directoryManager: DirectoryManager,
    private readonly permissionCoordinator: PermissionCoordinator,
    private readonly adapters: Map<string, AgentAdapter>,
    private readonly getTrackerFactory: () => RunTrackerFactory | null,
  ) {}

  /**
   * Launch a new agent session in a registered directory.
   *
   * 1. Resolves config (global -> directory -> session overrides)
   * 2. Creates a tracker (git or noop)
   * 3. Sets up the tracker (creates worktree if git-backed)
   * 4. Wires permission handler
   * 5. Starts the session via the adapter
   * 6. Wires events
   */
  async launchSession(
    directoryId: string,
    prompt: string,
    overrides?: Partial<SessionConfig>,
  ): Promise<string> {
    const dir = this.directoryManager.get(directoryId);
    if (!dir) {
      throw new ViewportError(
        'DIRECTORY_NOT_REGISTERED',
        `Directory not registered: ${directoryId}`,
      );
    }

    // Resolve config
    const config = this.configManager.resolveSessionConfig(directoryId, overrides);

    // Get adapter
    const adapter = this.adapters.get(config.agent);
    if (!adapter) {
      throw new ViewportError(
        'ADAPTER_NOT_AVAILABLE',
        `No adapter registered for agent: ${config.agent}`,
      );
    }

    // Create tracker (falls back to noop if git setup fails — e.g. not a git repo)
    const sessionId = crypto.randomUUID();
    this.sessionEndReasons.delete(sessionId);
    const { tracker, worktreePath } = await this.setupTracker(config, sessionId, dir.path);
    const initialMode = defaultSessionAgentMode(config);
    this.permissionCoordinator.setSessionMode(sessionId, initialMode);

    // Wire permission handler
    const canUseTool = this.permissionCoordinator.createPermissionHandler(
      sessionId,
      () => this.sessions.get(sessionId)?.config ?? config,
    );

    // Start session
    let session: Session;
    try {
      session = await adapter.startSession(worktreePath, {
        initialPrompt: prompt,
        deferInitialPrompt: true,
        model: config.model,
        effort: config.effort,
        allowedTools: config.allowedTools,
        canUseTool,
        config,
      });
    } catch (err) {
      this.permissionCoordinator.clearSessionMode(sessionId);
      throw err;
    }

    // Store active session
    const active: ActiveSession = {
      session,
      tracker,
      config,
      startedAt: Date.now(),
      directoryId,
      worktreePath,
    };
    this.sessions.set(sessionId, active);
    this.sessionModes.set(sessionId, initialMode);
    this.directoryManager.addSession(directoryId, sessionId);
    this.eventBus.adjustMaxListeners(this.sessions.size);

    // Wire session events
    this.wireSessionEvents(sessionId, active);

    // Emit session started
    this.eventBus.emit('session:started', { sessionId, directoryId, config });

    this.dispatchInitialPrompt(sessionId, prompt);

    return sessionId;
  }

  /**
   * Resume a discovered session via the adapter's resume support.
   *
   * Uses the original sessionId so the SDK can load the existing conversation.
   */
  async resumeSession(
    originalSessionId: string,
    directoryId: string,
    prompt?: string,
    overrides?: Partial<SessionConfig>,
  ): Promise<string> {
    const dir = this.directoryManager.get(directoryId);
    if (!dir) {
      throw new ViewportError(
        'DIRECTORY_NOT_REGISTERED',
        `Directory not registered: ${directoryId}`,
      );
    }

    const config = this.configManager.resolveSessionConfig(directoryId, overrides);

    const adapter = this.adapters.get(config.agent);
    if (!adapter) {
      throw new ViewportError(
        'ADAPTER_NOT_AVAILABLE',
        `No adapter registered for agent: ${config.agent}`,
      );
    }

    const { tracker, worktreePath } = await this.setupTracker(config, originalSessionId, dir.path);
    this.sessionEndReasons.delete(originalSessionId);
    const initialMode = defaultSessionAgentMode(config);
    this.permissionCoordinator.setSessionMode(originalSessionId, initialMode);
    const canUseTool = this.permissionCoordinator.createPermissionHandler(originalSessionId, () => {
      return this.sessions.get(originalSessionId)?.config ?? config;
    });

    let session: Session;
    try {
      session = await adapter.resumeSession(originalSessionId, worktreePath, {
        initialPrompt: prompt,
        deferInitialPrompt: true,
        model: config.model,
        effort: config.effort,
        allowedTools: config.allowedTools,
        canUseTool,
        config,
      });
    } catch (err) {
      this.permissionCoordinator.clearSessionMode(originalSessionId);
      throw err;
    }

    const active: ActiveSession = {
      session,
      tracker,
      config,
      startedAt: Date.now(),
      directoryId,
      worktreePath,
    };
    this.sessions.set(originalSessionId, active);
    this.sessionModes.set(originalSessionId, initialMode);
    this.directoryManager.addSession(directoryId, originalSessionId);
    this.eventBus.adjustMaxListeners(this.sessions.size);
    this.wireSessionEvents(originalSessionId, active);
    this.eventBus.emit('session:started', { sessionId: originalSessionId, directoryId, config });

    this.dispatchInitialPrompt(originalSessionId, prompt);

    return originalSessionId;
  }

  /** Kill an active session. */
  async killSession(sessionId: string): Promise<void> {
    const active = this.getActiveSession(sessionId);
    await active.session.kill();
  }

  /** Send a follow-up prompt to a session. */
  async sendPrompt(sessionId: string, text: string): Promise<void> {
    log.info({ sessionId, textLen: text.length }, 'sessionManager.sendPrompt');
    const active = this.getActiveSession(sessionId);
    log.debug(
      { sessionId, sessionState: active.session.state },
      'sessionManager.sendPrompt: session found',
    );
    await active.session.sendPrompt(text);
    log.info({ sessionId }, 'sessionManager.sendPrompt: completed');
  }

  /** Get all active session IDs. */
  getActiveSessions(): string[] {
    return [...this.sessions.keys()];
  }

  /** Get session state and metadata. */
  getSessionInfo(sessionId: string): {
    state: SessionState;
    directoryId: string;
    resourceId?: string;
    agent: string;
    mode: SessionAgentMode;
    steps: ReadonlyArray<Step>;
  } {
    const active = this.getActiveSession(sessionId);
    return {
      state: active.session.state,
      directoryId: active.directoryId,
      resourceId: active.config.resourceId,
      agent: active.config.agent,
      mode: this.getSessionMode(sessionId),
      steps: active.tracker.steps,
    };
  }

  getSessionNativeId(sessionId: string): string {
    return this.getActiveSession(sessionId).session.id;
  }

  getSessionEndReason(sessionId: string): string | undefined {
    return this.sessionEndReasons.get(sessionId);
  }

  listSessionSummaries(): Array<{
    sessionId: string;
    directoryId: string;
    resourceId?: string;
    agent: string;
    state: SessionState;
    mode: SessionAgentMode;
    startedAt: number;
  }> {
    return [...this.sessions.entries()].map(([sessionId, active]) => ({
      sessionId,
      directoryId: active.directoryId,
      resourceId: active.config.resourceId,
      agent: active.config.agent,
      state: active.session.state,
      mode: this.getSessionMode(sessionId),
      startedAt: active.startedAt,
    }));
  }

  listWorktreeSummaries(sessionId?: string): Array<{
    sessionId: string;
    directoryId: string;
    agent: string;
    state: SessionState;
    mode: SessionAgentMode;
    worktreePath: string;
    stepCount: number;
    lastStepSha: string | null;
    lastStepAt: number | null;
  }> {
    const entries = sessionId
      ? [[sessionId, this.getActiveSession(sessionId)] as const]
      : ([...this.sessions.entries()] as Array<[string, ActiveSession]>);
    return entries.map(([id, active]) => {
      const steps = active.tracker.steps;
      const lastStep = steps[steps.length - 1];
      return {
        sessionId: id,
        directoryId: active.directoryId,
        agent: active.config.agent,
        state: active.session.state,
        mode: this.getSessionMode(id),
        worktreePath: active.worktreePath,
        stepCount: steps.length,
        lastStepSha: lastStep?.sha ?? null,
        lastStepAt: typeof lastStep?.timestamp === 'number' ? lastStep.timestamp : null,
      };
    });
  }

  /** Get diffs for a session. */
  async getSessionDiffs(
    sessionId: string,
  ): Promise<Array<{ step: number; sha: string; diff: string }>> {
    const active = this.getActiveSession(sessionId);
    return active.tracker.getStepDiffs();
  }

  /** Get the total diff across a session. */
  async getSessionSummaryDiff(sessionId: string): Promise<string> {
    const active = this.getActiveSession(sessionId);
    return active.tracker.getSummaryDiff();
  }

  /** Roll back a session to a specific commit. */
  async rollback(sessionId: string, toSha: string): Promise<void> {
    const active = this.getActiveSession(sessionId);
    await active.tracker.rollback(toSha);
    this.eventBus.emit('step:rollback', { sessionId, toSha });
  }

  /** Create a retry branch from a specific commit. */
  async branchRetry(sessionId: string, fromSha: string): Promise<string> {
    const active = this.getActiveSession(sessionId);
    const retryPath = await active.tracker.branchRetry(fromSha);
    this.eventBus.emit('step:branch-retry', { sessionId, fromSha, retryPath });
    return retryPath;
  }

  /** Squash-merge a session's changes into the target branch. */
  async squashMerge(sessionId: string, targetBranch: string, commitMessage: string): Promise<void> {
    const active = this.getActiveSession(sessionId);
    await active.tracker.squashMerge(targetBranch, commitMessage);
    this.eventBus.emit('step:squash-merged', { sessionId, targetBranch });
  }

  /** Check if a session exists. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getSessionWorktreePath(sessionId: string): string {
    return this.getActiveSession(sessionId).worktreePath;
  }

  /** Get the session config (for runtime permission updates). */
  getSessionConfig(sessionId: string): SessionConfig | undefined {
    return this.sessions.get(sessionId)?.config;
  }

  updateSessionConfig(sessionId: string, config: SessionConfig): void {
    const active = this.sessions.get(sessionId);
    if (!active) {
      throw new ViewportError('SESSION_NOT_FOUND', `No active session: ${sessionId}`);
    }
    active.config = config;
  }

  setSessionMode(sessionId: string, mode: SessionAgentMode): void {
    if (!this.sessions.has(sessionId)) {
      throw new ViewportError('SESSION_NOT_FOUND', `No active session: ${sessionId}`);
    }
    this.sessionModes.set(sessionId, mode);
    this.permissionCoordinator.setSessionMode(sessionId, mode);
  }

  getSessionMode(sessionId: string): SessionAgentMode {
    return this.sessionModes.get(sessionId) ?? 'detect';
  }

  /** Gracefully shut down: tear down all active sessions. */
  async shutdown(): Promise<void> {
    const teardowns = [...this.sessions.entries()].map(async ([sessionId, active]) => {
      // Remove event listeners to prevent further event processing during shutdown
      if (active.listeners) {
        active.session.off('message', active.listeners.onMessage);
        active.session.off('state-change', active.listeners.onStateChange);
        active.session.off('ended', active.listeners.onEnded);
      }

      // Reject dangling permissions
      this.permissionCoordinator.rejectPendingPermissions(sessionId);

      try {
        await active.session.kill();
      } catch (err) {
        log.debug({ sessionId, err }, 'Session kill during shutdown (may already be ended)');
      }

      // Flush pending commits before teardown
      try {
        await active.tracker.flushPendingCommits();
      } catch (err) {
        log.warn({ sessionId, err }, 'Tracker flush failed during shutdown');
      }

      try {
        await active.tracker.teardown();
      } catch (err) {
        log.warn({ sessionId, err }, 'Tracker teardown failed during shutdown');
      }
      this.directoryManager.removeSession(active.directoryId, sessionId);
      this.sessionModes.delete(sessionId);
      this.permissionCoordinator.clearSessionMode(sessionId);
    });

    await Promise.all(teardowns);
    this.sessions.clear();
    this.sessionModes.clear();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private getActiveSession(sessionId: string): ActiveSession {
    const active = this.sessions.get(sessionId);
    if (!active) {
      throw new ViewportError('SESSION_NOT_FOUND', `No active session: ${sessionId}`);
    }
    return active;
  }

  private dispatchInitialPrompt(sessionId: string, prompt: string | undefined): void {
    const text = prompt?.trim();
    if (!text) return;

    setImmediate(() => {
      void this.sendInitialPrompt(sessionId, text).catch((err) => {
        log.warn({ sessionId, err }, 'Initial prompt dispatch failed');
      });
    });
  }

  private async sendInitialPrompt(sessionId: string, text: string): Promise<void> {
    const active = this.getActiveSession(sessionId);
    const directory = this.directoryManager.get(active.directoryId);
    const prompt =
      active.config.contextInjection === 'disabled'
        ? text
        : await buildSessionPromptWithContext({
            workingDirectory: directory?.path ?? active.worktreePath,
            prompt: text,
          });
    await this.sendPrompt(sessionId, prompt);
  }

  /**
   * Create and set up a tracker. If GitTracker setup fails (e.g. directory
   * isn't a git repo), falls back to NoopTracker and logs a warning.
   */
  private async setupTracker(
    config: SessionConfig,
    sessionId: string,
    projectPath: string,
  ): Promise<{ tracker: RunTracker; worktreePath: string }> {
    const trackerFactory = this.getTrackerFactory();

    if (config.gitTracker.enabled && trackerFactory) {
      const tracker = trackerFactory(config.gitTracker, sessionId);
      try {
        const worktreePath = await tracker.setup(sessionId, projectPath);
        return { tracker, worktreePath };
      } catch (err) {
        log.warn({ sessionId, projectPath, err }, 'GitTracker setup failed, falling back to noop');
      }
    }

    const noop = new NoopTracker();
    const worktreePath = await noop.setup(sessionId, projectPath);
    return { tracker: noop, worktreePath };
  }

  private wireSessionEvents(sessionId: string, active: ActiveSession): void {
    const { session, tracker } = active;

    const onMessage = (msg: SessionMessage) => {
      this.eventBus.emit('session:message', { sessionId, message: msg });
      tracker.onMessage(msg);
    };

    const onStateChange = (state: SessionState) => {
      this.eventBus.emit('session:state-changed', { sessionId, state });
    };

    const onEnded = async (reason: string) => {
      // Remove listeners first to prevent any further event processing
      session.off('message', onMessage);
      session.off('state-change', onStateChange);
      session.off('ended', onEnded);

      this.sessionEndReasons.set(sessionId, reason);
      this.eventBus.emit('session:ended', { sessionId, reason });

      // Reject any dangling permission promises before teardown
      this.permissionCoordinator.rejectPendingPermissions(sessionId);

      // Flush any pending git commits before teardown
      try {
        await tracker.flushPendingCommits();
      } catch (err) {
        log.warn({ sessionId, err }, 'Tracker flush failed on session end');
      }

      // Teardown tracker
      try {
        await tracker.teardown();
      } catch (err) {
        log.warn({ sessionId, err }, 'Tracker teardown failed on session end');
      }

      // Clean up
      this.sessions.delete(sessionId);
      this.directoryManager.removeSession(active.directoryId, sessionId);
      this.sessionModes.delete(sessionId);
      this.permissionCoordinator.clearSessionMode(sessionId);
      this.eventBus.adjustMaxListeners(this.sessions.size);
    };

    // Store listener references for cleanup on shutdown
    active.listeners = { onMessage, onStateChange, onEnded };

    session.on('message', onMessage);
    session.on('state-change', onStateChange);
    session.on('ended', onEnded);

    // Wire tracker step callback
    tracker.onStepCommitted = (step: Step) => {
      this.eventBus.emit('step:committed', { sessionId, step });
    };
  }
}
