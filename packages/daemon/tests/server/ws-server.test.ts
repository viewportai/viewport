import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerWsServer } from '../../src/server/ws-server.js';
import { Daemon } from '../../src/core/daemon.js';
import { RingBuffer } from '../../src/server/ring-buffer.js';

/**
 * Buffered WebSocket wrapper — attaches message listener immediately on creation
 * so no messages are lost between connect and the first waitForMessage call.
 * Required because @fastify/websocket v11 delivers the server-side hello
 * before the client's 'open' event fires.
 */
class BufferedWs {
  readonly ws: WebSocket;
  private buffer: Record<string, unknown>[] = [];
  private waiters: ((msg: Record<string, unknown>) => void)[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(msg);
      } else {
        this.buffer.push(msg);
      }
    });
  }

  waitForOpen(timeoutMs = 5000): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for open')), timeoutMs);
      this.ws.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  nextMessage(timeoutMs = 5000): Promise<Record<string, unknown>> {
    const buffered = this.buffer.shift();
    if (buffered) return Promise.resolve(buffered);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for message')), timeoutMs);
      this.waiters.push((msg) => {
        clearTimeout(timeout);
        resolve(msg);
      });
    });
  }

  async collectMessages(count: number, timeoutMs = 5000): Promise<Record<string, unknown>[]> {
    const messages: Record<string, unknown>[] = [];
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; i < count; i++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timeout: got ${messages.length}/${count}`);
      messages.push(await this.nextMessage(remaining));
    }
    return messages;
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.terminate();
  }
}

describe('WebSocket Server', () => {
  let tempHome: string;
  let originalHome: string;
  let testDir: string;
  let daemon: Daemon;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-ws-test-'));
    originalHome = process.env['HOME']!;
    process.env['HOME'] = tempHome;

    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-project-'));

    daemon = new Daemon();
    await daemon.initialize();

    app = Fastify();
    await app.register(fastifyWebsocket);
    registerWsServer(app, daemon);
    await app.ready();
  });

  afterAll(async () => {
    await daemon.shutdown();
    await app.close();
    process.env['HOME'] = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function connect(): Promise<BufferedWs> {
    let client: BufferedWs | null = null;
    const ws = (await app.injectWS(
      '/ws',
      {},
      {
        onInit: (rawWs) => {
          client = new BufferedWs(rawWs as unknown as WebSocket);
        },
      },
    )) as unknown as WebSocket;
    if (!client) {
      client = new BufferedWs(ws);
    }
    await client.waitForOpen();
    return client;
  }

  async function expectNoMessage(client: BufferedWs, timeoutMs = 250): Promise<void> {
    await expect(client.nextMessage(timeoutMs)).rejects.toThrow('Timeout');
  }

  // ---------------------------------------------------------------------------
  // hello
  // ---------------------------------------------------------------------------

  it('sends hello on connect', async () => {
    const client = await connect();
    const msg = await client.nextMessage();

    expect(msg.type).toBe('hello');
    expect(msg.machine).toBeDefined();
    expect(msg.directories).toEqual([]);
    expect(msg.activeSessions).toEqual([]);

    client.close();
  });

  it('hello includes registered directories', async () => {
    await daemon.directoryManager.register(testDir);

    const client = await connect();
    const msg = await client.nextMessage();

    expect(msg.type).toBe('hello');
    const dirs = msg.directories as Array<Record<string, unknown>>;
    expect(dirs).toHaveLength(1);
    expect(dirs[0]!.path).toBe(path.resolve(testDir));

    client.close();
  });

  it('returns a fresh sync snapshot on sync-request', async () => {
    await daemon.directoryManager.register(testDir);

    const client = await connect();
    await client.nextMessage(); // compatibility hello

    client.send(JSON.stringify({ type: 'sync-request', requestId: 'req-sync' }));
    const snapshot = await client.nextMessage();
    const ack = await client.nextMessage();

    expect(snapshot.type).toBe('sync-snapshot');
    const dirs = snapshot.directories as Array<Record<string, unknown>>;
    expect(dirs.some((dir) => dir.path === path.resolve(testDir))).toBe(true);
    expect(ack).toMatchObject({
      type: 'ack',
      requestId: 'req-sync',
      status: 'ok',
    });

    client.close();
  });

  // ---------------------------------------------------------------------------
  // validation
  // ---------------------------------------------------------------------------

  it('rejects invalid JSON', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    client.send('not json');
    const ack = await client.nextMessage();
    expect(ack.status).toBe('error');
    expect(ack.error).toContain('Invalid JSON');

    client.close();
  });

  it('rejects payloads above message size limit', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    client.send(
      JSON.stringify({
        type: 'subscribe',
        sessionId: 'large-payload-test',
        requestId: 'req-big',
        pad: 'x'.repeat(1_100_000),
      }),
    );
    const ack = await client.nextMessage();
    expect(ack.status).toBe('error');
    expect(ack.errorCode).toBe('PAYLOAD_TOO_LARGE');

    client.close();
  });

  it('rejects unknown message type', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    client.send(JSON.stringify({ type: 'unknown', requestId: 'req-u' }));
    const ack = await client.nextMessage();
    expect(ack.status).toBe('error');
    expect(ack.requestId).toBe('req-u');

    client.close();
  });

  it('rejects invalid message schema', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    client.send(JSON.stringify({ type: 'kill', requestId: 'req-v' })); // missing sessionId
    const ack = await client.nextMessage();
    expect(ack.status).toBe('error');
    expect(ack.requestId).toBe('req-v');

    client.close();
  });

  it('rejects command messages without requestId', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    client.send(JSON.stringify({ type: 'subscribe', sessionId: 'missing-request-id' }));
    const ack = await client.nextMessage();
    expect(ack.status).toBe('error');
    expect(ack.errorCode).toBe('MISSING_REQUEST_ID');

    client.close();
  });

  // ---------------------------------------------------------------------------
  // subscribe / unsubscribe
  // ---------------------------------------------------------------------------

  it('subscribes and unsubscribes', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    client.send(
      JSON.stringify({ type: 'subscribe', sessionId: 'test-session', requestId: 'req-1' }),
    );
    const ack = await client.nextMessage();
    expect(ack.type).toBe('ack');
    expect(ack.requestId).toBe('req-1');
    expect(ack.status).toBe('ok');

    client.send(
      JSON.stringify({ type: 'unsubscribe', sessionId: 'test-session', requestId: 'req-2' }),
    );
    const ack2 = await client.nextMessage();
    expect(ack2.requestId).toBe('req-2');
    expect(ack2.status).toBe('ok');

    client.close();
  });

  // ---------------------------------------------------------------------------
  // kill — error case
  // ---------------------------------------------------------------------------

  it('kill returns error for unknown session', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    client.send(JSON.stringify({ type: 'kill', sessionId: 'nonexistent', requestId: 'req-k' }));
    const ack = await client.nextMessage();
    expect(ack.requestId).toBe('req-k');
    expect(ack.status).toBe('error');
    expect(ack.error).toContain('No active session');

    client.close();
  });

  // ---------------------------------------------------------------------------
  // prompt — error case
  // ---------------------------------------------------------------------------

  it('prompt returns error for unknown session', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    client.send(
      JSON.stringify({
        type: 'prompt',
        sessionId: 'nonexistent',
        text: 'hello',
        requestId: 'req-p',
      }),
    );
    const ack = await client.nextMessage();
    expect(ack.requestId).toBe('req-p');
    expect(ack.status).toBe('error');

    client.close();
  });

  it('prompt rejects empty text with EMPTY_PROMPT', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    client.send(
      JSON.stringify({
        type: 'prompt',
        sessionId: 'any-session',
        text: '   ',
        requestId: 'req-empty-prompt',
      }),
    );
    const ack = await client.nextMessage();
    expect(ack.requestId).toBe('req-empty-prompt');
    expect(ack.status).toBe('error');
    expect(ack.errorCode).toBe('EMPTY_PROMPT');

    client.close();
  });

  // ---------------------------------------------------------------------------
  // rollback — validation
  // ---------------------------------------------------------------------------

  it('rollback validates SHA format', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    client.send(
      JSON.stringify({
        type: 'rollback',
        sessionId: 'test',
        toSha: 'not-a-sha',
        requestId: 'req-r',
      }),
    );
    const ack = await client.nextMessage();
    expect(ack.status).toBe('error');

    client.close();
  });

  // ---------------------------------------------------------------------------
  // reconnect replay
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // error code surfacing
  // ---------------------------------------------------------------------------

  it('surfaces ViewportError code in ack errorCode field', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    // prompt for a nonexistent session — should result in SESSION_NOT_FOUND
    client.send(
      JSON.stringify({
        type: 'prompt',
        sessionId: 'nonexistent',
        text: 'hello',
        requestId: 'req-err',
      }),
    );
    const ack = await client.nextMessage();
    expect(ack.requestId).toBe('req-err');
    expect(ack.status).toBe('error');
    // The daemon throws ViewportError with SESSION_NOT_FOUND
    expect(ack.errorCode).toBe('SESSION_NOT_FOUND');

    client.close();
  });

  it('reads discovered session messages over a real websocket round trip', async () => {
    const directory = await daemon.directoryManager.register(testDir);
    const buffer = new RingBuffer({ sessionId: 'ws-history-session' });
    buffer.setDirectoryId(directory.id);
    buffer.push('ws-history-session', {
      updateType: 'user-message',
      messageId: 'ws-history-user',
      text: 'show websocket transcript',
      timestamp: Date.now(),
    });
    buffer.push('ws-history-session', {
      updateType: 'agent-message',
      messageId: 'ws-history-agent',
      text: 'websocket transcript response',
      timestamp: Date.now() + 1,
    });
    await buffer.flushPersistence();

    const client = await connect();
    await client.nextMessage(); // hello

    client.send(
      JSON.stringify({
        type: 'read-session-messages',
        directoryId: directory.id,
        sessionId: 'ws-history-session',
        requestId: 'req-read-session',
      }),
    );

    const ack = await client.nextMessage();
    expect(ack).toMatchObject({
      type: 'ack',
      requestId: 'req-read-session',
      status: 'ok',
      truncated: false,
      originalReturned: 2,
      droppedCount: 0,
    });
    expect(
      (ack.messages as Array<{ text?: string }>).map((message) => message.text).filter(Boolean),
    ).toEqual(['show websocket transcript', 'websocket transcript response']);

    client.close();
  });

  it('streams discovered session messages as a page event over a real websocket round trip', async () => {
    const directory = await daemon.directoryManager.register(testDir);
    const buffer = new RingBuffer({ sessionId: 'ws-stream-history-session' });
    buffer.setDirectoryId(directory.id);
    buffer.push('ws-stream-history-session', {
      updateType: 'user-message',
      messageId: 'ws-stream-user',
      text: 'show streamed websocket transcript',
      timestamp: Date.now(),
    });
    buffer.push('ws-stream-history-session', {
      updateType: 'agent-message',
      messageId: 'ws-stream-agent',
      text: 'streamed websocket transcript response',
      timestamp: Date.now() + 1,
    });
    await buffer.flushPersistence();

    const client = await connect();
    await client.nextMessage(); // hello

    client.send(
      JSON.stringify({
        type: 'read-session-messages',
        directoryId: directory.id,
        sessionId: 'ws-stream-history-session',
        requestId: 'req-stream-session',
        delivery: 'event-stream',
      }),
    );

    const ack = await client.nextMessage();
    expect(ack).toMatchObject({
      type: 'ack',
      requestId: 'req-stream-session',
      status: 'ok',
      streamed: true,
    });
    expect(ack).not.toHaveProperty('messages');

    const page = await client.nextMessage();
    expect(page).toMatchObject({
      type: 'session-messages-page',
      requestId: 'req-stream-session',
      directoryId: directory.id,
      sessionId: 'ws-stream-history-session',
      final: true,
      truncated: false,
      originalReturned: 2,
      droppedCount: 0,
    });
    expect(
      (page.messages as Array<{ text?: string }>).map((message) => message.text).filter(Boolean),
    ).toEqual(['show streamed websocket transcript', 'streamed websocket transcript response']);

    client.close();
  });

  // ---------------------------------------------------------------------------
  // session:ended broadcasts
  // ---------------------------------------------------------------------------

  it('session:ended broadcasts session-ended and attention update', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    // Subscribe to a session
    client.send(
      JSON.stringify({ type: 'subscribe', sessionId: 'end-test-session', requestId: 'rs' }),
    );
    await client.nextMessage(); // ack

    // Emit session:ended
    daemon.emit('session:ended', { sessionId: 'end-test-session', reason: 'completed' });

    // Should get: state-change update, attention update, session-alert, and session-ended message
    const messages = await client.collectMessages(4);
    const stateChange = messages.find(
      (m) =>
        m.type === 'session-update' &&
        (m.update as Record<string, unknown>)?.updateType === 'state-change',
    );
    const attention = messages.find(
      (m) =>
        m.type === 'session-update' &&
        (m.update as Record<string, unknown>)?.updateType === 'attention',
    );
    const ended = messages.find((m) => m.type === 'session-ended');

    expect(stateChange).toBeDefined();
    expect(attention).toBeDefined();
    expect((attention?.update as Record<string, unknown>)?.reason).toBe('completed');
    expect(ended).toBeDefined();
    expect(ended?.reason).toBe('completed');

    client.close();
  });

  it('session:ended with error reason keeps errored state and errored attention', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    client.send(
      JSON.stringify({ type: 'subscribe', sessionId: 'end-test-error', requestId: 'rse' }),
    );
    await client.nextMessage(); // ack

    daemon.emit('session:ended', { sessionId: 'end-test-error', reason: 'error: boom' });

    const messages = await client.collectMessages(3);
    const stateChange = messages.find(
      (m) =>
        m.type === 'session-update' &&
        (m.update as Record<string, unknown>)?.updateType === 'state-change',
    );
    const attention = messages.find(
      (m) =>
        m.type === 'session-update' &&
        (m.update as Record<string, unknown>)?.updateType === 'attention',
    );

    expect((stateChange?.update as Record<string, unknown>)?.state).toBe('errored');
    expect((attention?.update as Record<string, unknown>)?.reason).toBe('errored');

    client.close();
  });

  it('permission response broadcasts permission-resolved and clears attention', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    client.send(
      JSON.stringify({ type: 'subscribe', sessionId: 'perm-test-session', requestId: 'perm-sub' }),
    );
    await client.nextMessage(); // ack

    daemon.emit('permission:responded', {
      sessionId: 'perm-test-session',
      requestId: 'req-123',
      decision: { behavior: 'allow' },
    });

    const messages = await client.collectMessages(2);
    const resolved = messages.find(
      (m) =>
        m.type === 'session-update' &&
        (m.update as Record<string, unknown>)?.updateType === 'permission-resolved',
    );
    const attention = messages.find(
      (m) =>
        m.type === 'session-update' &&
        (m.update as Record<string, unknown>)?.updateType === 'attention',
    );

    expect(resolved).toBeDefined();
    expect((resolved?.update as Record<string, unknown>)?.requestId).toBe('req-123');
    expect(attention).toBeDefined();
    expect((attention?.update as Record<string, unknown>)?.requiresAttention).toBe(false);

    client.close();
  });

  it('broadcasts lightweight session alerts globally for permission requests', async () => {
    const focused = await connect();
    const passive = await connect();
    await focused.nextMessage(); // hello
    await passive.nextMessage(); // hello

    daemon.emit('permission:requested', {
      sessionId: 'bg-attn-session',
      request: {
        requestId: 'req-bg-attn',
        toolName: 'Bash',
        description: 'needs approval',
        input: { command: 'npm test' },
      },
    });

    const alertFocused = await focused.nextMessage();
    const alertPassive = await passive.nextMessage();

    expect(alertFocused.type).toBe('session-alert');
    expect(alertFocused.sessionId).toBe('bg-attn-session');
    expect(alertFocused.reason).toBe('permission');
    expect(alertFocused.requiresAttention).toBe(true);
    expect(alertFocused.requestId).toBe('req-bg-attn');
    expect(alertFocused.toolName).toBe('Bash');

    expect(alertPassive.type).toBe('session-alert');
    expect(alertPassive.sessionId).toBe('bg-attn-session');
    expect(alertPassive.reason).toBe('permission');
    expect(alertPassive.requiresAttention).toBe(true);
    expect(alertPassive.requestId).toBe('req-bg-attn');
    expect(alertPassive.toolName).toBe('Bash');

    focused.close();
    passive.close();
  });

  // ---------------------------------------------------------------------------
  // hook + discovery broadcasts
  // ---------------------------------------------------------------------------

  it('broadcasts hook notification events to connected clients', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    daemon.emit('hook:notification', {
      sessionId: 'hook-session-1',
      adapter: 'claude',
      message: 'tool completed',
      title: 'notice',
      notificationType: 'info',
    });

    const msg = await client.nextMessage();
    expect(msg.type).toBe('hook-notification');
    expect(msg.sessionId).toBe('hook-session-1');
    expect(msg.adapter).toBe('claude');
    expect(msg.message).toBe('tool completed');

    client.close();
  });

  it('sends discovered session tail only to clients watching that session', async () => {
    const watcher = await connect();
    const passive = await connect();
    await watcher.nextMessage(); // hello
    await passive.nextMessage(); // hello

    watcher.send(
      JSON.stringify({
        type: 'watch-discovered-session',
        sessionId: 'discovered-1',
        directoryId: 'dir-1',
        requestId: 'watch-1',
      }),
    );
    const watchAck = await watcher.nextMessage();
    expect(watchAck.status).toBe('ok');

    daemon.emit('discovery:session-tail', {
      sessionId: 'discovered-1',
      directoryId: 'dir-1',
      newBlocks: [
        {
          role: 'user',
          content: 'hello from discovery',
          timestamp: Date.now(),
          uuid: 'u1',
        } as any,
      ],
    });

    const watcherMsg = await watcher.nextMessage();
    expect(watcherMsg.type).toBe('discovered-session-tail');
    expect(watcherMsg.sessionId).toBe('discovered-1');
    await expectNoMessage(passive);

    watcher.close();
    passive.close();
  });

  it('delivers discovered tail updates when session id aliases drift (codex discovered flow)', async () => {
    const watcher = await connect();
    await watcher.nextMessage(); // hello

    watcher.send(
      JSON.stringify({
        type: 'watch-discovered-session',
        sessionId: 'codex-file-id',
        directoryId: 'dir-1',
        requestId: 'watch-codex-alias',
      }),
    );
    const watchAck = await watcher.nextMessage();
    expect(watchAck.status).toBe('ok');

    // Reproduces codex discovered-session id drift:
    // file basename id watched by UI, then tailer resolves canonical thread id.
    daemon.emit('discovery:session-tail', {
      sessionId: 'codex-thread-id',
      sessionIds: ['codex-file-id', 'codex-thread-id'],
      directoryId: 'dir-1',
      newBlocks: [
        {
          role: 'assistant',
          content: 'live codex chunk',
          timestamp: Date.now(),
          uuid: 'codex-u1',
        } as any,
      ],
    });

    const msg = await watcher.nextMessage();
    expect(msg.type).toBe('discovered-session-tail');
    // Server should echo matched watched id to keep UI scoped to open view.
    expect(msg.sessionId).toBe('codex-file-id');

    watcher.close();
  });

  // ---------------------------------------------------------------------------
  // subscribe replay count
  // ---------------------------------------------------------------------------

  it('subscribe with lastSeq returns correct replayCount', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    // Subscribe to a session and buffer some updates
    client.send(
      JSON.stringify({ type: 'subscribe', sessionId: 'replay-count-session', requestId: 'rc1' }),
    );
    await client.nextMessage(); // ack

    // Emit 3 updates
    daemon.emit('session:message', {
      sessionId: 'replay-count-session',
      message: { type: 'agent_message', text: 'A', messageId: 'a1', timestamp: Date.now() },
    });
    daemon.emit('session:message', {
      sessionId: 'replay-count-session',
      message: { type: 'agent_message', text: 'B', messageId: 'a2', timestamp: Date.now() },
    });
    daemon.emit('session:message', {
      sessionId: 'replay-count-session',
      message: { type: 'agent_message', text: 'C', messageId: 'a3', timestamp: Date.now() },
    });

    await client.collectMessages(3); // consume the 3 updates
    client.close();

    // New client subscribes with lastSeq=1 — should get 2 replayed + ack
    const client2 = await connect();
    await client2.nextMessage(); // hello
    client2.send(
      JSON.stringify({
        type: 'subscribe',
        sessionId: 'replay-count-session',
        lastSeq: 1,
        requestId: 'rc2',
      }),
    );

    const msgs = await client2.collectMessages(3); // 2 replays + 1 ack
    const ack = msgs.find((m) => m.type === 'ack');
    expect(ack).toBeDefined();
    expect((ack as Record<string, unknown>).replayCount).toBe(2);
    expect((ack as Record<string, unknown>).droppedWindow).toBe(false);

    client2.close();
  });

  // ---------------------------------------------------------------------------
  // streaming state
  // ---------------------------------------------------------------------------

  it('emits streaming-state update when chunks start and stop', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    client.send(
      JSON.stringify({ type: 'subscribe', sessionId: 'stream-test-session', requestId: 'st1' }),
    );
    await client.nextMessage(); // ack

    // Emit a chunk → should trigger streaming=true
    daemon.emit('session:message', {
      sessionId: 'stream-test-session',
      message: {
        type: 'agent_message_chunk',
        text: 'partial',
        messageId: 'c1',
        timestamp: Date.now(),
      },
    });

    // Should get: the chunk update + streaming-state update
    const msgs1 = await client.collectMessages(2);
    const streamOn = msgs1.find(
      (m) =>
        m.type === 'session-update' &&
        (m.update as Record<string, unknown>)?.updateType === 'streaming-state',
    );
    expect(streamOn).toBeDefined();
    expect((streamOn?.update as Record<string, unknown>)?.streaming).toBe(true);

    // Emit a non-chunk message → should trigger streaming=false
    daemon.emit('session:message', {
      sessionId: 'stream-test-session',
      message: { type: 'agent_message', text: 'full', messageId: 'f1', timestamp: Date.now() },
    });

    const msgs2 = await client.collectMessages(2);
    const streamOff = msgs2.find(
      (m) =>
        m.type === 'session-update' &&
        (m.update as Record<string, unknown>)?.updateType === 'streaming-state',
    );
    expect(streamOff).toBeDefined();
    expect((streamOff?.update as Record<string, unknown>)?.streaming).toBe(false);

    client.close();
  });

  it('does not emit duplicate streaming-state for consecutive chunks', async () => {
    const client = await connect();
    await client.nextMessage(); // hello

    client.send(
      JSON.stringify({ type: 'subscribe', sessionId: 'stream-dedup-session', requestId: 'sd1' }),
    );
    await client.nextMessage(); // ack

    // Emit two consecutive chunks
    daemon.emit('session:message', {
      sessionId: 'stream-dedup-session',
      message: { type: 'agent_message_chunk', text: 'a', messageId: 'c1', timestamp: Date.now() },
    });
    daemon.emit('session:message', {
      sessionId: 'stream-dedup-session',
      message: { type: 'agent_message_chunk', text: 'b', messageId: 'c2', timestamp: Date.now() },
    });

    // Should get: chunk update + streaming-state, then just chunk update (no duplicate streaming-state)
    const msgs = await client.collectMessages(3);
    const streamUpdates = msgs.filter(
      (m) =>
        m.type === 'session-update' &&
        (m.update as Record<string, unknown>)?.updateType === 'streaming-state',
    );
    expect(streamUpdates).toHaveLength(1); // Only one transition

    client.close();
  });

  // ---------------------------------------------------------------------------
  // reconnect replay (existing test)
  // ---------------------------------------------------------------------------

  it('replays missed updates on subscribe with lastSeq', async () => {
    // First client subscribes to see updates buffered
    const client1 = await connect();
    await client1.nextMessage(); // hello
    client1.send(
      JSON.stringify({ type: 'subscribe', sessionId: 'replay-session', requestId: 'r1' }),
    );
    await client1.nextMessage(); // ack

    // Emit some session updates
    daemon.emit('session:message', {
      sessionId: 'replay-session',
      message: { type: 'agent_message', text: 'First', messageId: 'm1', timestamp: Date.now() },
    });
    daemon.emit('session:message', {
      sessionId: 'replay-session',
      message: { type: 'agent_message', text: 'Second', messageId: 'm2', timestamp: Date.now() },
    });
    daemon.emit('session:message', {
      sessionId: 'replay-session',
      message: { type: 'agent_message', text: 'Third', messageId: 'm3', timestamp: Date.now() },
    });

    // Wait for the 3 updates to arrive at client1
    const updates1 = await client1.collectMessages(3);
    expect(updates1.every((m) => m.type === 'session-update')).toBe(true);

    client1.close();

    // Second client subscribes with lastSeq=1 (should get updates 2 and 3)
    const client2 = await connect();
    await client2.nextMessage(); // hello

    client2.send(
      JSON.stringify({
        type: 'subscribe',
        sessionId: 'replay-session',
        lastSeq: 1,
        requestId: 'r2',
      }),
    );

    // Should get: 2 replay messages + 1 ack
    const messages = await client2.collectMessages(3);
    const replayed = messages.filter((m) => m.type === 'session-update');
    const ack = messages.find((m) => m.type === 'ack');

    expect(replayed).toHaveLength(2);
    expect(ack).toBeDefined();
    expect((ack as Record<string, unknown>).status).toBe('ok');

    client2.close();
  });

  it('replays durable history after server restart from the persisted journal', async () => {
    const sessionId = 'restart-replay-session';

    const firstDaemon = new Daemon();
    await firstDaemon.initialize();
    const firstApp = Fastify();
    await firstApp.register(fastifyWebsocket);
    registerWsServer(firstApp, firstDaemon);
    await firstApp.ready();

    firstDaemon.emit('session:message', {
      sessionId,
      message: {
        type: 'user_message',
        text: 'persisted prompt',
        messageId: 'persisted-user',
        timestamp: Date.now(),
      },
    });
    firstDaemon.emit('session:message', {
      sessionId,
      message: {
        type: 'agent_message_chunk',
        text: 'transient chunk',
        messageId: 'persisted-chunk',
        timestamp: Date.now(),
      },
    });
    firstDaemon.emit('session:message', {
      sessionId,
      message: {
        type: 'agent_message',
        text: 'persisted reply',
        messageId: 'persisted-agent',
        timestamp: Date.now(),
      },
    });

    await firstDaemon.shutdown();
    await firstApp.close();

    const secondDaemon = new Daemon();
    await secondDaemon.initialize();
    const secondApp = Fastify();
    await secondApp.register(fastifyWebsocket);
    registerWsServer(secondApp, secondDaemon);
    await secondApp.ready();

    let restartedClient: BufferedWs | null = null;
    const restartedWs = (await secondApp.injectWS(
      '/ws',
      {},
      {
        onInit: (rawWs) => {
          restartedClient = new BufferedWs(rawWs as unknown as WebSocket);
        },
      },
    )) as unknown as WebSocket;
    const client = restartedClient ?? new BufferedWs(restartedWs);
    await client.waitForOpen();
    await client.nextMessage(); // hello

    client.send(
      JSON.stringify({
        type: 'subscribe',
        sessionId,
        lastSeq: 0,
        requestId: 'restart-replay',
      }),
    );

    const messages = await client.collectMessages(3);
    const replayed = messages.filter((message) => message.type === 'session-update');
    const ack = messages.find((message) => message.type === 'ack');

    expect(replayed).toHaveLength(2);
    expect(replayed.map((message) => Number(message.seq))).toEqual([1, 4]);
    expect(
      replayed.map((message) => (message.update as Record<string, unknown>)?.['text']),
    ).toEqual(['persisted prompt', 'persisted reply']);
    expect((ack as Record<string, unknown>).latestAvailableSeq).toBe(5);

    client.close();
    await secondDaemon.shutdown();
    await secondApp.close();
  });
});
