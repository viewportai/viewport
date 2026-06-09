/**
 * CodexAdapter — bridges OpenAI Codex SDK threads with the Viewport daemon.
 *
 * This integration intentionally stays loose at the SDK boundary (unknown payload
 * shapes) so daemon builds remain stable as SDK response schemas evolve.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentAdapter,
  AgentAdapterDescriptor,
  Session,
  SessionOptions,
} from '../core/interfaces.js';
import type { SessionMessage, SessionState } from '../core/types.js';
import { metrics } from '../core/metrics.js';
import { importCodexSdkModule } from './codex-sdk-loader.js';
import { DEFAULT_CODEX_MODEL } from '../agents/codex-defaults.js';
import {
  extractEventsStream,
  extractStreamError,
  extractStreamText,
  extractText,
  extractTokenUsageEvent,
  extractToolCallEvent,
  extractToolCallUpdateEvent,
  shouldFallbackToLegacyRun,
} from './codex-event-normalizers.js';

const MAX_IDENTICAL_CODEX_TOOL_CALLS = 8;
const MAX_CODEX_TOOL_CALLS_PER_TURN = 32;
const CODEX_RUNAWAY_GUARD_POLL_MS = 250;

interface CodexThread {
  id?: string;
  run?: (input: unknown, turnOptions?: Record<string, unknown>) => Promise<unknown>;
  runStreamed?: (
    input: unknown,
    turnOptions?: Record<string, unknown>,
  ) => Promise<unknown> | AsyncIterable<unknown>;
}

interface CodexClient {
  startThread: (params?: Record<string, unknown>) => CodexThread | Promise<CodexThread>;
  resumeThread?: (
    threadId: string,
    params?: Record<string, unknown>,
  ) => CodexThread | Promise<CodexThread>;
  getThread?: (threadId: string) => CodexThread | Promise<CodexThread>;
}

type CodexClientFactory = (apiKey?: string) => Promise<CodexClient>;
type CodexThreadProvider = CodexThread | (() => Promise<CodexThread>);

async function defaultClientFactory(apiKey?: string): Promise<CodexClient> {
  const loaded = await importCodexSdkModule();
  if (!loaded?.module.Codex) {
    throw new Error(
      'Codex SDK import failed: install @openai/codex-sdk@latest (or @openai/codex@latest)',
    );
  }
  const codexPathOverride = resolveCodexPathOverride();
  const resolvedApiKey = resolveCodexApiKey(apiKey);
  return new loaded.module.Codex({
    ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
    ...(codexPathOverride ? { codexPathOverride } : {}),
    config: {
      model: DEFAULT_CODEX_MODEL,
    },
  });
}

export function resolveCodexPathOverride(env: NodeJS.ProcessEnv = process.env): string {
  if (env['CODEX_CLI_PATH']) {
    return env['CODEX_CLI_PATH'];
  }

  const desktopPath = '/Applications/Codex.app/Contents/Resources/codex';
  if (existsSync(desktopPath)) {
    return desktopPath;
  }

  return 'codex';
}

export function resolveCodexApiKey(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (explicit && explicit.trim()) return explicit;
  const codexKey = env['CODEX_API_KEY'];
  if (codexKey && codexKey.trim()) return codexKey;
  const openAiKey = env['OPENAI_API_KEY'];
  if (openAiKey && openAiKey.trim()) return openAiKey;
  return undefined;
}

export class CodexSession extends EventEmitter implements Session {
  readonly id: string;
  state: SessionState = 'starting';

  private readonly threadProvider: CodexThreadProvider;
  private resolvedThread?: CodexThread;
  private resolvingThread?: Promise<CodexThread>;
  private readonly cwd: string;
  private readonly model?: string;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(params: {
    sessionId: string;
    thread: CodexThreadProvider;
    cwd: string;
    model?: string;
  }) {
    super();
    this.id = params.sessionId;
    this.threadProvider = params.thread;
    this.cwd = params.cwd;
    this.model = params.model;
  }

  async start(initialPrompt: string): Promise<void> {
    this.setState('running');
    if (initialPrompt.trim()) {
      await this.sendPrompt(initialPrompt);
    } else {
      this.setState('idle');
    }
  }

  async sendPrompt(text: string): Promise<void> {
    if (this.stopped) throw new Error('Session already ended');

    this.chain = this.chain.then(async () => {
      if (this.stopped) return;
      const now = Date.now();
      this.setState('running');
      this.emitMessage({
        type: 'user_message',
        text,
        messageId: randomUUID(),
        timestamp: now,
      });

      const chunkMessageId = randomUUID();
      let aggregated = '';
      const thread = await this.getThread();
      const runawayGuard = startCodexRunawayGuard(this.cwd);

      try {
        if (typeof thread.runStreamed === 'function') {
          for await (const chunk of this.runStreamed(thread, text)) {
            const toolCall = extractToolCallEvent(chunk);
            if (toolCall) this.emitMessage(toolCall);
            const toolUpdate = extractToolCallUpdateEvent(chunk);
            if (toolUpdate) this.emitMessage(toolUpdate);
            const usage = extractTokenUsageEvent(chunk);
            if (usage) this.emitMessage(usage);
            const textChunk = extractStreamText(chunk);
            if (!textChunk) continue;
            aggregated += textChunk;
            this.emitMessage({
              type: 'agent_message_chunk',
              text: textChunk,
              messageId: chunkMessageId,
              timestamp: Date.now(),
            });
          }
        } else if (typeof thread.run === 'function') {
          const result = await this.run(thread, text);
          const usage = extractTokenUsageEvent(result);
          if (usage) this.emitMessage(usage);
          aggregated = extractText(result);
        } else {
          throw new Error('Codex thread does not expose run or runStreamed');
        }
      } catch (err) {
        const runawayFailure = runawayGuard.failure();
        if (runawayFailure) throw new Error(runawayFailure);
        throw err;
      } finally {
        runawayGuard.stop();
      }

      const runawayFailure = runawayGuard.failure();
      if (runawayFailure) throw new Error(runawayFailure);

      if (aggregated.trim()) {
        this.emitMessage({
          type: 'agent_message',
          text: aggregated,
          messageId: chunkMessageId,
          timestamp: Date.now(),
        });
      }

      this.setState('idle');
    });

    try {
      await this.chain;
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

  private async getThread(): Promise<CodexThread> {
    if (this.resolvedThread) return this.resolvedThread;
    if (typeof this.threadProvider !== 'function') {
      this.resolvedThread = this.threadProvider;
      return this.resolvedThread;
    }

    this.resolvingThread ??= this.threadProvider().then((thread) => {
      this.resolvedThread = thread;
      return thread;
    });
    return this.resolvingThread;
  }

  private async *runStreamed(thread: CodexThread, text: string): AsyncGenerator<unknown> {
    if (typeof thread.runStreamed !== 'function') return;

    const turnOptions = this.buildTurnOptions();
    const modern = await thread.runStreamed(text, turnOptions);
    const modernEvents = extractEventsStream(modern);
    if (modernEvents) {
      const repeatedToolCalls = new Map<string, number>();
      let totalToolCalls = 0;
      for await (const event of modernEvents) {
        totalToolCalls = this.assertToolCallIsNotLooping(event, repeatedToolCalls, totalToolCalls);
        const failure = extractStreamError(event);
        if (failure) throw new Error(failure);
        yield event;
      }
      return;
    }

    const legacyInput = this.buildLegacyInput(text);
    const legacy = await thread.runStreamed(legacyInput, turnOptions);
    const legacyEvents = extractEventsStream(legacy);
    if (legacyEvents) {
      const repeatedToolCalls = new Map<string, number>();
      let totalToolCalls = 0;
      for await (const event of legacyEvents) {
        totalToolCalls = this.assertToolCallIsNotLooping(event, repeatedToolCalls, totalToolCalls);
        const failure = extractStreamError(event);
        if (failure) throw new Error(failure);
        yield event;
      }
      return;
    }

    throw new Error('Codex runStreamed did not return an async event stream');
  }

  private assertToolCallIsNotLooping(
    event: unknown,
    repeatedToolCalls: Map<string, number>,
    totalToolCalls: number,
  ): number {
    const signature = codexToolCallSignature(event);
    if (!signature) return totalToolCalls;

    const nextTotal = totalToolCalls + 1;
    if (nextTotal > MAX_CODEX_TOOL_CALLS_PER_TURN) {
      throw new Error(
        `Codex exceeded ${MAX_CODEX_TOOL_CALLS_PER_TURN} tool calls in one workflow node without completing; aborting to prevent runaway spend.`,
      );
    }

    const count = (repeatedToolCalls.get(signature) ?? 0) + 1;
    repeatedToolCalls.set(signature, count);
    if (count <= MAX_IDENTICAL_CODEX_TOOL_CALLS) return nextTotal;

    throw new Error(
      `Codex repeated the same tool call ${count} times without completing; aborting the workflow node to prevent runaway spend.`,
    );
  }

  private async run(thread: CodexThread, text: string): Promise<unknown> {
    if (typeof thread.run !== 'function') {
      throw new Error('Codex thread does not expose run');
    }

    try {
      return await thread.run(text, this.buildTurnOptions());
    } catch (err) {
      if (!shouldFallbackToLegacyRun(err)) throw err;
      const legacyInput = this.buildLegacyInput(text);
      return thread.run(legacyInput, this.buildTurnOptions());
    }
  }

  private buildTurnOptions(): Record<string, unknown> {
    const options: Record<string, unknown> = {
      workingDirectory: this.cwd,
      cwd: this.cwd,
      skipGitRepoCheck: true,
    };
    if (this.model) {
      options['model'] = this.model;
    }
    return options;
  }

  private buildLegacyInput(text: string): Record<string, unknown> {
    const input: Record<string, unknown> = {
      input: text,
      cwd: this.cwd,
    };
    if (this.model) input['model'] = this.model;
    return input;
  }
}

function codexToolCallSignature(event: unknown): string | null {
  const rec = recordValue(event);
  if (!rec) return null;

  const direct = functionCallRecord(rec);
  if (direct) return stableFunctionCallSignature(direct);

  const payload = recordValue(rec['payload']);
  const fromPayload = payload ? functionCallRecord(payload) : null;
  if (fromPayload) return stableFunctionCallSignature(fromPayload);

  const item = recordValue(rec['item']);
  const fromItem = item ? functionCallRecord(item) : null;
  if (fromItem) return stableFunctionCallSignature(fromItem);

  return null;
}

interface CodexRunawayGuard {
  stop(): void;
  failure(): string | null;
}

function startCodexRunawayGuard(cwd: string): CodexRunawayGuard {
  const roots = codexSessionLogRoots();
  const offsets = new Map<string, number>();
  const repeatedToolCalls = new Map<string, number>();
  let totalToolCalls = 0;
  let failure: string | null = null;
  let stopped = false;
  let scanning = false;

  void primeCodexLogOffsets(roots, offsets);

  const timer = setInterval(() => {
    if (stopped || scanning || failure) return;
    scanning = true;
    void scanCodexSessionLogs(roots, offsets, (event) => {
      if (failure) return;
      const signature = codexToolCallSignature(event);
      if (!signature) return;

      totalToolCalls += 1;
      if (totalToolCalls > MAX_CODEX_TOOL_CALLS_PER_TURN) {
        failure = `Codex exceeded ${MAX_CODEX_TOOL_CALLS_PER_TURN} tool calls in one workflow node without completing; aborting to prevent runaway spend.`;
        void killCodexProcessesForCwd(cwd);
        return;
      }

      const count = (repeatedToolCalls.get(signature) ?? 0) + 1;
      repeatedToolCalls.set(signature, count);
      if (count > MAX_IDENTICAL_CODEX_TOOL_CALLS) {
        failure = `Codex repeated the same tool call ${count} times without completing; aborting the workflow node to prevent runaway spend.`;
        void killCodexProcessesForCwd(cwd);
      }
    }).finally(() => {
      scanning = false;
    });
  }, CODEX_RUNAWAY_GUARD_POLL_MS);
  timer.unref?.();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    failure(): string | null {
      return failure;
    },
  };
}

function codexSessionLogRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env['CODEX_SESSION_LOG_DIR'];
  if (explicit && explicit.trim()) return [explicit.trim()];

  const home =
    env['CODEX_HOME'] && env['CODEX_HOME'].trim()
      ? env['CODEX_HOME'].trim()
      : path.join(env['HOME'] || '/root', '.codex');
  return [path.join(home, 'sessions')];
}

async function primeCodexLogOffsets(roots: string[], offsets: Map<string, number>): Promise<void> {
  for (const file of await listCodexJsonlFiles(roots)) {
    try {
      const stat = await fs.stat(file);
      offsets.set(file, stat.size);
    } catch {
      // Ignore files that rotate while the guard starts.
    }
  }
}

async function scanCodexSessionLogs(
  roots: string[],
  offsets: Map<string, number>,
  onEvent: (event: unknown) => void,
): Promise<void> {
  for (const file of await listCodexJsonlFiles(roots)) {
    let previousOffset = offsets.get(file);
    try {
      const stat = await fs.stat(file);
      if (previousOffset === undefined) previousOffset = 0;
      if (stat.size < previousOffset) previousOffset = 0;
      if (stat.size === previousOffset) continue;

      const handle = await fs.open(file, 'r');
      try {
        const length = stat.size - previousOffset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, previousOffset);
        offsets.set(file, stat.size);
        for (const line of buffer.toString('utf8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            onEvent(JSON.parse(line));
          } catch {
            // Codex may be appending while we read; the next poll will pick up complete JSONL.
          }
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Missing/unreadable session logs should not break non-Codex adapters or tests.
    }
  }
}

async function listCodexJsonlFiles(roots: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    await collectJsonlFiles(root, files);
  }
  return files;
}

async function collectJsonlFiles(dir: string, files: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(full, files);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
}

async function killCodexProcessesForCwd(cwd: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir('/proc');
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    let cmdline = '';
    try {
      cmdline = await fs.readFile(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue;
    }

    const args = cmdline.split('\0').filter(Boolean);
    const joined = args.join(' ');
    if (!joined.includes('codex') || !joined.includes('exec') || !joined.includes(cwd)) {
      continue;
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process may have exited between scan and kill.
    }
  }
}

function functionCallRecord(rec: Record<string, unknown>): Record<string, unknown> | null {
  if (rec['type'] === 'function_call') return rec;
  const item = recordValue(rec['item']);
  if (item?.['type'] === 'function_call') return item;
  return null;
}

function stableFunctionCallSignature(rec: Record<string, unknown>): string {
  const name = typeof rec['name'] === 'string' ? rec['name'] : 'tool';
  const args = rec['arguments'];
  const normalizedArgs =
    typeof args === 'string'
      ? args
      : args === undefined
        ? ''
        : JSON.stringify(args, Object.keys(recordValue(args) ?? {}).sort());
  return `${name}:${normalizedArgs}`;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class CodexAdapter implements AgentAdapter {
  readonly agentId = 'codex';

  constructor(
    private readonly createClient: CodexClientFactory = defaultClientFactory,
    private readonly apiKey?: string,
  ) {}

  describe(): AgentAdapterDescriptor {
    return {
      schema: 'viewport.agent_adapter/v2',
      agentId: this.agentId,
      displayName: 'Codex',
      adapterVersion: 'codex-sdk',
      capabilities: {
        executionModes: {
          plan: 'unsupported',
          read_only: 'unsupported',
          review: 'prompt_only',
          implement: 'provider',
        },
        toolAllowlist: 'unsupported',
        structuredOutput: 'prompt_only',
        permissionHooks: 'provider',
        usageReporting: 'reported',
        costReporting: 'reported',
        maxTurns: 'unsupported',
        maxBudget: 'unsupported',
        hardTimeout: 'hard',
      },
    };
  }

  async startSession(cwd: string, options?: SessionOptions): Promise<Session> {
    metrics.increment('sessions.codex.started');
    const client = await this.createClient(this.apiKey);
    const thread = await this.createThread(client, cwd, options);
    const sessionId = typeof thread.id === 'string' && thread.id ? thread.id : randomUUID();
    const session = new CodexSession({
      sessionId,
      thread,
      cwd,
      model: options?.model,
    });
    await session.start(options?.deferInitialPrompt ? '' : (options?.initialPrompt ?? ''));
    return session;
  }

  async resumeSession(sessionId: string, cwd: string, options?: SessionOptions): Promise<Session> {
    metrics.increment('sessions.codex.resumed');
    const client = await this.createClient(this.apiKey);
    const shouldDeferResume = Boolean(options?.deferInitialPrompt);
    const thread = shouldDeferResume
      ? () => this.resolveResumeThread(client, sessionId, cwd, options)
      : await this.resolveResumeThread(client, sessionId, cwd, options);
    const session = new CodexSession({
      sessionId,
      thread,
      cwd,
      model: options?.model,
    });
    await session.start(options?.deferInitialPrompt ? '' : (options?.initialPrompt ?? 'Continue.'));
    return session;
  }

  private async resolveResumeThread(
    client: CodexClient,
    sessionId: string,
    cwd: string,
    options?: SessionOptions,
  ): Promise<CodexThread> {
    if (typeof client.resumeThread === 'function') {
      const params = this.buildThreadOptions(cwd, options);
      try {
        return await Promise.resolve(client.resumeThread(sessionId, params.modern));
      } catch {
        return Promise.resolve(client.resumeThread(sessionId, params.legacy));
      }
    }

    if (typeof client.getThread === 'function') {
      return Promise.resolve(client.getThread(sessionId));
    }

    // Compatibility fallback for SDK variants lacking explicit resume methods.
    const params = this.buildThreadOptions(cwd, options);
    return Promise.resolve(
      client.startThread({
        ...params.modern,
        ...params.legacy,
        threadId: sessionId,
        sessionId,
        resume: true,
      }),
    );
  }

  private async createThread(
    client: CodexClient,
    cwd: string,
    options?: SessionOptions,
  ): Promise<CodexThread> {
    const params = this.buildThreadOptions(cwd, options);
    try {
      return await Promise.resolve(client.startThread(params.modern));
    } catch {
      return Promise.resolve(client.startThread(params.legacy));
    }
  }

  private buildThreadOptions(
    cwd: string,
    options?: SessionOptions,
  ): { modern: Record<string, unknown>; legacy: Record<string, unknown> } {
    const model = options?.model ?? DEFAULT_CODEX_MODEL;
    const modern: Record<string, unknown> = {
      workingDirectory: cwd,
      // Daemon sessions run in ephemeral worktrees that may not be pre-trusted by Codex CLI.
      // Avoid hard startup failure on trust-gate checks for these managed directories.
      skipGitRepoCheck: true,
    };
    const legacy: Record<string, unknown> = {
      cwd,
      skipGitRepoCheck: true,
    };
    if (model) {
      modern['model'] = model;
      legacy['model'] = model;
    }
    if (options?.config?.sandboxMode) {
      modern['sandboxMode'] = options.config.sandboxMode;
      legacy['sandboxMode'] = options.config.sandboxMode;
    }
    if (options?.config?.approvalPolicy) {
      modern['approvalPolicy'] = options.config.approvalPolicy;
      legacy['approvalPolicy'] = options.config.approvalPolicy;
    }
    if (options?.canUseTool) {
      modern['canUseTool'] = options.canUseTool;
      legacy['canUseTool'] = options.canUseTool;
    }
    if (options?.config?.trust) {
      modern['trustMode'] = options.config.trust;
      legacy['trustMode'] = options.config.trust;
    }
    return { modern, legacy };
  }
}
