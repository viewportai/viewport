import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  loadPersistedSessions,
  savePersistedSessions,
  clearPersistedSessions,
} from '../../src/core/session-state-file.js';
import type { PersistedSession } from '../../src/core/session-state-file.js';

describe('session-state-file', () => {
  let tmpDir: string;
  let originalHome: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-state-test-'));
    originalHome = os.homedir();
    process.env['HOME'] = tmpDir;
  });

  afterEach(async () => {
    process.env['HOME'] = originalHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const sampleSession: PersistedSession = {
    sessionId: 'sess-1',
    directoryId: 'dir-1',
    agent: 'claude',
    model: 'opus',
    startedAt: 1000,
    lastStateChange: 2000,
    state: 'running',
    cwd: '/tmp/project',
  };

  // ---------------------------------------------------------------------------
  // save + load roundtrip
  // ---------------------------------------------------------------------------

  it('saves and loads sessions correctly', async () => {
    const sessions: PersistedSession[] = [
      sampleSession,
      {
        sessionId: 'sess-2',
        directoryId: 'dir-2',
        agent: 'aider',
        startedAt: 3000,
        lastStateChange: 4000,
        state: 'idle',
        cwd: '/tmp/other',
      },
    ];

    await savePersistedSessions(sessions);
    const loaded = await loadPersistedSessions();

    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.sessionId).toBe('sess-1');
    expect(loaded[0]!.model).toBe('opus');
    expect(loaded[1]!.sessionId).toBe('sess-2');
    expect(loaded[1]!.agent).toBe('aider');
  });

  // ---------------------------------------------------------------------------
  // load — missing file
  // ---------------------------------------------------------------------------

  it('returns empty array if file does not exist', async () => {
    const loaded = await loadPersistedSessions();
    expect(loaded).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // load — corrupt file
  // ---------------------------------------------------------------------------

  it('returns empty array if file contains invalid JSON', async () => {
    const viewportDir = path.join(tmpDir, '.viewport');
    await fs.mkdir(viewportDir, { recursive: true });
    await fs.writeFile(path.join(viewportDir, 'active-sessions.json'), 'not json');

    const loaded = await loadPersistedSessions();
    expect(loaded).toEqual([]);
  });

  it('returns empty array if file contains non-array JSON', async () => {
    const viewportDir = path.join(tmpDir, '.viewport');
    await fs.mkdir(viewportDir, { recursive: true });
    await fs.writeFile(
      path.join(viewportDir, 'active-sessions.json'),
      JSON.stringify({ not: 'an array' }),
    );

    const loaded = await loadPersistedSessions();
    expect(loaded).toEqual([]);
  });

  it('returns empty array if entries fail schema validation', async () => {
    const viewportDir = path.join(tmpDir, '.viewport');
    await fs.mkdir(viewportDir, { recursive: true });
    await fs.writeFile(
      path.join(viewportDir, 'active-sessions.json'),
      JSON.stringify([
        {
          sessionId: '', // invalid: min(1)
          directoryId: 'dir-1',
          agent: 'claude',
          startedAt: 1,
          lastStateChange: 2,
          state: 'running',
          cwd: '/tmp/project',
        },
      ]),
    );

    const loaded = await loadPersistedSessions();
    expect(loaded).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // clearPersistedSessions
  // ---------------------------------------------------------------------------

  it('removes the state file', async () => {
    await savePersistedSessions([sampleSession]);

    // File should exist
    const filePath = path.join(tmpDir, '.viewport', 'active-sessions.json');
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);

    await clearPersistedSessions();

    // File should be gone
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('does not throw if file does not exist', async () => {
    // Should not throw even though there's nothing to clear
    await expect(clearPersistedSessions()).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // save — creates directory
  // ---------------------------------------------------------------------------

  it('creates .viewport directory if it does not exist', async () => {
    // tmpDir exists but .viewport subdirectory does not
    await savePersistedSessions([sampleSession]);

    const filePath = path.join(tmpDir, '.viewport', 'active-sessions.json');
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    expect(data).toHaveLength(1);
    expect(data[0].sessionId).toBe('sess-1');
  });
});
