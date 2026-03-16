import fs from 'node:fs/promises';
import path from 'node:path';
import { getArgs, getFlag, hasFlag } from './args.js';
import { daemonFetch, isDaemonRunning } from './daemon-client.js';
import { DaemonWsClient } from './ws-client.js';
import { isJsonMode, parseTimeoutMs, printJson, shortError } from './command-shared.js';
interface DirectoryInfo {
  id: string;
  path: string;
  name: string;
}
interface SessionUpdateMessage {
  type: 'session-update';
  sessionId: string;
  seq: number;
  update: Record<string, unknown>;
}
interface SessionStartedMessage {
  type: 'session-started';
  sessionId: string;
  directoryId: string;
}
interface SessionEndedMessage {
  type: 'session-ended';
  sessionId: string;
  reason?: string;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function isSessionStartedMessage(value: unknown): value is SessionStartedMessage {
  if (!isObject(value)) return false;
  return value['type'] === 'session-started' && typeof value['sessionId'] === 'string';
}

function isSessionUpdateMessage(value: unknown): value is SessionUpdateMessage {
  if (!isObject(value)) return false;
  return (
    value['type'] === 'session-update' &&
    typeof value['sessionId'] === 'string' &&
    isObject(value['update'])
  );
}

function isSessionEndedMessage(value: unknown): value is SessionEndedMessage {
  if (!isObject(value)) return false;
  return value['type'] === 'session-ended' && typeof value['sessionId'] === 'string';
}

async function ensureDaemonRunningOrThrow(): Promise<void> {
  if (await isDaemonRunning()) return;
  throw new Error('Daemon is not running. Start it first with `vpd start`.');
}

async function listDaemonDirectories(): Promise<DirectoryInfo[]> {
  const res = await daemonFetch('/api/directories');
  if (!res || !res.ok) {
    throw new Error('Failed to list daemon directories');
  }
  return (await res.json()) as DirectoryInfo[];
}

async function resolveDirectoryIdFromInput(rawInput: string | undefined): Promise<string> {
  const input = rawInput ?? process.cwd();
  const directories = await listDaemonDirectories();

  const byId = directories.find((item) => item.id === input);
  if (byId) return byId.id;

  let resolvedPath: string | null = null;
  try {
    const stat = await fs.stat(path.resolve(input));
    if (stat.isDirectory()) {
      resolvedPath = path.resolve(input);
    }
  } catch {
    resolvedPath = null;
  }

  if (!resolvedPath) {
    throw new Error(`Directory not found (id or path): ${input}`);
  }

  const byPath = directories.find((item) => item.path === resolvedPath);
  if (byPath) return byPath.id;

  const created = await daemonFetch('/api/directories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: resolvedPath }),
  });
  if (!created || !created.ok) {
    throw new Error(`Failed to register directory: ${resolvedPath}`);
  }
  const payload = (await created.json()) as { id?: unknown };
  if (typeof payload.id !== 'string') {
    throw new Error(`Failed to register directory: ${resolvedPath}`);
  }
  return payload.id;
}

function renderUpdateText(update: Record<string, unknown>): string | null {
  const updateType = typeof update['updateType'] === 'string' ? update['updateType'] : null;
  if (!updateType) return null;

  if (updateType === 'agent-message' || updateType === 'agent-message-chunk') {
    return typeof update['text'] === 'string' ? update['text'] : null;
  }
  if (updateType === 'agent-thought-chunk') {
    return null;
  }
  if (updateType === 'tool-call') {
    const toolName = typeof update['toolName'] === 'string' ? update['toolName'] : 'unknown';
    const title = typeof update['title'] === 'string' ? update['title'] : '';
    return `\n[tool:${toolName}] ${title}`.trimEnd();
  }
  if (updateType === 'tool-call-update') {
    const status = typeof update['status'] === 'string' ? update['status'] : 'updated';
    const toolCallId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : 'tool';
    return `[tool:${toolCallId}] ${status}`;
  }
  if (updateType === 'permission-request') {
    const toolName = typeof update['toolName'] === 'string' ? update['toolName'] : 'unknown';
    return `[permission] requested for ${toolName}`;
  }
  if (updateType === 'state-change') {
    const state = typeof update['state'] === 'string' ? update['state'] : 'unknown';
    return `[state] ${state}`;
  }
  if (updateType === 'step-committed') {
    const step = typeof update['step'] === 'number' ? update['step'] : '?';
    const sha = typeof update['sha'] === 'string' ? update['sha'] : 'unknown';
    const toolName = typeof update['toolName'] === 'string' ? update['toolName'] : 'tool';
    return `[step ${step}] ${sha} (${toolName})`;
  }
  return null;
}

async function waitForSessionEnd(
  ws: DaemonWsClient,
  sessionId: string,
  timeoutMs: number,
  updatesSink?: Array<Record<string, unknown>>,
  renderText = false,
): Promise<{ reason?: string }> {
  return await new Promise<{ reason?: string }>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const close = () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };

    const finish = (result: { reason?: string }) => {
      if (done) return;
      done = true;
      close();
      resolve(result);
    };

    const fail = (err: Error) => {
      if (done) return;
      done = true;
      close();
      reject(err);
    };

    const unsubscribe = ws.onMessage((msg) => {
      if (isSessionUpdateMessage(msg) && msg.sessionId === sessionId) {
        updatesSink?.push(msg.update);
        if (renderText) {
          const text = renderUpdateText(msg.update);
          if (text) process.stdout.write(text);
        }
        return;
      }

      if (isSessionEndedMessage(msg) && msg.sessionId === sessionId) {
        finish({ reason: msg.reason });
      }
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(new Error(`Timed out waiting for session ${sessionId}`));
      }, timeoutMs);
    }
  });
}

function requiredPromptFromFlags(): string {
  const prompt = getFlag('prompt') ?? getFlag('text');
  if (!prompt || prompt.trim().length === 0) {
    throw new Error('Missing prompt text. Use --prompt "<text>".');
  }
  return prompt.trim();
}

export async function runSession(): Promise<void> {
  const asJson = isJsonMode();
  await ensureDaemonRunningOrThrow();
  const args = getArgs();
  const directoryInput = args[1] && !args[1]?.startsWith('--') ? args[1] : undefined;
  const prompt = requiredPromptFromFlags();
  const timeoutMs = parseTimeoutMs(getFlag('timeout'), 0);
  const shouldWait = hasFlag('wait') || hasFlag('attach');
  const shouldAttach = hasFlag('attach');
  const agent = getFlag('agent');
  const model = getFlag('model');

  const directoryId = await resolveDirectoryIdFromInput(directoryInput);
  const ws = new DaemonWsClient();
  await ws.connect();

  try {
    const startedPromise = ws.waitForMessage<SessionStartedMessage>(
      (msg: unknown): msg is SessionStartedMessage => {
        return isSessionStartedMessage(msg) && msg.directoryId === directoryId;
      },
      15_000,
    );

    await ws.requestAck(
      {
        type: 'launch',
        directoryId,
        prompt,
        model,
        configOverrides: agent ? { agent } : undefined,
      },
      30_000,
    );

    const started = await startedPromise;
    const sessionId = started.sessionId;

    if (!shouldWait && !shouldAttach) {
      if (asJson) {
        printJson({ command: 'run', ok: true, directoryId, sessionId });
      } else {
        console.log(`Started session ${sessionId} in directory ${directoryId}`);
      }
      return;
    }

    const updates: Array<Record<string, unknown>> = [];
    const result = await waitForSessionEnd(ws, sessionId, timeoutMs, updates, !asJson);
    if (!asJson) {
      process.stdout.write('\n');
      console.log(`Session ended: ${result.reason ?? 'completed'}`);
      return;
    }

    printJson({
      command: 'run',
      ok: true,
      directoryId,
      sessionId,
      endedReason: result.reason ?? null,
      updates,
    });
  } finally {
    ws.close();
  }
}

export async function sendPromptCommand(): Promise<void> {
  const asJson = isJsonMode();
  await ensureDaemonRunningOrThrow();
  const args = getArgs();
  const sessionId = args[1];
  if (!sessionId || sessionId.startsWith('--')) {
    throw new Error('Usage: vpd send <session-id> --prompt "<text>"');
  }
  const prompt = requiredPromptFromFlags();

  const ws = new DaemonWsClient();
  await ws.connect();
  try {
    await ws.requestAck(
      {
        type: 'prompt',
        sessionId,
        text: prompt,
      },
      20_000,
    );
    if (asJson) {
      printJson({ command: 'send', ok: true, sessionId });
    } else {
      console.log(`Prompt sent to ${sessionId}`);
    }
  } finally {
    ws.close();
  }
}

export async function logsCommand(options?: { follow?: boolean }): Promise<void> {
  const asJson = isJsonMode();
  await ensureDaemonRunningOrThrow();
  const args = getArgs();
  const sessionId = args[1];
  if (!sessionId || sessionId.startsWith('--')) {
    throw new Error('Usage: vpd logs <session-id> [--follow]');
  }
  const follow = options?.follow ?? hasFlag('follow');
  const lastSeq = getFlag('last-seq');
  const parsedLastSeq = lastSeq ? Number.parseInt(lastSeq, 10) : undefined;

  const ws = new DaemonWsClient();
  await ws.connect();

  const updates: Array<Record<string, unknown>> = [];
  const unsubscribe = ws.onMessage((msg) => {
    if (!isSessionUpdateMessage(msg) || msg.sessionId !== sessionId) return;
    updates.push(msg.update);
    if (!asJson) {
      const text = renderUpdateText(msg.update);
      if (text) process.stdout.write(text);
    }
  });

  try {
    await ws.requestAck(
      {
        type: 'subscribe',
        sessionId,
        lastSeq: Number.isInteger(parsedLastSeq) ? parsedLastSeq : undefined,
      },
      20_000,
    );

    if (!follow) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (asJson) {
        printJson({ command: 'logs', ok: true, sessionId, updates });
      } else if (updates.length === 0) {
        console.log(`No updates found for session ${sessionId}`);
      } else {
        process.stdout.write('\n');
      }
      return;
    }

    await waitForSessionEnd(ws, sessionId, 0, updates, false);
    if (!asJson) {
      process.stdout.write('\n');
      console.log(`Session ended: ${sessionId}`);
      return;
    }
    printJson({ command: 'logs', ok: true, sessionId, updates, follow: true });
  } finally {
    unsubscribe();
    ws.close();
  }
}

export async function waitCommand(): Promise<void> {
  const asJson = isJsonMode();
  await ensureDaemonRunningOrThrow();
  const args = getArgs();
  const sessionId = args[1];
  if (!sessionId || sessionId.startsWith('--')) {
    throw new Error('Usage: vpd wait <session-id> [--timeout <seconds>]');
  }

  const timeoutMs = parseTimeoutMs(getFlag('timeout'), 0);
  const ws = new DaemonWsClient();
  await ws.connect();

  try {
    await ws.requestAck(
      {
        type: 'subscribe',
        sessionId,
      },
      20_000,
    );
    const result = await waitForSessionEnd(ws, sessionId, timeoutMs);
    if (asJson) {
      printJson({ command: 'wait', ok: true, sessionId, reason: result.reason ?? null });
    } else {
      console.log(`Session ended: ${sessionId}${result.reason ? ` (${result.reason})` : ''}`);
    }
  } catch (err) {
    if (asJson) {
      printJson({ command: 'wait', ok: false, sessionId, error: shortError(err) });
      return;
    }
    throw err;
  } finally {
    ws.close();
  }
}

export async function attachCommand(): Promise<void> {
  await logsCommand({ follow: true });
}
