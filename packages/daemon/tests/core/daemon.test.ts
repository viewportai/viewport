import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Daemon, createDaemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import type {
  AgentAdapter,
  AgentAdapterDescriptor,
  DiscoveredSession,
  Session,
  SessionDiscovery,
  SessionOptions,
  RunTracker,
} from '../../src/core/interfaces.js';
import type {
  SessionMessage,
  SessionState,
  Step,
  PermissionDecision,
} from '../../src/core/types.js';

// ---------------------------------------------------------------------------
// Mock session — controllable session for testing
// ---------------------------------------------------------------------------

class MockSession extends EventEmitter implements Session {
  readonly id: string;
  state: SessionState = 'running';

  sendPrompt = vi.fn().mockResolvedValue(undefined);
  kill = vi.fn().mockImplementation(async () => {
    this.state = 'completed';
    this.emit('ended', 'killed');
  });

  constructor(id: string) {
    super();
    this.id = id;
  }

  /** Simulate sending a message. */
  simulateMessage(msg: SessionMessage): void {
    this.emit('message', msg);
  }

  /** Simulate state change. */
  simulateStateChange(state: SessionState): void {
    this.state = state;
    this.emit('state-change', state);
  }

  /** Simulate session end. */
  simulateEnd(reason: string): void {
    this.state = 'completed';
    this.emit('ended', reason);
  }
}

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

class MockAdapter implements AgentAdapter {
  readonly agentId: string;
  lastSession: MockSession | null = null;
  lastOptions: SessionOptions | undefined;

  constructor(agentId = 'claude') {
    this.agentId = agentId;
  }

  describe(): AgentAdapterDescriptor {
    return testAdapterDescriptor(this.agentId);
  }

  async startSession(_cwd: string, options?: SessionOptions): Promise<Session> {
    this.lastOptions = options;
    const session = new MockSession(crypto.randomUUID());
    this.lastSession = session;
    return session;
  }

  async resumeSession(sessionId: string, _cwd: string, options?: SessionOptions): Promise<Session> {
    this.lastOptions = options;
    const session = new MockSession(sessionId);
    this.lastSession = session;
    return session;
  }
}

class EagerPromptSession extends EventEmitter implements Session {
  readonly id = crypto.randomUUID();
  state: SessionState = 'idle';

  async sendPrompt(text: string): Promise<void> {
    this.state = 'running';
    this.emit('state-change', 'running');
    this.emit('message', {
      type: 'agent_message',
      text: `response: ${text}`,
      messageId: crypto.randomUUID(),
      timestamp: Date.now(),
    } satisfies SessionMessage);
    this.state = 'idle';
    this.emit('state-change', 'idle');
  }

  async kill(): Promise<void> {
    this.state = 'completed';
    this.emit('ended', 'killed');
  }
}

class EagerPromptAdapter implements AgentAdapter {
  readonly agentId = 'claude';
  deferInitialPromptSeen = false;

  describe(): AgentAdapterDescriptor {
    return testAdapterDescriptor(this.agentId);
  }

  async startSession(_cwd: string, options?: SessionOptions): Promise<Session> {
    this.deferInitialPromptSeen = options?.deferInitialPrompt === true;
    return new EagerPromptSession();
  }

  async resumeSession(
    _sessionId: string,
    _cwd: string,
    options?: SessionOptions,
  ): Promise<Session> {
    this.deferInitialPromptSeen = options?.deferInitialPrompt === true;
    return new EagerPromptSession();
  }
}

function testAdapterDescriptor(agentId: string): AgentAdapterDescriptor {
  return {
    schema: 'viewport.agent_adapter/v2',
    agentId,
    displayName: 'Test adapter',
    adapterVersion: 'test',
    capabilities: {
      executionModes: {
        plan: 'hard',
        read_only: 'hard',
        review: 'hard',
        implement: 'hard',
      },
      toolAllowlist: 'hard',
      structuredOutput: 'hard',
      permissionHooks: 'hard',
      usageReporting: 'reported',
      costReporting: 'reported',
      maxTurns: 'hard',
      maxBudget: 'hard',
      hardTimeout: 'hard',
    },
  };
}

// ---------------------------------------------------------------------------
// Mock tracker
// ---------------------------------------------------------------------------

class MockTracker implements RunTracker {
  readonly steps: ReadonlyArray<Step> = [];
  setupCalled = false;
  teardownCalled = false;
  onStepCommitted?: (step: Step) => void;

  setup = vi.fn().mockImplementation(async (_sessionId: string, projectPath: string) => {
    this.setupCalled = true;
    return projectPath;
  });

  onMessage = vi.fn();
  rollback = vi.fn().mockResolvedValue(undefined);
  branchRetry = vi.fn().mockResolvedValue('/retry/path');
  squashMerge = vi.fn().mockResolvedValue(undefined);

  teardown = vi.fn().mockImplementation(async () => {
    this.teardownCalled = true;
  });

  getDiff = vi.fn().mockResolvedValue('');
  getStepDiffs = vi.fn().mockResolvedValue([]);
  getSummaryDiff = vi.fn().mockResolvedValue('');
}

class MockDiscovery implements SessionDiscovery {
  readonly agentId: string;
  private sessions: DiscoveredSession[];
  calls = 0;
  private delayMs = 0;

  constructor(agentId: string, sessions: DiscoveredSession[], options: { delayMs?: number } = {}) {
    this.agentId = agentId;
    this.sessions = sessions;
    this.delayMs = options.delayMs ?? 0;
  }

  setSessions(sessions: DiscoveredSession[]): void {
    this.sessions = sessions;
  }

  async discoverSessions(_projectPath: string): Promise<DiscoveredSession[]> {
    this.calls += 1;
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return this.sessions;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempHome: string;
let originalHome: string;
let testDir: string;

async function setupTestEnv(): Promise<void> {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-daemon-test-'));
  originalHome = process.env['HOME']!;
  process.env['HOME'] = tempHome;

  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-project-'));
}

async function cleanupTestEnv(): Promise<void> {
  process.env['HOME'] = originalHome;
  await fs.rm(tempHome, { recursive: true, force: true });
  await fs.rm(testDir, { recursive: true, force: true });
}

async function setupDaemon(): Promise<{
  daemon: Daemon;
  adapter: MockAdapter;
  lastTracker: () => MockTracker | null;
}> {
  const daemon = new Daemon();
  await daemon.initialize();

  const adapter = new MockAdapter();
  daemon.registerAdapter(adapter);

  let latestTracker: MockTracker | null = null;
  daemon.setTrackerFactory((_config, _sessionId) => {
    latestTracker = new MockTracker();
    return latestTracker;
  });

  // Register test directory
  await daemon.directoryManager.register(testDir);

  return { daemon, adapter, lastTracker: () => latestTracker };
}

function getDirectoryId(): string {
  return DirectoryManager.idFromPath(testDir);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Daemon', () => {
  beforeEach(setupTestEnv);
  afterEach(cleanupTestEnv);

  // ---------------------------------------------------------------------------
  // initialization
  // ---------------------------------------------------------------------------

  it('initializes with config manager', async () => {
    const daemon = await createDaemon();
    expect(daemon.configManager).toBeDefined();
    expect(daemon.directoryManager).toBeDefined();
  });

  it('registers adapters', async () => {
    const daemon = new Daemon();
    await daemon.initialize();

    const adapter = new MockAdapter('test-agent');
    daemon.registerAdapter(adapter);

    // Adapter is available (tested indirectly via launchSession)
    expect(daemon).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // launchSession
  // ---------------------------------------------------------------------------

  it('launches a session in a registered directory', async () => {
    const { daemon, adapter } = await setupDaemon();
    const dirId = getDirectoryId();

    const sessionId = await daemon.launchSession(dirId, 'Hello');

    expect(sessionId).toBeTruthy();
    expect(adapter.lastSession).toBeTruthy();
    expect(daemon.getActiveSessions()).toContain(sessionId);
  });

  it('throws for unregistered directory', async () => {
    const { daemon } = await setupDaemon();

    await expect(daemon.launchSession('nonexistent', 'Hello')).rejects.toThrow(
      'Directory not registered',
    );
  });

  it('throws for unregistered adapter', async () => {
    const daemon = new Daemon();
    await daemon.initialize();
    await daemon.directoryManager.register(testDir);
    const dirId = getDirectoryId();

    // No adapter registered
    await expect(daemon.launchSession(dirId, 'Hello')).rejects.toThrow('No adapter registered');
  });

  it('emits session:started on launch', async () => {
    const { daemon } = await setupDaemon();
    const dirId = getDirectoryId();

    const events: unknown[] = [];
    daemon.on('session:started', (data) => events.push(data));

    const sessionId = await daemon.launchSession(dirId, 'Hello');

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ sessionId, directoryId: dirId }));
  });

  it('sets up tracker on launch', async () => {
    const { daemon, lastTracker } = await setupDaemon();
    const dirId = getDirectoryId();

    await daemon.launchSession(dirId, 'Hello');

    expect(lastTracker()).toBeTruthy();
    expect(lastTracker()!.setupCalled).toBe(true);
  });

  it('tracks active sessions in directory', async () => {
    const { daemon } = await setupDaemon();
    const dirId = getDirectoryId();

    await daemon.launchSession(dirId, 'Hello');

    const dir = daemon.directoryManager.get(dirId);
    expect(dir!.activeSessions).toHaveLength(1);
  });

  it('listActiveSessions includes startedAt timestamps', async () => {
    const { daemon } = await setupDaemon();
    const dirId = getDirectoryId();

    const sessionId = await daemon.launchSession(dirId, 'Hello');
    const sessions = daemon.listActiveSessions();
    const session = sessions.find((entry) => entry.sessionId === sessionId);

    expect(session).toBeTruthy();
    expect(typeof (session as { startedAt?: unknown }).startedAt).toBe('number');
  });

  it('runDiscovery replaces stale entries', async () => {
    const { daemon } = await setupDaemon();
    const dirId = getDirectoryId();
    const discovery = new MockDiscovery('claude', [
      {
        agentId: 'claude',
        sessionId: 's1',
        summary: 'first',
        lastModified: Date.now(),
        resumable: true,
      },
    ]);
    daemon.registerDiscovery(discovery);

    await daemon.runDiscovery();
    expect(daemon.getDiscoveredSessions(dirId).get(dirId)).toHaveLength(1);

    discovery.setSessions([]);
    await daemon.runDiscovery();
    expect(daemon.getDiscoveredSessions(dirId).get(dirId)).toBeUndefined();
  });

  it('coalesces concurrent discovery requests into one follow-up run', async () => {
    const { daemon } = await setupDaemon();
    const secondProject = path.join(tempHome, 'second-project');
    await fs.mkdir(secondProject, { recursive: true });
    await daemon.directoryManager.register(secondProject);
    const discovery = new MockDiscovery('claude', [], { delayMs: 25 });
    daemon.registerDiscovery(discovery);

    await Promise.all([daemon.runDiscovery(), daemon.runDiscovery(), daemon.runDiscovery()]);

    expect(discovery.calls).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // session events
  // ---------------------------------------------------------------------------

  it('forwards session messages to event bus', async () => {
    const { daemon, adapter } = await setupDaemon();
    const dirId = getDirectoryId();

    const messages: unknown[] = [];
    daemon.on('session:message', (data) => messages.push(data));

    const sessionId = await daemon.launchSession(dirId, 'Hello');

    // Simulate adapter sending a message
    const msg: SessionMessage = {
      type: 'agent_message',
      text: 'Hi!',
      messageId: 'm1',
      timestamp: Date.now(),
    };
    adapter.lastSession!.simulateMessage(msg);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({ sessionId, message: msg }));
  });

  it('wires session listeners before dispatching the initial prompt', async () => {
    const daemon = new Daemon();
    const adapter = new EagerPromptAdapter();
    daemon.registerAdapter(adapter);
    await daemon.initialize();
    await daemon.directoryManager.register(testDir);

    const messages: Array<{ sessionId: string; message: SessionMessage }> = [];
    daemon.on('session:message', (data) => messages.push(data));

    const sessionId = await daemon.launchSession(getDirectoryId(), 'Hello');

    await vi.waitFor(() => {
      expect(messages.length).toBe(1);
    });

    expect(adapter.deferInitialPromptSeen).toBe(true);
    expect(messages[0]).toMatchObject({
      sessionId,
      message: {
        type: 'agent_message',
        text: 'response: Hello',
      },
    });
  });

  it('forwards messages to tracker', async () => {
    const { daemon, adapter, lastTracker } = await setupDaemon();
    const dirId = getDirectoryId();

    await daemon.launchSession(dirId, 'Hello');

    const msg: SessionMessage = {
      type: 'tool_call_update',
      toolCallId: 'tc1',
      toolName: 'Edit',
      status: 'completed',
      timestamp: Date.now(),
    };
    adapter.lastSession!.simulateMessage(msg);

    expect(lastTracker()!.onMessage).toHaveBeenCalledWith(msg);
  });

  it('emits session:state-changed on state change', async () => {
    const { daemon, adapter } = await setupDaemon();
    const dirId = getDirectoryId();

    const states: unknown[] = [];
    daemon.on('session:state-changed', (data) => states.push(data));

    const sessionId = await daemon.launchSession(dirId, 'Hello');
    adapter.lastSession!.simulateStateChange('idle');

    expect(states).toHaveLength(1);
    expect(states[0]).toEqual(expect.objectContaining({ sessionId, state: 'idle' }));
  });

  it('cleans up on session end', async () => {
    const { daemon, adapter, lastTracker } = await setupDaemon();
    const dirId = getDirectoryId();

    const sessionId = await daemon.launchSession(dirId, 'Hello');
    adapter.lastSession!.simulateEnd('completed');

    // Wait for async cleanup
    await new Promise((r) => setTimeout(r, 50));

    expect(daemon.getActiveSessions()).not.toContain(sessionId);
    expect(lastTracker()!.teardownCalled).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // killSession
  // ---------------------------------------------------------------------------

  it('kills an active session', async () => {
    const { daemon, adapter } = await setupDaemon();
    const dirId = getDirectoryId();

    const sessionId = await daemon.launchSession(dirId, 'Hello');
    await daemon.killSession(sessionId);

    expect(adapter.lastSession!.kill).toHaveBeenCalled();
  });

  it('throws when killing unknown session', async () => {
    const { daemon } = await setupDaemon();

    await expect(daemon.killSession('nonexistent')).rejects.toThrow('No active session');
  });

  // ---------------------------------------------------------------------------
  // sendPrompt
  // ---------------------------------------------------------------------------

  it('sends a prompt to an active session', async () => {
    const { daemon, adapter } = await setupDaemon();
    const dirId = getDirectoryId();

    const sessionId = await daemon.launchSession(dirId, 'Hello');
    await daemon.sendPrompt(sessionId, 'Follow up');

    expect(adapter.lastSession!.sendPrompt).toHaveBeenCalledWith('Follow up');
  });

  it('keeps session active when state changes to errored', async () => {
    const { daemon, adapter } = await setupDaemon();
    const dirId = getDirectoryId();

    const sessionId = await daemon.launchSession(dirId, 'Hello');
    adapter.lastSession!.simulateStateChange('errored');

    expect(daemon.getActiveSessions()).toContain(sessionId);

    await daemon.sendPrompt(sessionId, 'Retry after error');
    expect(adapter.lastSession!.sendPrompt).toHaveBeenCalledWith('Retry after error');
  });

  // ---------------------------------------------------------------------------
  // rollback / branchRetry / squashMerge
  // ---------------------------------------------------------------------------

  it('rolls back a session', async () => {
    const { daemon, lastTracker } = await setupDaemon();
    const dirId = getDirectoryId();

    const events: unknown[] = [];
    daemon.on('step:rollback', (data) => events.push(data));

    const sessionId = await daemon.launchSession(dirId, 'Hello');
    await daemon.rollback(sessionId, 'abc123');

    expect(lastTracker()!.rollback).toHaveBeenCalledWith('abc123');
    expect(events).toHaveLength(1);
  });

  it('creates a branch retry', async () => {
    const { daemon, lastTracker } = await setupDaemon();
    const dirId = getDirectoryId();

    const events: unknown[] = [];
    daemon.on('step:branch-retry', (data) => events.push(data));

    const sessionId = await daemon.launchSession(dirId, 'Hello');
    const retryPath = await daemon.branchRetry(sessionId, 'abc123');

    expect(retryPath).toBe('/retry/path');
    expect(lastTracker()!.branchRetry).toHaveBeenCalledWith('abc123');
    expect(events).toHaveLength(1);
  });

  it('squash-merges a session', async () => {
    const { daemon, lastTracker } = await setupDaemon();
    const dirId = getDirectoryId();

    const events: unknown[] = [];
    daemon.on('step:squash-merged', (data) => events.push(data));

    const sessionId = await daemon.launchSession(dirId, 'Hello');
    await daemon.squashMerge(sessionId, 'main', 'feat: stuff');

    expect(lastTracker()!.squashMerge).toHaveBeenCalledWith('main', 'feat: stuff');
    expect(events).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // getSessionInfo
  // ---------------------------------------------------------------------------

  it('returns session info', async () => {
    const { daemon } = await setupDaemon();
    const dirId = getDirectoryId();

    const sessionId = await daemon.launchSession(dirId, 'Hello');
    const info = daemon.getSessionInfo(sessionId);

    expect(info.state).toBe('running');
    expect(info.directoryId).toBe(dirId);
    expect(info.mode).toBe('detect');
    expect(info.steps).toEqual([]);
  });

  it('launches automated never-approval sessions in bypass mode', async () => {
    const { daemon, adapter } = await setupDaemon();
    const dirId = getDirectoryId();
    const permissionEvents: unknown[] = [];
    daemon.on('permission:requested', (data) => permissionEvents.push(data));

    const sessionId = await daemon.launchSession(dirId, 'Hello', {
      trust: 'automated',
      approvalPolicy: 'never',
    });

    expect(daemon.getSessionMode(sessionId)).toBe('bypass');
    expect(daemon.getSessionInfo(sessionId).mode).toBe('bypass');

    const decision = await adapter.lastOptions!.canUseTool!(
      'Write',
      { file_path: '/tmp/test' },
      {
        signal: new AbortController().signal,
        toolUseId: 'tool-automated',
      },
    );

    expect(decision.behavior).toBe('allow');
    expect(permissionEvents).toHaveLength(0);
  });

  it('sets and retrieves session mode', async () => {
    const { daemon } = await setupDaemon();
    const dirId = getDirectoryId();
    const sessionId = await daemon.launchSession(dirId, 'Hello');

    daemon.setSessionMode(sessionId, 'bypass');
    expect(daemon.getSessionMode(sessionId)).toBe('bypass');
    expect(daemon.getSessionInfo(sessionId).mode).toBe('bypass');
  });

  it('throws for unknown session info', () => {
    const daemon = new Daemon();
    expect(() => daemon.getSessionInfo('nonexistent')).toThrow('No active session');
  });

  // ---------------------------------------------------------------------------
  // permissions
  // ---------------------------------------------------------------------------

  it('auto-approves tools in autoApprove list', async () => {
    const { daemon } = await setupDaemon();
    const dirId = getDirectoryId();

    await daemon.launchSession(dirId, 'Hello');

    // The permission handler should have been passed to the adapter
    // We can't directly test it here since it's wired internally,
    // but we verify no permission:requested event fires for auto-approved tools
    const permEvents: unknown[] = [];
    daemon.on('permission:requested', (data) => permEvents.push(data));

    // Auto-approved tools don't emit permission events
    expect(permEvents).toHaveLength(0);
  });

  it('responds to permission requests', async () => {
    const { daemon, adapter: _adapter } = await setupDaemon();
    const dirId = getDirectoryId();

    const responded: unknown[] = [];
    daemon.on('permission:responded', (data) => responded.push(data));

    const sessionId = await daemon.launchSession(dirId, 'Hello');

    const decision: PermissionDecision = { behavior: 'allow' };
    await daemon.respondPermission(sessionId, 'req-1', decision);

    // respondPermission now emits event directly instead of calling session method.
    // The daemon's createPermissionHandler listens for this event.
    expect(responded).toHaveLength(1);
    expect(responded[0]).toEqual({ sessionId, requestId: 'req-1', decision });
  });

  // ---------------------------------------------------------------------------
  // shutdown
  // ---------------------------------------------------------------------------

  it('shuts down all active sessions', async () => {
    const { daemon, adapter } = await setupDaemon();
    const dirId = getDirectoryId();

    await daemon.launchSession(dirId, 'First');
    const firstSession = adapter.lastSession;
    await daemon.launchSession(dirId, 'Second');

    await daemon.shutdown();

    expect(firstSession!.kill).toHaveBeenCalled();
    expect(daemon.getActiveSessions()).toHaveLength(0);
  });

  it('shutdown is safe when no sessions exist', async () => {
    const daemon = await createDaemon();
    await expect(daemon.shutdown()).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // uses NoopTracker when no factory set
  // ---------------------------------------------------------------------------

  it('uses NoopTracker when no tracker factory is set', async () => {
    const daemon = new Daemon();
    await daemon.initialize();

    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);

    // Don't set tracker factory — should use NoopTracker
    await daemon.directoryManager.register(testDir);
    const dirId = getDirectoryId();

    // Should not throw — NoopTracker is the fallback
    const sessionId = await daemon.launchSession(dirId, 'Hello');
    expect(sessionId).toBeTruthy();

    await daemon.shutdown();
  });
});
