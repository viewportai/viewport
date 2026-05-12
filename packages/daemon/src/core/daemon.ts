/**
 * Daemon — the orchestrator that wires everything together.
 *
 * Manages adapters, trackers, permissions, sessions, and directories.
 * All external-facing operations go through this class. Internal modules
 * communicate via the typed event bus.
 *
 * Session lifecycle is delegated to SessionManager.
 * Permission handling is delegated to PermissionCoordinator.
 */

import type {
  AgentAdapter,
  DiscoveredSession,
  RunTrackerFactory,
  SessionDiscovery,
} from './interfaces.js';
import type { ModelInfo } from './agent-registry.js';
import type {
  PendingPermissionRequest,
  SessionAgentMode,
  SessionConfig,
  SessionState,
  PermissionDecision,
  Step,
} from './types.js';
import { TypedEventEmitter } from './events.js';
import type { DaemonEvents } from './events.js';
import { ConfigManager } from './config.js';
import { DirectoryManager } from '../directories/manager.js';
import { SessionManager } from './session-manager.js';
import { PermissionCoordinator } from './permission-coordinator.js';
import { logger } from './logger.js';
import { discoverDirectorySessions } from './session-discovery-runner.js';
import { WorkflowRunner } from '../workflows/runner.js';
import { WorkflowSessionLinkStore } from '../workflows/session-links.js';
import {
  EphemeralPlanDraftStore,
  type EphemeralPlanDraft,
} from '../hooks/ephemeral-plan-drafts.js';

const log = logger.child({ module: 'daemon' });

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

export class Daemon extends TypedEventEmitter<DaemonEvents> {
  readonly configManager: ConfigManager;
  readonly directoryManager: DirectoryManager;
  readonly workflowRunner: WorkflowRunner;

  private adapters = new Map<string, AgentAdapter>();
  private discoveries = new Map<string, SessionDiscovery>();
  private trackerFactory: RunTrackerFactory | null = null;
  private modelProvider: (() => ModelInfo[] | Promise<ModelInfo[]>) | null = null;

  private readonly permissionCoordinator: PermissionCoordinator;
  private readonly sessionManager: SessionManager;
  private readonly workflowSessionLinks = new WorkflowSessionLinkStore();
  private readonly ephemeralPlanDrafts = new EphemeralPlanDraftStore();
  private discoveryRunPromise: Promise<void> | null = null;
  private discoveryRerunRequested = false;

  /**
   * Discovered sessions from JSONL files, keyed by directoryId.
   * These are historical sessions not launched by the daemon.
   */
  private discoveredSessions = new Map<string, DiscoveredSession[]>();

  constructor() {
    super();
    this.configManager = new ConfigManager();
    this.directoryManager = new DirectoryManager(this.configManager);
    this.permissionCoordinator = new PermissionCoordinator(this);
    this.sessionManager = new SessionManager(
      this,
      this.configManager,
      this.directoryManager,
      this.permissionCoordinator,
      this.adapters,
      () => this.trackerFactory,
    );
    this.workflowRunner = new WorkflowRunner(this);
  }

  /** Register an agent adapter (e.g. ClaudeAdapter). */
  registerAdapter(adapter: AgentAdapter): void {
    this.adapters.set(adapter.agentId, adapter);
  }

  /** Register a session discovery provider (e.g. ClaudeDiscovery). */
  registerDiscovery(discovery: SessionDiscovery): void {
    this.discoveries.set(discovery.agentId, discovery);
  }

  /** Set the factory used to create RunTrackers for new sessions. */
  setTrackerFactory(factory: RunTrackerFactory): void {
    this.trackerFactory = factory;
  }

  /** Set the provider used to resolve runtime model availability. */
  setModelProvider(provider: () => ModelInfo[] | Promise<ModelInfo[]>): void {
    this.modelProvider = provider;
  }

  /** Initialize the daemon — loads config from disk. */
  async initialize(): Promise<void> {
    await this.configManager.load();
    // Load workflow plugins from `~/.viewport/plugins.json` before resuming
    // pending runs so any custom node types in those runs have an executor
    // registered when the runner picks them back up.
    const { loadPlugins } = await import('../workflows/plugin-loader.js');
    await loadPlugins();
    // Resume any workflow runs that were running when we last shut down.
    // Failures during resume are logged onto the run record; never block the
    // daemon from coming online.
    void this.workflowRunner.resumePendingRuns().catch(() => undefined);
  }

  /**
   * Run discovery for all registered directories.
   * Finds existing sessions from agent-specific sources (e.g. ~/.claude/projects/).
   */
  async runDiscovery(): Promise<void> {
    if (this.discoveryRunPromise) {
      this.discoveryRerunRequested = true;
      return this.discoveryRunPromise;
    }

    this.discoveryRunPromise = this.runDiscoveryLoop();
    try {
      await this.discoveryRunPromise;
    } finally {
      this.discoveryRunPromise = null;
    }
  }

  private async runDiscoveryLoop(): Promise<void> {
    do {
      this.discoveryRerunRequested = false;
      await this.runDiscoveryOnce();
    } while (this.discoveryRerunRequested);
  }

  private async runDiscoveryOnce(): Promise<void> {
    const directories = this.directoryManager.list();

    log.debug(
      {
        directories: directories.length,
        discoveries: this.discoveries.size,
        agents: [...this.discoveries.keys()],
      },
      'Starting discovery run',
    );

    const nextDiscovered = await discoverDirectorySessions({
      directories,
      discoveries: this.discoveries,
      links: this.workflowSessionLinks,
      log,
    });

    // Replace atomically so stale entries are removed when sessions disappear.
    this.discoveredSessions = nextDiscovered;
    log.debug(
      {
        directoriesWithSessions: nextDiscovered.size,
        totalSessions: [...nextDiscovered.values()].reduce(
          (sum, sessions) => sum + sessions.length,
          0,
        ),
      },
      'Discovery run complete',
    );
  }

  /** Get discovered sessions for a directory. */
  getDiscoveredSessions(directoryId?: string): Map<string, DiscoveredSession[]> {
    if (directoryId) {
      const sessions = this.discoveredSessions.get(directoryId);
      const result = new Map<string, DiscoveredSession[]>();
      if (sessions) result.set(directoryId, sessions);
      return result;
    }
    return new Map(this.discoveredSessions);
  }

  /** Get available agent IDs from registered adapters. */
  getAvailableAgents(): string[] {
    return [...this.adapters.keys()];
  }

  /** Get available model IDs from the registered agent registry, when known. */
  async getAvailableModels(): Promise<ModelInfo[]> {
    if (!this.modelProvider) return [];
    return this.modelProvider();
  }

  // ---------------------------------------------------------------------------
  // Session operations — delegated to SessionManager
  // ---------------------------------------------------------------------------

  /** Launch a new agent session in a registered directory. */
  async launchSession(
    directoryId: string,
    prompt: string,
    overrides?: Partial<SessionConfig>,
  ): Promise<string> {
    return this.sessionManager.launchSession(directoryId, prompt, overrides);
  }

  /** Resume a discovered session via the adapter's resume support. */
  async resumeSession(
    originalSessionId: string,
    directoryId: string,
    prompt?: string,
    overrides?: Partial<SessionConfig>,
  ): Promise<string> {
    return this.sessionManager.resumeSession(originalSessionId, directoryId, prompt, overrides);
  }

  /** Kill an active session. */
  async killSession(sessionId: string): Promise<void> {
    return this.sessionManager.killSession(sessionId);
  }

  /** Roll back a session to a specific commit. */
  async rollback(sessionId: string, toSha: string): Promise<void> {
    return this.sessionManager.rollback(sessionId, toSha);
  }

  /** Create a retry branch from a specific commit. */
  async branchRetry(sessionId: string, fromSha: string): Promise<string> {
    return this.sessionManager.branchRetry(sessionId, fromSha);
  }

  /** Squash-merge a session's changes into the target branch. */
  async squashMerge(sessionId: string, targetBranch: string, commitMessage: string): Promise<void> {
    return this.sessionManager.squashMerge(sessionId, targetBranch, commitMessage);
  }

  /** Send a follow-up prompt to a session. */
  async sendPrompt(sessionId: string, text: string): Promise<void> {
    return this.sessionManager.sendPrompt(sessionId, text);
  }

  /** Get all active session IDs. */
  getActiveSessions(): string[] {
    return this.sessionManager.getActiveSessions();
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
    return this.sessionManager.getSessionInfo(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessionManager.hasSession(sessionId);
  }

  getSessionWorktreePath(sessionId: string): string {
    return this.sessionManager.getSessionWorktreePath(sessionId);
  }

  getSessionNativeId(sessionId: string): string {
    return this.sessionManager.getSessionNativeId(sessionId);
  }

  listActiveSessions(): Array<{
    sessionId: string;
    directoryId: string;
    resourceId?: string;
    agent: string;
    state: SessionState;
    mode: SessionAgentMode;
    startedAt: number;
  }> {
    return this.sessionManager.listSessionSummaries();
  }

  listWorktrees(sessionId?: string): Array<{
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
    return this.sessionManager.listWorktreeSummaries(sessionId);
  }

  /** Get diffs for a session. */
  async getSessionDiffs(
    sessionId: string,
  ): Promise<Array<{ step: number; sha: string; diff: string }>> {
    return this.sessionManager.getSessionDiffs(sessionId);
  }

  /** Get the total diff across a session. */
  async getSessionSummaryDiff(sessionId: string): Promise<string> {
    return this.sessionManager.getSessionSummaryDiff(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Permission operations — delegated to PermissionCoordinator
  // ---------------------------------------------------------------------------

  /** Respond to a pending permission request. */
  async respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    this.permissionCoordinator.respondPermissionForSession(
      sessionId,
      requestId,
      decision,
      this.sessionManager.hasSession(sessionId),
    );
  }

  /** Add a tool to a session's auto-approve list (for "always allow"). */
  addAutoApprove(sessionId: string, toolName: string): void {
    const config = this.sessionManager.getSessionConfig(sessionId);
    if (config) {
      const next = this.permissionCoordinator.addAutoApprove(config, toolName);
      if (next !== config) {
        this.sessionManager.updateSessionConfig(sessionId, next);
      }
    }
  }

  /** Get the tool name for a pending permission request. */
  getRequestToolName(requestId: string): string | undefined {
    return this.permissionCoordinator.getRequestToolName(requestId);
  }

  listPendingPermissions(sessionId?: string): PendingPermissionRequest[] {
    return this.permissionCoordinator.listPendingPermissions(sessionId);
  }

  setSessionMode(sessionId: string, mode: SessionAgentMode): void {
    this.sessionManager.setSessionMode(sessionId, mode);
  }

  getSessionMode(sessionId: string): SessionAgentMode {
    return this.sessionManager.getSessionMode(sessionId);
  }

  createEphemeralPlanDraft(
    workspaceId: string,
    event: DaemonEvents['hook:plan-proposed'],
  ): EphemeralPlanDraft {
    return this.ephemeralPlanDrafts.create(workspaceId, event);
  }

  getEphemeralPlanDraft(draftId: string): EphemeralPlanDraft | null {
    return this.ephemeralPlanDrafts.get(draftId);
  }

  deleteEphemeralPlanDraft(draftId: string): void {
    this.ephemeralPlanDrafts.delete(draftId);
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /** Gracefully shut down: tear down all active sessions. */
  async shutdown(): Promise<void> {
    return this.sessionManager.shutdown();
  }
}

/** Convenience: create and initialize a Daemon with defaults. */
export async function createDaemon(): Promise<Daemon> {
  const daemon = new Daemon();
  await daemon.initialize();
  return daemon;
}
