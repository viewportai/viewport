import fs from 'node:fs/promises';
import path from 'node:path';
import type { Daemon } from '../core/daemon.js';
import { configDir } from '../core/config.js';
import type { SessionState } from '../core/types.js';

export async function waitForPromptSessionComplete(
  daemon: Daemon,
  sessionId: string,
  timeoutMs?: number,
): Promise<string> {
  const ended = daemon.getSessionEndReason(sessionId);
  if (ended) return ended;

  const initial = getSessionState(daemon, sessionId);
  if (isPromptTerminalState(initial)) return initial;

  return await new Promise<string>((resolve) => {
    let settled = false;
    let missingPolls = 0;
    const finish = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (timeout) clearTimeout(timeout);
      daemon.off('session:ended', endedHandler);
      daemon.off('session:state-changed', stateHandler);
      resolve(reason);
    };
    const endedHandler = (event: { sessionId: string; reason: string }): void => {
      if (event.sessionId !== sessionId) return;
      finish(event.reason);
    };
    const stateHandler = (event: { sessionId: string; state: SessionState }): void => {
      if (event.sessionId !== sessionId) return;
      if (event.state === 'waiting_permission') {
        finish('waiting_permission');
        return;
      }
      if (!isPromptTerminalState(event.state)) return;
      if (event.state === 'errored') {
        setTimeout(() => finish('errored'), 0);
        return;
      }
      finish(event.state);
    };
    const timer = setInterval(() => {
      const ended = daemon.getSessionEndReason(sessionId);
      if (ended) {
        finish(ended);
        return;
      }

      const state = getSessionState(daemon, sessionId);
      if (state === 'waiting_permission') {
        finish('waiting_permission');
        return;
      }
      if (isPromptTerminalState(state)) {
        if (state === 'errored') {
          setTimeout(() => finish('errored'), 0);
        } else {
          finish(state);
        }
      }
      if (state === null && !daemon.hasSession(sessionId)) {
        missingPolls += 1;
        if (missingPolls >= 2) finish('completed');
      } else {
        missingPolls = 0;
      }
    }, 250);
    const timeout =
      timeoutMs && timeoutMs > 0 ? setTimeout(() => finish('timeout'), timeoutMs) : null;
    daemon.on('session:ended', endedHandler);
    daemon.on('session:state-changed', stateHandler);
  });
}

export function isFailedSessionReason(reason: string): boolean {
  return /(^|[\s:_-])(error|errored|failed|failure)([\s:_-]|$)/i.test(reason);
}

export function getSessionState(daemon: Daemon, sessionId: string): SessionState | null {
  try {
    return daemon.getSessionInfo(sessionId).state;
  } catch {
    return null;
  }
}

export async function readReplaySessionState(sessionId: string): Promise<SessionState | null> {
  try {
    const filePath = path.join(configDir(), 'replay', `${sessionId}.jsonl`);
    const raw = await fs.readFile(filePath, 'utf-8');
    const lines = raw.trim().split('\n').reverse();
    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        update?: { updateType?: unknown; state?: unknown };
      };
      if (parsed.update?.updateType !== 'state-change') continue;
      const state = parsed.update.state;
      if (
        state === 'idle' ||
        state === 'completed' ||
        state === 'errored' ||
        state === 'running' ||
        state === 'starting' ||
        state === 'waiting_permission'
      ) {
        return state;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isPromptTerminalState(
  state: SessionState | null,
): state is 'idle' | 'completed' | 'errored' {
  return state === 'idle' || state === 'completed' || state === 'errored';
}
