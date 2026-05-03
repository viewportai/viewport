import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import type {
  AgentAdapter,
  DiscoveredSession,
  Session,
  SessionDiscovery,
  SessionOptions,
} from '../../../src/core/interfaces.js';
import type { SessionMessage, SessionState } from '../../../src/core/types.js';

interface PromptBehavior {
  autoReply?: boolean;
  replyPrefix?: string;
}

export class FakeSession extends EventEmitter implements Session {
  readonly id: string;
  state: SessionState = 'running';

  private messageCounter = 0;
  private promptBehavior: Required<PromptBehavior>;

  constructor(id: string, behavior?: PromptBehavior) {
    super();
    this.id = id;
    this.promptBehavior = {
      autoReply: behavior?.autoReply ?? true,
      replyPrefix: behavior?.replyPrefix ?? 'ack',
    };
  }

  async sendPrompt(text: string): Promise<void> {
    this.emitMessage({
      type: 'user_message',
      text,
      messageId: `${this.id}-user-${++this.messageCounter}`,
      timestamp: Date.now(),
    });

    if (!this.promptBehavior.autoReply) {
      return;
    }

    queueMicrotask(() => {
      this.emitMessage({
        type: 'agent_message',
        text: `${this.promptBehavior.replyPrefix}: ${text}`,
        messageId: `${this.id}-agent-${++this.messageCounter}`,
        timestamp: Date.now(),
      });
    });
  }

  async kill(): Promise<void> {
    this.state = 'completed';
    this.emit('state-change', this.state);
    this.emit('ended', 'killed');
  }

  emitMessage(message: SessionMessage): void {
    this.emit('message', message);
  }
}

export class FakeAdapter implements AgentAdapter {
  readonly agentId: string;

  private readonly sessions = new Map<string, FakeSession>();
  private readonly promptBehavior: PromptBehavior;
  private latestSessionId: string | null = null;

  constructor(agentId: string, behavior?: PromptBehavior) {
    this.agentId = agentId;
    this.promptBehavior = behavior ?? {};
  }

  async startSession(_cwd: string, options?: SessionOptions): Promise<Session> {
    const session = new FakeSession(crypto.randomUUID(), this.promptBehavior);
    this.sessions.set(session.id, session);
    this.latestSessionId = session.id;
    const initialPrompt = options?.deferInitialPrompt ? '' : (options?.initialPrompt?.trim() ?? '');
    if (initialPrompt.length > 0) {
      setTimeout(() => {
        void session.sendPrompt(initialPrompt);
      }, 0);
    }
    return session;
  }

  async resumeSession(sessionId: string, _cwd: string, options?: SessionOptions): Promise<Session> {
    const session = new FakeSession(sessionId, this.promptBehavior);
    this.sessions.set(session.id, session);
    this.latestSessionId = session.id;
    const initialPrompt = options?.deferInitialPrompt ? '' : (options?.initialPrompt?.trim() ?? '');
    if (initialPrompt.length > 0) {
      setTimeout(() => {
        void session.sendPrompt(initialPrompt);
      }, 0);
    }
    return session;
  }

  getSession(sessionId: string): FakeSession | undefined {
    return this.sessions.get(sessionId);
  }

  getLatestSession(): FakeSession | undefined {
    if (!this.latestSessionId) return undefined;
    return this.sessions.get(this.latestSessionId);
  }
}

export class StaticDiscovery implements SessionDiscovery {
  readonly agentId: string;

  private readonly sessionsByProject = new Map<string, DiscoveredSession[]>();

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  setProjectSessions(projectPath: string, sessions: DiscoveredSession[]): void {
    this.sessionsByProject.set(projectPath, sessions);
  }

  async discoverSessions(projectPath: string): Promise<DiscoveredSession[]> {
    return this.sessionsByProject.get(projectPath) ?? [];
  }
}
