/**
 * PTY Adapter — spawn any CLI agent in a pseudo-terminal.
 *
 * Tier 2 integration: terminal I/O streaming, basic state detection,
 * but no structured tool calls, permissions, or token usage.
 *
 * This is how Viewport gets breadth — any CLI tool can be supervised.
 * SDK adapters (Claude, Codex) get depth; PTY adapters get breadth.
 */

import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentAdapter, Session, SessionOptions } from '../core/interfaces.js';
import type { SessionState } from '../core/types.js';
import { metrics } from '../core/metrics.js';

// ---------------------------------------------------------------------------
// PTY Session — wraps a child process as a Session
// ---------------------------------------------------------------------------

export class PtySession extends EventEmitter implements Session {
  readonly id: string;
  state: SessionState = 'starting';

  private process: ChildProcess | null = null;
  private currentMessageId: string;
  private outputBuffer = '';
  private readonly maxOutputBufferBytes: number;

  constructor(id: string, maxOutputBufferBytes = 1_048_576) {
    super();
    this.id = id;
    this.currentMessageId = crypto.randomUUID();
    this.maxOutputBufferBytes = maxOutputBufferBytes;
  }

  /**
   * Start the CLI process.
   */
  start(command: string, args: string[], cwd: string, env?: Record<string, string>): void {
    metrics.increment('sessions.pty.launched');
    this.process = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      shell: false,
    });

    this.setState('running');

    // Stream stdout as agent messages
    this.process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8');
      this.appendOutput(text);

      this.emit('message', {
        type: 'agent_message_chunk',
        messageId: this.currentMessageId,
        text,
        timestamp: Date.now(),
      });
    });

    // Stream stderr as agent messages too (many CLI tools use stderr)
    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString('utf-8');
      this.appendOutput(text);

      this.emit('message', {
        type: 'agent_message_chunk',
        messageId: this.currentMessageId,
        text,
        timestamp: Date.now(),
      });
    });

    this.process.on('close', (code) => {
      // Emit final message
      if (this.outputBuffer.length > 0) {
        this.emit('message', {
          type: 'agent_message',
          messageId: this.currentMessageId,
          text: this.outputBuffer,
          timestamp: Date.now(),
        });
      }

      const reason = code === 0 ? 'completed' : `exited with code ${code}`;
      this.setState(code === 0 ? 'completed' : 'errored');
      this.emit('ended', reason);
      this.process = null;
    });

    this.process.on('error', (err) => {
      this.setState('errored');
      this.emit('message', {
        type: 'system_status',
        sessionId: this.id,
        status: `Process error: ${err.message}`,
        timestamp: Date.now(),
      });
      this.emit('ended', `error: ${err.message}`);
      this.process = null;
    });
  }

  /**
   * Send text to the process stdin (follow-up prompt).
   */
  async sendPrompt(text: string): Promise<void> {
    if (!this.process?.stdin?.writable) {
      throw new Error('Process stdin not available');
    }

    // New message for the response
    this.currentMessageId = crypto.randomUUID();
    this.outputBuffer = '';

    // Emit as user message
    this.emit('message', {
      type: 'user_message',
      messageId: crypto.randomUUID(),
      text,
      timestamp: Date.now(),
    });

    // Write to stdin
    this.process.stdin.write(text + '\n');
  }

  /**
   * Kill the process.
   */
  async kill(): Promise<void> {
    if (!this.process) return;

    const proc = this.process;
    this.process = null;

    // Close stdin to unblock readers
    try {
      proc.stdin?.destroy();
    } catch {
      // Already closed
    }

    // Destroy stdout/stderr to prevent hanging on piped data
    try {
      proc.stdout?.destroy();
      proc.stderr?.destroy();
    } catch {
      // Already closed
    }

    // Send SIGKILL directly (SIGTERM is unreliable with piped stdio)
    try {
      proc.kill('SIGKILL');
    } catch {
      // Already dead
    }

    // Update state immediately — don't wait for 'close' which may not fire
    this.setState('errored');
    this.emit('ended', 'killed');
  }

  private setState(newState: SessionState): void {
    this.state = newState;
    this.emit('state-change', newState);
  }

  private appendOutput(text: string): void {
    this.outputBuffer += text;
    const overflow = Buffer.byteLength(this.outputBuffer, 'utf-8') - this.maxOutputBufferBytes;
    if (overflow > 0) {
      // Keep the most recent output to cap memory usage in long-running PTY sessions.
      this.outputBuffer = this.outputBuffer.slice(Math.min(this.outputBuffer.length, overflow));
    }
  }
}

// ---------------------------------------------------------------------------
// PTY Adapter — factory for PTY sessions
// ---------------------------------------------------------------------------

export interface PtyAdapterOptions {
  /** Default arguments to pass to the CLI. */
  defaultArgs?: string[];
  /** Environment variables to set. */
  env?: Record<string, string>;
  /** How to pass the initial prompt. 'positional' | 'stdin' | flag name. */
  promptMode?: 'positional' | 'stdin' | string;
  /** Arguments that precede the session ID for resume commands (e.g. ['--resume']). */
  resumeArgs?: string[];
  /** Max bytes retained in the PTY output buffer for final snapshot message. */
  maxOutputBufferBytes?: number;
}

export class PtyAdapter implements AgentAdapter {
  readonly agentId: string;
  private command: string;
  private options: PtyAdapterOptions;

  constructor(agentId: string, command: string, options?: PtyAdapterOptions) {
    this.agentId = agentId;
    this.command = command;
    this.options = options ?? {};
  }

  async startSession(cwd: string, options?: SessionOptions): Promise<Session> {
    const sessionId = crypto.randomUUID();
    const session = new PtySession(sessionId, this.options.maxOutputBufferBytes);

    const args = [...(this.options.defaultArgs ?? [])];

    // Add initial prompt based on mode
    const initialPrompt = options?.deferInitialPrompt ? undefined : options?.initialPrompt;
    if (initialPrompt) {
      const mode = this.options.promptMode ?? 'positional';
      if (mode === 'positional') {
        args.push(initialPrompt);
      } else if (mode === 'stdin') {
        // Will be sent after process starts
      } else {
        // Flag mode: --flag "prompt"
        args.push(mode, initialPrompt);
      }
    }

    session.start(this.command, args, cwd, this.options.env);

    // For stdin mode, send prompt after process starts
    if (this.options.promptMode === 'stdin' && initialPrompt) {
      // Small delay for the process to be ready
      setTimeout(() => {
        session.sendPrompt(initialPrompt).catch(() => {
          // Process may have exited quickly
        });
      }, 100);
    }

    return session;
  }

  async resumeSession(sessionId: string, cwd: string, options?: SessionOptions): Promise<Session> {
    if (!this.options.resumeArgs || this.options.resumeArgs.length === 0) {
      // PTY sessions can't truly resume for adapters without explicit resume flags.
      return this.startSession(cwd, options);
    }

    const resumed = new PtySession(crypto.randomUUID(), this.options.maxOutputBufferBytes);
    const args = [...(this.options.defaultArgs ?? []), ...this.options.resumeArgs, sessionId];

    const initialPrompt = options?.deferInitialPrompt ? undefined : options?.initialPrompt;
    if (initialPrompt) {
      const mode = this.options.promptMode ?? 'positional';
      if (mode === 'positional') {
        args.push(initialPrompt);
      } else if (mode !== 'stdin') {
        args.push(mode, initialPrompt);
      }
    }

    resumed.start(this.command, args, cwd, this.options.env);

    if (this.options.promptMode === 'stdin' && initialPrompt) {
      setTimeout(() => {
        resumed.sendPrompt(initialPrompt).catch(() => {
          // Process may have exited quickly
        });
      }, 100);
    }

    return resumed;
  }
}
