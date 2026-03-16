/**
 * Persists active session metadata to disk for crash recovery.
 *
 * Writes ~/.viewport/active-sessions.json on every state change.
 * On startup, orphaned entries indicate sessions that crashed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { configDir } from './config.js';

export interface PersistedSession {
  sessionId: string;
  directoryId: string;
  agent: string;
  model?: string;
  startedAt: number;
  lastStateChange: number;
  state: string;
  cwd: string;
}

const STATE_FILE = 'active-sessions.json';

const PersistedSessionSchema = z.object({
  sessionId: z.string().min(1).max(256),
  directoryId: z.string().min(1).max(256),
  agent: z.string().min(1).max(64),
  model: z.string().max(200).optional(),
  startedAt: z.number().int().nonnegative(),
  lastStateChange: z.number().int().nonnegative(),
  state: z.string().min(1).max(64),
  cwd: z.string().max(2048),
});

const PersistedSessionListSchema = z.array(PersistedSessionSchema).max(5000);

function stateFilePath(): string {
  return path.join(configDir(), STATE_FILE);
}

export async function loadPersistedSessions(): Promise<PersistedSession[]> {
  try {
    const raw = await fs.readFile(stateFilePath(), 'utf-8');
    const data: unknown = JSON.parse(raw);
    const parsed = PersistedSessionListSchema.safeParse(data);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export async function savePersistedSessions(sessions: PersistedSession[]): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(stateFilePath(), JSON.stringify(sessions, null, 2) + '\n', {
    mode: 0o600,
  });
}

export async function clearPersistedSessions(): Promise<void> {
  try {
    await fs.unlink(stateFilePath());
  } catch {
    // File didn't exist
  }
}
