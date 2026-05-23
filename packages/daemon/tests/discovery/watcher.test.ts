import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { watchProjects, createSessionTailer } from '../../src/discovery/watcher.js';

class FakeWatcher extends EventEmitter {
  close = vi.fn();
}

describe('watchProjects', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-watcher-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns a cleanup function', () => {
    const stop = watchProjects({
      watchDir: tmpDir,
      onChange: () => {},
    });
    expect(typeof stop).toBe('function');
    stop();
  });

  it('calls onChange when a new JSONL file is created', async () => {
    const onChange = vi.fn();
    const callbackByPath = new Map<string, (event: string, filename?: string) => void>();
    vi.spyOn(fsSync, 'watch').mockImplementation(((target: string, _opts: any, cb: any) => {
      callbackByPath.set(path.resolve(target), cb);
      return new FakeWatcher() as unknown as fsSync.FSWatcher;
    }) as typeof fsSync.watch);

    const stop = watchProjects({
      watchDir: tmpDir,
      debounceMs: 100,
      onChange,
    });

    const rootPath = path.resolve(tmpDir);
    const subDir = path.join(tmpDir, '-tmp-test');
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, 'session-1.jsonl'), '{"type":"user"}\n');
    await new Promise((r) => setTimeout(r, 100));
    callbackByPath.get(rootPath)?.('rename', '-tmp-test');
    await new Promise((r) => setTimeout(r, 100));
    callbackByPath.get(path.resolve(subDir))?.('change', 'session-1.jsonl');
    await new Promise((r) => setTimeout(r, 300));

    expect(onChange).toHaveBeenCalled();
    stop();
  });

  it('does not crash when watching a nonexistent directory', () => {
    const stop = watchProjects({
      watchDir: path.join(tmpDir, 'nonexistent'),
      onChange: () => {},
    });
    // Should not throw
    stop();
  });

  it('stops watching after cleanup', async () => {
    const onChange = vi.fn();
    const stop = watchProjects({
      watchDir: tmpDir,
      debounceMs: 50,
      onChange,
    });

    // Give watcher time to set up
    await new Promise((r) => setTimeout(r, 50));

    // Stop watching
    stop();

    // Create a file after stopping
    const subDir = path.join(tmpDir, '-tmp-test2');
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, 'session.jsonl'), '{"type":"user"}\n');

    // Wait past debounce
    await new Promise((r) => setTimeout(r, 200));

    // onChange should NOT have been called after stop
    expect(onChange).not.toHaveBeenCalled();
  });

  it('debounces multiple rapid changes into one callback', async () => {
    const onChange = vi.fn();
    const subDir = path.join(tmpDir, '-tmp-debounce');
    await fs.mkdir(subDir, { recursive: true });
    const callbackByPath = new Map<string, (event: string, filename?: string) => void>();
    vi.spyOn(fsSync, 'watch').mockImplementation(((target: string, _opts: any, cb: any) => {
      callbackByPath.set(path.resolve(target), cb);
      return new FakeWatcher() as unknown as fsSync.FSWatcher;
    }) as typeof fsSync.watch);

    const stop = watchProjects({
      watchDir: tmpDir,
      debounceMs: 200,
      onChange,
    });

    await new Promise((r) => setTimeout(r, 100));
    // Ensure sub watcher is synced and attached.
    callbackByPath.get(path.resolve(tmpDir))?.('rename', '-tmp-debounce');
    await new Promise((r) => setTimeout(r, 100));

    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(subDir, `session-${i}.jsonl`), `{"type":"user","i":${i}}\n`);
      callbackByPath.get(path.resolve(subDir))?.('change', `session-${i}.jsonl`);
    }

    await new Promise((r) => setTimeout(r, 500));

    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.length).toBeLessThanOrEqual(3);

    stop();
  });

  it('dedupes sub-watchers and closes removed directory watchers', async () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });

    const callbackByPath = new Map<string, (event: string, filename?: string) => void>();
    const watcherByPath = new Map<string, FakeWatcher>();
    const watchSpy = vi.spyOn(fsSync, 'watch').mockImplementation(((
      target: string,
      _opts: any,
      cb: any,
    ) => {
      const watcher = new FakeWatcher();
      callbackByPath.set(path.resolve(target), cb);
      watcherByPath.set(path.resolve(target), watcher);
      return watcher as unknown as fsSync.FSWatcher;
    }) as typeof fsSync.watch);

    const stop = watchProjects({ watchDir: tmpDir, debounceMs: 10, onChange: vi.fn() });
    await new Promise((r) => setTimeout(r, 100));

    const rootPath = path.resolve(tmpDir);
    const dirAPath = path.resolve(dirA);
    const dirBPath = path.resolve(dirB);

    expect(callbackByPath.has(rootPath)).toBe(true);
    expect(callbackByPath.has(dirAPath)).toBe(true);
    expect(callbackByPath.has(dirBPath)).toBe(true);

    // Duplicate top-level events for the same directory should not create duplicate watchers.
    const dirC = path.join(tmpDir, 'c');
    await fs.mkdir(dirC, { recursive: true });
    callbackByPath.get(rootPath)?.('rename', 'c');
    callbackByPath.get(rootPath)?.('rename', 'c');
    await new Promise((r) => setTimeout(r, 150));

    const dirCPath = path.resolve(dirC);
    const dirCWatchCalls = watchSpy.mock.calls.filter(
      (args) => path.resolve(String(args[0])) === dirCPath,
    );
    expect(dirCWatchCalls).toHaveLength(1);

    // Removing a directory should close and remove its watcher.
    await fs.rm(dirB, { recursive: true, force: true });
    callbackByPath.get(rootPath)?.('rename', 'b');
    await new Promise((r) => setTimeout(r, 150));
    expect(watcherByPath.get(dirBPath)?.close).toHaveBeenCalled();

    stop();
  });

  it('retries failed sub-watchers with backoff', async () => {
    const retryDir = path.join(tmpDir, 'retry');
    await fs.mkdir(retryDir, { recursive: true });

    const attempts = { retryDir: 0 };
    vi.spyOn(fsSync, 'watch').mockImplementation(((target: string, _opts: any, cb: any) => {
      const resolved = path.resolve(target);
      if (resolved === path.resolve(retryDir)) {
        attempts.retryDir += 1;
        if (attempts.retryDir < 3) {
          throw new Error('watch failed');
        }
      }
      const watcher = new FakeWatcher();
      // Keep callback attached to emulate real watcher lifecycle.
      watcher.on('noop', () => cb('change', 'session.jsonl'));
      return watcher as unknown as fsSync.FSWatcher;
    }) as typeof fsSync.watch);

    const stop = watchProjects({ watchDir: tmpDir, debounceMs: 10, onChange: vi.fn() });
    await new Promise((r) => setTimeout(r, 900));

    expect(attempts.retryDir).toBeGreaterThanOrEqual(3);
    stop();
  });

  it('handles bursty file changes under load without runaway callbacks', async () => {
    const onChange = vi.fn();
    const callbackByPath = new Map<string, (event: string, filename?: string) => void>();
    vi.spyOn(fsSync, 'watch').mockImplementation(((target: string, _opts: any, cb: any) => {
      callbackByPath.set(path.resolve(target), cb);
      return new FakeWatcher() as unknown as fsSync.FSWatcher;
    }) as typeof fsSync.watch);

    const stop = watchProjects({
      watchDir: tmpDir,
      debounceMs: 50,
      onChange,
    });

    const rootPath = path.resolve(tmpDir);
    const dirs: string[] = [];
    for (let i = 0; i < 25; i++) {
      const dir = path.join(tmpDir, `burst-${i}`);
      dirs.push(dir);
      await fs.mkdir(dir, { recursive: true });
      callbackByPath.get(rootPath)?.('rename', `burst-${i}`);
    }

    await new Promise((r) => setTimeout(r, 120));

    for (const dir of dirs) {
      const dirPath = path.resolve(dir);
      for (let i = 0; i < 4; i++) {
        callbackByPath.get(dirPath)?.('change', `session-${i}.jsonl`);
      }
    }

    await new Promise((r) => setTimeout(r, 250));

    // Many low-level events should collapse into a small number of sync callbacks.
    expect(onChange.mock.calls.length).toBeLessThanOrEqual(8);
    stop();
  });

  it('supports recursive watch mode for nested codex session directories', async () => {
    const onChange = vi.fn();
    const onFileChanged = vi.fn();
    const callbackByPath = new Map<string, (event: string, filename?: string) => void>();
    vi.spyOn(fsSync, 'watch').mockImplementation(((target: string, _opts: any, cb: any) => {
      callbackByPath.set(path.resolve(target), cb);
      return new FakeWatcher() as unknown as fsSync.FSWatcher;
    }) as typeof fsSync.watch);

    const yearDir = path.join(tmpDir, '2026');
    const monthDir = path.join(yearDir, '03');
    const dayDir = path.join(monthDir, '02');
    await fs.mkdir(dayDir, { recursive: true });

    const stop = watchProjects({
      watchDir: tmpDir,
      debounceMs: 50,
      recursive: true,
      includeTopLevelFiles: true,
      onChange,
      onFileChanged,
    });
    await new Promise((r) => setTimeout(r, 200));

    callbackByPath.get(path.resolve(dayDir))?.('change', 'sess.jsonl');
    await new Promise((r) => setTimeout(r, 120));

    expect(onFileChanged).toHaveBeenCalledWith(path.join(dayDir, 'sess.jsonl'));
    expect(onChange).toHaveBeenCalled();
    stop();
  });

  it('updates tailer sessionId from codex payload metadata', async () => {
    const filePath = path.join(tmpDir, 'rollout-session.jsonl');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'codex-real-session-id' },
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const tailer = createSessionTailer(filePath);
    await tailer.readNew();
    expect(tailer.sessionId).toBe('codex-real-session-id');
  });

  it('buffers partial JSONL writes and parses completed lines on subsequent reads', async () => {
    const filePath = path.join(tmpDir, 'partial-session.jsonl');
    await fs.writeFile(filePath, '', 'utf-8');
    const tailer = createSessionTailer(filePath);

    const jsonLine = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'codex-partial-session' },
    });
    const splitAt = Math.floor(jsonLine.length / 2);
    const firstHalf = jsonLine.slice(0, splitAt);
    const secondHalf = jsonLine.slice(splitAt);

    await fs.appendFile(filePath, firstHalf, 'utf-8');
    const firstRead = await tailer.readNew();
    expect(firstRead).toEqual([]);
    expect(tailer.sessionId).toBe('partial-session');

    await fs.appendFile(filePath, `${secondHalf}\n`, 'utf-8');
    const secondRead = await tailer.readNew();
    expect(secondRead).toHaveLength(1);
    expect(tailer.sessionId).toBe('codex-partial-session');
  });

  it('recovers after file truncation and re-read from offset zero', async () => {
    const filePath = path.join(tmpDir, 'truncate-session.jsonl');
    const first = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'codex-before-truncate' },
    });
    await fs.writeFile(filePath, `${first}\n`, 'utf-8');

    const tailer = createSessionTailer(filePath);
    const firstRead = await tailer.readNew();
    expect(firstRead).toHaveLength(1);
    expect(tailer.sessionId).toBe('codex-before-truncate');

    const second = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'codex-after-truncate' },
    });
    await fs.writeFile(filePath, `${second}\n`, 'utf-8');

    const secondRead = await tailer.readNew();
    expect(secondRead).toHaveLength(1);
    expect(tailer.sessionId).toBe('codex-after-truncate');
  });

  it('tails large existing session files without reading from offset zero', async () => {
    const filePath = path.join(tmpDir, 'large-session.jsonl');
    const handle = await fs.open(filePath, 'w');
    try {
      const offset = 3 * 1024 * 1024 * 1024;
      await handle.truncate(offset);
      await handle.write('\n', offset);
      await handle.write(
        `${JSON.stringify({
          type: 'session_meta',
          payload: { id: 'codex-large-session' },
        })}\n`,
        offset + 1,
      );
    } finally {
      await handle.close();
    }

    const tailer = createSessionTailer(filePath);
    const firstRead = await tailer.readNew();

    expect(firstRead).toHaveLength(1);
    expect(tailer.sessionId).toBe('codex-large-session');
  });
});
