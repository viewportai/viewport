/**
 * GeminiCliAdapter — non-PTY Gemini CLI integration.
 *
 * Uses explicit CLI flags (`-i`, `--resume`) instead of terminal emulation.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AgentAdapter, Session, SessionOptions } from '../core/interfaces.js';
import type { SessionMessage, SessionState } from '../core/types.js';
import { logger } from '../core/logger.js';
import { metrics } from '../core/metrics.js';

const log = logger.child({ module: 'gemini-cli-adapter' });

export class GeminiCliSession extends EventEmitter implements Session {
  readonly id: string;
  state: SessionState = 'starting';

  private readonly cwd: string;
  private readonly model?: string;
  private resumeSessionId?: string;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly runCommand: GeminiCommandRunner;

  constructor(params: {
    id: string;
    cwd: string;
    model?: string;
    resumeSessionId?: string;
    runCommand?: GeminiCommandRunner;
  }) {
    super();
    this.id = params.id;
    this.cwd = params.cwd;
    this.model = params.model;
    this.resumeSessionId = params.resumeSessionId;
    this.runCommand = params.runCommand ?? runGeminiCommand;
  }

  async start(initialPrompt: string): Promise<void> {
    this.setState('running');
    if (!initialPrompt.trim()) {
      this.setState('idle');
      return;
    }
    await this.sendPrompt(initialPrompt);
  }

  async sendPrompt(text: string): Promise<void> {
    if (this.stopped) throw new Error('Session already ended');

    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      this.setState('running');
      this.emitMessage({
        type: 'user_message',
        text,
        messageId: randomUUID(),
        timestamp: Date.now(),
      });

      const { output, sessionId } = await this.runCommand({
        cwd: this.cwd,
        model: this.model,
        prompt: text,
        resumeSessionId: this.resumeSessionId,
      });
      if (sessionId) this.resumeSessionId = sessionId;

      if (output.trim()) {
        const messageId = randomUUID();
        this.emitMessage({
          type: 'agent_message',
          text: output,
          messageId,
          timestamp: Date.now(),
        });
      }
      this.setState('idle');
    });

    try {
      await this.queue;
    } catch (err) {
      metrics.increment('sessions.errors');
      this.setState('errored');
      this.emit('ended', `error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async kill(): Promise<void> {
    this.stopped = true;
    this.setState('completed');
    this.emit('ended', 'killed');
  }

  private emitMessage(msg: SessionMessage): void {
    this.emit('message', msg);
  }

  private setState(next: SessionState): void {
    this.state = next;
    this.emit('state-change', next);
  }
}

export class GeminiCliAdapter implements AgentAdapter {
  readonly agentId = 'gemini';
  constructor(private readonly runCommand: GeminiCommandRunner = runGeminiCommand) {}

  async startSession(cwd: string, options?: SessionOptions): Promise<Session> {
    metrics.increment('sessions.gemini.started');
    const id = randomUUID();
    const session = new GeminiCliSession({
      id,
      cwd,
      model: options?.model,
      runCommand: this.runCommand,
    });
    await session.start(options?.initialPrompt ?? '');
    return session;
  }

  async resumeSession(sessionId: string, cwd: string, options?: SessionOptions): Promise<Session> {
    metrics.increment('sessions.gemini.resumed');
    const session = new GeminiCliSession({
      id: sessionId,
      cwd,
      model: options?.model,
      resumeSessionId: sessionId,
      runCommand: this.runCommand,
    });
    await session.start(options?.initialPrompt ?? 'Continue.');
    return session;
  }
}

interface GeminiCommandParams {
  cwd: string;
  model?: string;
  prompt: string;
  resumeSessionId?: string;
}

type GeminiCommandRunner = (
  params: GeminiCommandParams,
) => Promise<{ output: string; sessionId?: string }>;

async function runGeminiCommand(params: GeminiCommandParams): Promise<{
  output: string;
  sessionId?: string;
}> {
  const args = ['-i', params.prompt];
  if (params.model) args.push('--model', params.model);
  if (params.resumeSessionId) args.push('--resume', params.resumeSessionId);

  const child = spawn('gemini', args, {
    cwd: params.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });

  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `gemini exited ${exitCode}`;
    throw new Error(detail);
  }

  const detectedSessionId = detectSessionId(stdout);
  const output = cleanOutput(stdout);
  log.debug({ detectedSessionId, outputLen: output.length }, 'gemini command completed');

  return { output, sessionId: detectedSessionId };
}

function cleanOutput(raw: string): string {
  return raw.replace(/\r/g, '').trim();
}

function detectSessionId(raw: string): string | undefined {
  // Prefer machine-readable lines first.
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const candidate = parsed['sessionId'] ?? parsed['session_id'] ?? parsed['id'];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  // Fallback for plain-text output.
  const match = raw.match(/session(?:\s+id)?\s*[:=]\s*([A-Za-z0-9._:-]+)/i);
  return match?.[1];
}
