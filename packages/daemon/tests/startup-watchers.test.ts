import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredSession } from '../src/core/interfaces.js';
import { metrics } from '../src/core/metrics.js';

vi.mock('../src/discovery/watcher.js', async () => {
  const actual = await vi.importActual('../src/discovery/watcher.js');
  return {
    ...actual,
    watchProjects: vi.fn(() => () => {}),
  };
});

import { startDiscoveryWatchers } from '../src/startup-watchers.js';

class FakeDaemon extends EventEmitter {
  readonly directoryManager: {
    list: () => Array<{ id: string; path: string }>;
  };

  private readonly discovered = new Map<string, DiscoveredSession[]>();

  constructor(dirId: string, dirPath: string, sessions: DiscoveredSession[]) {
    super();
    this.directoryManager = {
      list: () => [{ id: dirId, path: dirPath }],
    };
    this.discovered.set(dirId, sessions);
  }

  getDiscoveredSessions(): Map<string, DiscoveredSession[]> {
    return this.discovered;
  }

  async runDiscovery(): Promise<void> {
    // no-op in this test
  }
}

describe('startDiscoveryWatchers', () => {
  afterEach(() => {
    vi.clearAllTimers();
    metrics.reset();
  });

  it('polls discovered source files and emits tail updates when fs watch misses events', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-startup-watchers-'));
    const projectPath = path.join(tmpRoot, 'project');
    await fs.mkdir(projectPath, { recursive: true });
    const sourcePath = path.join(tmpRoot, 'codex-session.jsonl');
    await fs.writeFile(sourcePath, '', 'utf-8');

    const daemon = new FakeDaemon('dir-1', projectPath, [
      {
        agentId: 'codex',
        sessionId: 'codex-file-id',
        summary: 'Codex session',
        cwd: projectPath,
        lastModified: Date.now(),
        resumable: true,
        sourcePath,
        messageCount: 0,
      },
    ]);

    const registry = {
      getAllWatchDirs: () => [tmpRoot],
    };

    const handle = await startDiscoveryWatchers(
      daemon as unknown as Parameters<typeof startDiscoveryWatchers>[0],
      registry as unknown as Parameters<typeof startDiscoveryWatchers>[1],
    );

    try {
      const received = new Promise<{
        sessionId: string;
        directoryId: string;
        newBlocks: unknown[];
      }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timed out waiting for discovery:session-tail'));
        }, 6_000);
        daemon.once('discovery:session-tail', (event) => {
          clearTimeout(timeout);
          resolve(event as { sessionId: string; directoryId: string; newBlocks: unknown[] });
        });
      });

      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'codex-thread-id',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'poll fallback live tail' }],
        },
      });
      await fs.appendFile(sourcePath, `${line}\n`, 'utf-8');

      const event = await received;
      expect(event.directoryId).toBe('dir-1');
      expect(event.sessionId).toBe('codex-file-id');
      expect(event.newBlocks.length).toBeGreaterThan(0);
      const snapshot = metrics.snapshot();
      expect(snapshot.counters['discovery.poll_cycles']).toBeGreaterThanOrEqual(1);
      expect(snapshot.counters['discovery.files_scanned']).toBeGreaterThanOrEqual(1);
      expect(snapshot.counters['discovery.tail_events_emitted']).toBeGreaterThanOrEqual(1);
      expect(snapshot.gauges['discovery.poll_files_scanned']).toBeGreaterThanOrEqual(1);
    } finally {
      handle.stop();
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
