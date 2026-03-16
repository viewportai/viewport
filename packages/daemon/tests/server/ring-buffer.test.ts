import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RingBuffer,
  readPersistedReplayMeta,
  readPersistedSessionMessagesRich,
} from '../../src/server/ring-buffer.js';

describe('RingBuffer', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function makeStorageDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-ring-buffer-'));
    tempDirs.push(dir);
    return dir;
  }

  it('pushes and retrieves entries in order', () => {
    const buffer = new RingBuffer(5);
    buffer.push('s1', { text: 'a' });
    buffer.push('s1', { text: 'b' });
    buffer.push('s1', { text: 'c' });

    const all = buffer.getAll();
    expect(all).toHaveLength(3);
    expect(all[0]!.seq).toBe(1);
    expect(all[1]!.seq).toBe(2);
    expect(all[2]!.seq).toBe(3);
    expect(all[0]!.update).toEqual({ text: 'a' });
    expect(all[2]!.update).toEqual({ text: 'c' });
  });

  it('getAfter returns entries after the given sequence', () => {
    const buffer = new RingBuffer(10);
    buffer.push('s1', { n: 1 });
    buffer.push('s1', { n: 2 });
    buffer.push('s1', { n: 3 });
    buffer.push('s1', { n: 4 });

    const after2 = buffer.getAfter(2);
    expect(after2).toHaveLength(2);
    expect(after2[0]!.seq).toBe(3);
    expect(after2[1]!.seq).toBe(4);
  });

  it('evicts oldest entries when full', () => {
    const buffer = new RingBuffer(3);
    buffer.push('s1', { n: 1 });
    buffer.push('s1', { n: 2 });
    buffer.push('s1', { n: 3 });
    buffer.push('s1', { n: 4 }); // evicts n:1
    buffer.push('s1', { n: 5 }); // evicts n:2

    const all = buffer.getAll();
    expect(all).toHaveLength(3);
    expect(all[0]!.update).toEqual({ n: 3 });
    expect(all[1]!.update).toEqual({ n: 4 });
    expect(all[2]!.update).toEqual({ n: 5 });
  });

  it('maintains correct order after wraparound', () => {
    const buffer = new RingBuffer(3);
    // Fill buffer
    buffer.push('s1', { n: 1 });
    buffer.push('s1', { n: 2 });
    buffer.push('s1', { n: 3 });
    // Wrap around multiple times
    buffer.push('s1', { n: 4 });
    buffer.push('s1', { n: 5 });
    buffer.push('s1', { n: 6 });
    buffer.push('s1', { n: 7 });

    const all = buffer.getAll();
    expect(all).toHaveLength(3);
    // Should be the last 3 entries, in order
    expect(all.map((e) => e.update)).toEqual([{ n: 5 }, { n: 6 }, { n: 7 }]);
    // Sequence numbers should be monotonically increasing
    expect(all.map((e) => e.seq)).toEqual([5, 6, 7]);
  });

  it('getAfter works correctly after wraparound', () => {
    const buffer = new RingBuffer(3);
    for (let i = 1; i <= 7; i++) {
      buffer.push('s1', { n: i });
    }

    // Buffer contains seq 5, 6, 7
    const after5 = buffer.getAfter(5);
    expect(after5).toHaveLength(2);
    expect(after5.map((e) => e.seq)).toEqual([6, 7]);

    // Requesting before earliest available
    const after3 = buffer.getAfter(3);
    expect(after3).toHaveLength(3);
    expect(after3.map((e) => e.seq)).toEqual([5, 6, 7]);
  });

  it('getAfter returns empty when all entries are before lastSeq', () => {
    const buffer = new RingBuffer(3);
    buffer.push('s1', { n: 1 });
    buffer.push('s1', { n: 2 });

    expect(buffer.getAfter(5)).toEqual([]);
  });

  it('getAll returns empty for empty buffer', () => {
    const buffer = new RingBuffer(5);
    expect(buffer.getAll()).toEqual([]);
  });

  it('preserves sessionId per entry', () => {
    const buffer = new RingBuffer(10);
    buffer.push('session-a', { msg: 'hello' });
    buffer.push('session-b', { msg: 'world' });

    const all = buffer.getAll();
    expect(all[0]!.sessionId).toBe('session-a');
    expect(all[1]!.sessionId).toBe('session-b');
  });

  it('returns the pushed entry from push()', () => {
    const buffer = new RingBuffer(5);
    const entry = buffer.push('s1', { data: 'test' });

    expect(entry.seq).toBe(1);
    expect(entry.sessionId).toBe('s1');
    expect(entry.update).toEqual({ data: 'test' });
  });

  it('handles size of 1', () => {
    const buffer = new RingBuffer(1);
    buffer.push('s1', { n: 1 });
    buffer.push('s1', { n: 2 });
    buffer.push('s1', { n: 3 });

    const all = buffer.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.update).toEqual({ n: 3 });
    expect(all[0]!.seq).toBe(3);
  });

  it('reports replay window metadata when requested seq is available', () => {
    const buffer = new RingBuffer(5);
    for (let i = 1; i <= 5; i++) {
      buffer.push('s1', { n: i });
    }

    const replay = buffer.getReplayWindow(3);
    expect(replay.droppedWindow).toBe(false);
    expect(replay.requestedLastSeq).toBe(3);
    expect(replay.earliestAvailableSeq).toBe(1);
    expect(replay.latestAvailableSeq).toBe(5);
    expect(replay.entries.map((entry) => entry.seq)).toEqual([4, 5]);
  });

  it('marks droppedWindow when requested seq falls outside retained buffer', () => {
    const buffer = new RingBuffer(3);
    for (let i = 1; i <= 7; i++) {
      buffer.push('s1', { n: i });
    }

    const replay = buffer.getReplayWindow(1);
    expect(replay.droppedWindow).toBe(true);
    expect(replay.earliestAvailableSeq).toBe(5);
    expect(replay.latestAvailableSeq).toBe(7);
    expect(replay.entries.map((entry) => entry.seq)).toEqual([5, 6, 7]);
  });

  it('persists durable replay state across buffer instances', async () => {
    const storageDir = await makeStorageDir();
    const first = new RingBuffer({ sessionId: 'persisted-session', storageDir });
    first.setDirectoryId('dir-1');
    first.push('persisted-session', {
      updateType: 'user-message',
      messageId: 'msg-user',
      text: 'hello from disk',
      timestamp: Date.now(),
    });
    first.push('persisted-session', {
      updateType: 'agent-message-chunk',
      messageId: 'msg-chunk',
      text: 'transient',
      timestamp: Date.now(),
    });
    first.push('persisted-session', {
      updateType: 'agent-message',
      messageId: 'msg-agent',
      text: 'durable reply',
      timestamp: Date.now(),
    });
    await first.flushPersistence();

    const second = new RingBuffer({ sessionId: 'persisted-session', storageDir });
    const replay = second.getReplayWindow(0);
    expect(replay.latestAvailableSeq).toBe(3);
    expect(replay.entries.map((entry) => entry.seq)).toEqual([1, 3]);
    expect(readPersistedReplayMeta('persisted-session', { storageDir })?.directoryId).toBe('dir-1');
    expect(
      readPersistedSessionMessagesRich('persisted-session', { storageDir }).map((message) =>
        message.kind === 'text' ? message.text : message.kind,
      ),
    ).toEqual(['hello from disk', 'durable reply']);
  });

  it('rewrites corrupted journal lines on reload', async () => {
    const storageDir = await makeStorageDir();
    const buffer = new RingBuffer({ sessionId: 'corrupt-session', storageDir });
    buffer.push('corrupt-session', {
      updateType: 'user-message',
      messageId: 'm1',
      text: 'before corruption',
      timestamp: Date.now(),
    });
    await buffer.flushPersistence();

    const journalPath = path.join(storageDir, 'corrupt-session.jsonl');
    await fs.appendFile(journalPath, '{"bad json"\n', 'utf8');

    const reloaded = new RingBuffer({ sessionId: 'corrupt-session', storageDir });
    await reloaded.flushPersistence();
    expect(reloaded.getAll().map((entry) => entry.seq)).toEqual([1]);
    const journalLines = (await fs.readFile(journalPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(journalLines).toHaveLength(1);
  });

  it('fails open to in-memory replay when durable storage cannot be initialized', async () => {
    const storageFile = path.join(await makeStorageDir(), 'replay-as-file');
    await fs.writeFile(storageFile, 'not a directory', 'utf8');

    const buffer = new RingBuffer({ sessionId: 'memory-only-session', storageDir: storageFile });
    buffer.push('memory-only-session', {
      updateType: 'state-change',
      state: 'running',
      timestamp: Date.now(),
    });
    buffer.push('memory-only-session', {
      updateType: 'state-change',
      state: 'idle',
      timestamp: Date.now(),
    });

    expect(buffer.getAll().map((entry) => entry.seq)).toEqual([1, 2]);
    await expect(
      fs.access(path.join(storageFile, 'memory-only-session.meta.json')),
    ).rejects.toThrow();
  });
});
