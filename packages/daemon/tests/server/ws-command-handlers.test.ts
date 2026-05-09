import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWsCommandHandlers } from '../../src/server/ws-command-handlers.js';
import {
  fitMessagesForAck,
  SESSION_MESSAGES_ACK_PLAINTEXT_LIMIT_BYTES,
} from '../../src/server/ws-session-command-handlers.js';
import type { ConnectedClient } from '../../src/server/hello-builder.js';
import { discoveredWatchKey } from '../../src/server/discovered-watch-key.js';
import { ViewportError } from '../../src/core/errors.js';

function createClient(): { client: ConnectedClient; sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const client: ConnectedClient = {
    send: (data: string) => {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    },
    subscriptions: new Set(),
    watchedDiscoveredSessions: new Set(),
    pendingBytes: 0,
  };
  return { client, sent };
}

describe('ws-command-handlers', () => {
  const getOrCreateBuffer = vi.fn(() => ({
    getAll: () => [],
    getReplayWindow: () => ({
      entries: [],
      droppedWindow: false,
      requestedLastSeq: 0,
      earliestAvailableSeq: 0,
      latestAvailableSeq: 0,
    }),
  }));

  it('list-sessions includes agentId in payload', async () => {
    const { client, sent } = createClient();
    const daemon = {
      directoryManager: { get: vi.fn().mockReturnValue({ id: 'dir-1', path: '/tmp/project' }) },
      configManager: {
        getConfig: vi.fn().mockReturnValue({}),
      },
      getDiscoveredSessions: vi.fn().mockReturnValue(
        new Map([
          [
            'dir-1',
            [
              {
                agentId: 'codex',
                sessionId: 's1',
                summary: 'Fix issue',
                lastModified: 123,
                resumable: true,
                messageCount: 4,
              },
            ],
          ],
        ]),
      ),
    };
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: daemon as any,
      sendAck,
      getOrCreateBuffer: getOrCreateBuffer as any,
    });

    await handlers['list-sessions'](client, {
      type: 'list-sessions',
      directoryId: 'dir-1',
      requestId: 'req-1',
    });

    const sessionList = sent.find((m) => m['type'] === 'session-list');
    expect(sessionList).toBeTruthy();
    expect(sessionList).toMatchObject({
      offset: 0,
      limit: 50,
      hasMore: false,
    });
    const sessions = sessionList?.['sessions'] as Array<Record<string, unknown>>;
    expect(sessions[0]?.['agentId']).toBe('codex');
    expect(sessions[0]).toMatchObject({
      directoryId: 'dir-1',
      workingDirectory: '/tmp/project',
    });
    expect(sessions[0]).not.toHaveProperty('projectId');
    expect(sessions[0]).not.toHaveProperty('projectBindingSource');
    expect(sendAck).toHaveBeenCalledWith(client, 'req-1', 'ok');
  });

  it('resume rejects missing discovered session', async () => {
    const { client } = createClient();
    const daemon = {
      directoryManager: { get: vi.fn().mockReturnValue({ id: 'dir-1', path: '/tmp/project' }) },
      getDiscoveredSessions: vi.fn().mockReturnValue(new Map([['dir-1', []]])),
    };
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: daemon as any,
      sendAck,
      getOrCreateBuffer: getOrCreateBuffer as any,
    });

    await handlers['resume'](client, {
      type: 'resume',
      directoryId: 'dir-1',
      sessionId: 'missing',
      requestId: 'req-2',
    });

    expect(sendAck).toHaveBeenCalledWith(
      client,
      'req-2',
      'error',
      expect.stringContaining('Discovered session not found'),
      { errorCode: 'DISCOVERED_SESSION_NOT_FOUND' },
    );
  });

  it('resume rejects discovered sessions that the agent cannot resume', async () => {
    const { client } = createClient();
    const daemon = {
      directoryManager: { get: vi.fn().mockReturnValue({ id: 'dir-1', path: '/tmp/project' }) },
      getDiscoveredSessions: vi.fn().mockReturnValue(
        new Map([
          [
            'dir-1',
            [
              {
                agentId: 'aider',
                sessionId: 'not-resumable',
                summary: 'Cannot resume me',
                lastModified: 123,
                resumable: false,
              },
            ],
          ],
        ]),
      ),
      resumeSession: vi.fn(),
    };
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: daemon as any,
      sendAck,
      getOrCreateBuffer: getOrCreateBuffer as any,
    });

    await handlers['resume'](client, {
      type: 'resume',
      directoryId: 'dir-1',
      sessionId: 'not-resumable',
      requestId: 'req-not-resumable',
    });

    expect(daemon.resumeSession).not.toHaveBeenCalled();
    expect(sendAck).toHaveBeenCalledWith(
      client,
      'req-not-resumable',
      'error',
      expect.stringContaining('Session is not resumable'),
      { errorCode: 'SESSION_NOT_RESUMABLE' },
    );
  });

  it('read-session-messages distinguishes missing directory and missing discovered session', async () => {
    const { client } = createClient();
    const daemon = {
      directoryManager: {
        get: vi.fn((id: string) => (id === 'dir-1' ? { id, path: '/tmp/project' } : undefined)),
      },
      getDiscoveredSessions: vi.fn().mockReturnValue(new Map([['dir-1', []]])),
    };
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: daemon as any,
      sendAck,
      getOrCreateBuffer: getOrCreateBuffer as any,
    });

    await handlers['read-session-messages'](client, {
      type: 'read-session-messages',
      directoryId: 'missing-dir',
      sessionId: 'session-1',
      requestId: 'req-missing-dir',
    });
    await handlers['read-session-messages'](client, {
      type: 'read-session-messages',
      directoryId: 'dir-1',
      sessionId: 'missing-session',
      requestId: 'req-missing-session',
    });

    expect(sendAck).toHaveBeenNthCalledWith(
      1,
      client,
      'req-missing-dir',
      'error',
      expect.stringContaining('Directory not found'),
      { errorCode: 'DIRECTORY_NOT_FOUND' },
    );
    expect(sendAck).toHaveBeenNthCalledWith(
      2,
      client,
      'req-missing-session',
      'error',
      expect.stringContaining('Discovered session not found'),
      { errorCode: 'DISCOVERED_SESSION_NOT_FOUND' },
    );
  });

  it('read-session-messages falls back to discovered transcript when stale replay metadata is empty', async () => {
    const previousViewportHome = process.env['VIEWPORT_HOME'];
    const previousCodexHome = process.env['CODEX_HOME'];
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-stale-replay-'));
    try {
      process.env['VIEWPORT_HOME'] = path.join(temp, 'viewport-home');
      process.env['CODEX_HOME'] = path.join(temp, 'codex-home');
      const sessionId = 'codex-stale-replay-session';
      const replayDir = path.join(process.env['VIEWPORT_HOME'], 'replay');
      const codexDir = path.join(process.env['CODEX_HOME'], 'sessions', '2026', '05', '09');
      await fs.mkdir(replayDir, { recursive: true });
      await fs.mkdir(codexDir, { recursive: true });
      await fs.writeFile(
        path.join(replayDir, `${encodeURIComponent(sessionId)}.meta.json`),
        JSON.stringify({ sessionId, directoryId: 'dir-1', latestSeq: 1 }) + '\n',
        'utf-8',
      );
      const sourcePath = path.join(codexDir, `rollout-2026-05-09T00-00-00-${sessionId}.jsonl`);
      await fs.writeFile(
        sourcePath,
        [
          JSON.stringify({
            timestamp: '2026-05-09T00:00:00.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'history from discovered transcript' }],
            },
          }),
        ].join('\n'),
        'utf-8',
      );

      const { client } = createClient();
      const daemon = {
        directoryManager: {
          get: vi.fn((id: string) => (id === 'dir-1' ? { id, path: '/tmp/project' } : undefined)),
        },
        getDiscoveredSessions: vi.fn().mockReturnValue(
          new Map([
            [
              'dir-1',
              [
                {
                  agentId: 'codex',
                  sessionId,
                  summary: 'Codex history',
                  lastModified: Date.now(),
                  resumable: true,
                  messageCount: 1,
                  sourcePath,
                },
              ],
            ],
          ]),
        ),
      };
      const sendAck = vi.fn();
      const handlers = createWsCommandHandlers({
        daemon: daemon as any,
        sendAck,
        getOrCreateBuffer: getOrCreateBuffer as any,
      });

      await handlers['read-session-messages'](client, {
        type: 'read-session-messages',
        directoryId: 'dir-1',
        sessionId,
        requestId: 'req-history',
        limit: 100,
      });

      expect(sendAck).toHaveBeenCalledWith(
        client,
        'req-history',
        'ok',
        undefined,
        expect.objectContaining({
          nextOffset: 1,
          hasMoreBefore: false,
          messages: [
            expect.objectContaining({
              kind: 'text',
              text: 'history from discovered transcript',
            }),
          ],
        }),
      );
    } finally {
      if (previousViewportHome === undefined) {
        delete process.env['VIEWPORT_HOME'];
      } else {
        process.env['VIEWPORT_HOME'] = previousViewportHome;
      }
      if (previousCodexHome === undefined) {
        delete process.env['CODEX_HOME'];
      } else {
        process.env['CODEX_HOME'] = previousCodexHome;
      }
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it('read-session-messages can stream the transcript page before acknowledging', async () => {
    const previousViewportHome = process.env['VIEWPORT_HOME'];
    const previousCodexHome = process.env['CODEX_HOME'];
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-streamed-history-'));
    try {
      process.env['VIEWPORT_HOME'] = path.join(temp, 'viewport-home');
      process.env['CODEX_HOME'] = path.join(temp, 'codex-home');
      const sessionId = 'codex-streamed-session';
      const codexDir = path.join(process.env['CODEX_HOME'], 'sessions', '2026', '05', '09');
      await fs.mkdir(codexDir, { recursive: true });
      const sourcePath = path.join(codexDir, `rollout-2026-05-09T00-00-00-${sessionId}.jsonl`);
      await fs.writeFile(
        sourcePath,
        [
          JSON.stringify({
            timestamp: '2026-05-09T00:00:00.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'history sent as page event' }],
            },
          }),
        ].join('\n'),
        'utf-8',
      );

      const { client, sent } = createClient();
      const daemon = {
        directoryManager: {
          get: vi.fn((id: string) => (id === 'dir-1' ? { id, path: '/tmp/project' } : undefined)),
        },
        getDiscoveredSessions: vi.fn().mockReturnValue(
          new Map([
            [
              'dir-1',
              [
                {
                  agentId: 'codex',
                  sessionId,
                  summary: 'Codex history',
                  lastModified: Date.now(),
                  resumable: true,
                  messageCount: 1,
                  sourcePath,
                },
              ],
            ],
          ]),
        ),
      };
      const sendAck = vi.fn();
      const handlers = createWsCommandHandlers({
        daemon: daemon as any,
        sendAck,
        getOrCreateBuffer: getOrCreateBuffer as any,
      });

      await handlers['read-session-messages'](client, {
        type: 'read-session-messages',
        directoryId: 'dir-1',
        sessionId,
        requestId: 'req-stream-history',
        limit: 100,
        delivery: 'event-stream',
      });

      expect(sent).toContainEqual(
        expect.objectContaining({
          type: 'session-messages-page',
          requestId: 'req-stream-history',
          directoryId: 'dir-1',
          sessionId,
          final: true,
          messages: [
            expect.objectContaining({
              kind: 'text',
              text: 'history sent as page event',
            }),
          ],
        }),
      );
      expect(sendAck).toHaveBeenCalledWith(
        client,
        'req-stream-history',
        'ok',
        undefined,
        expect.objectContaining({
          streamed: true,
          accepted: true,
        }),
      );
      expect(sendAck.mock.calls[0]?.[4]).not.toHaveProperty('messages');
    } finally {
      if (previousViewportHome === undefined) {
        delete process.env['VIEWPORT_HOME'];
      } else {
        process.env['VIEWPORT_HOME'] = previousViewportHome;
      }
      if (previousCodexHome === undefined) {
        delete process.env['CODEX_HOME'];
      } else {
        process.env['CODEX_HOME'] = previousCodexHome;
      }
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  it('truncates large transcript ack payloads below the relay-safe plaintext limit', () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      kind: 'tool_result' as const,
      messageId: `large-${index}`,
      timestamp: Date.now() + index,
      toolName: 'shell',
      output: 'x'.repeat(180_000),
    }));

    const fit = fitMessagesForAck(messages as any);
    const bytes = Buffer.byteLength(
      JSON.stringify({
        type: 'ack',
        requestId: 'size-check',
        status: 'ok',
        ...fit,
      }),
    );

    expect(bytes).toBeLessThanOrEqual(SESSION_MESSAGES_ACK_PLAINTEXT_LIMIT_BYTES);
    expect(fit.truncated).toBe(true);
  });

  it('resume uses discovered agent when resuming', async () => {
    const { client, sent } = createClient();
    const resumeSession = vi.fn().mockResolvedValue('s1');
    const daemon = {
      directoryManager: { get: vi.fn().mockReturnValue({ id: 'dir-1', path: '/tmp/project' }) },
      getDiscoveredSessions: vi.fn().mockReturnValue(
        new Map([
          [
            'dir-1',
            [
              {
                agentId: 'gemini',
                sessionId: 's1',
                summary: 'Resume me',
                lastModified: 123,
                resumable: true,
              },
            ],
          ],
        ]),
      ),
      resumeSession,
    };
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: daemon as any,
      sendAck,
      getOrCreateBuffer: getOrCreateBuffer as any,
    });

    await handlers['resume'](client, {
      type: 'resume',
      directoryId: 'dir-1',
      sessionId: 's1',
      model: 'gemini-pro',
      requestId: 'req-3',
    });

    expect(resumeSession).toHaveBeenCalledWith('s1', 'dir-1', '', {
      agent: 'gemini',
      model: 'gemini-pro',
    });
    const started = sent.find((m) => m['type'] === 'session-started');
    expect(started?.['agent']).toBe('gemini');
  });

  it('resume returns structured ack errors from the resume path', async () => {
    const { client } = createClient();
    const resumeSession = vi
      .fn()
      .mockRejectedValue(
        new ViewportError(
          'ADAPTER_NOT_AVAILABLE',
          'No adapter registered for agent: missing-agent',
        ),
      );
    const daemon = {
      directoryManager: { get: vi.fn().mockReturnValue({ id: 'dir-1', path: '/tmp/project' }) },
      getDiscoveredSessions: vi.fn().mockReturnValue(
        new Map([
          [
            'dir-1',
            [
              {
                agentId: 'missing-agent',
                sessionId: 's1',
                summary: 'Resume me',
                lastModified: 123,
                resumable: true,
              },
            ],
          ],
        ]),
      ),
      resumeSession,
    };
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: daemon as any,
      sendAck,
      getOrCreateBuffer: getOrCreateBuffer as any,
    });

    await handlers['resume'](client, {
      type: 'resume',
      directoryId: 'dir-1',
      sessionId: 's1',
      requestId: 'req-adapter-missing',
    });

    expect(sendAck).toHaveBeenCalledWith(
      client,
      'req-adapter-missing',
      'error',
      expect.stringContaining('No adapter registered'),
      { errorCode: 'ADAPTER_NOT_AVAILABLE' },
    );
  });

  it('launch starts session then sends prompt and replays buffered updates', async () => {
    const { client, sent } = createClient();
    const launchSession = vi.fn().mockResolvedValue('s-new');
    const sendPrompt = vi.fn();
    const daemon = {
      directoryManager: { get: vi.fn().mockReturnValue({ id: 'dir-1', path: '/tmp/project' }) },
      launchSession,
      sendPrompt,
    };
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: daemon as any,
      sendAck,
      getOrCreateBuffer: vi.fn(() => ({
        getAll: () => [
          {
            sessionId: 's-new',
            seq: 1,
            update: { updateType: 'user-message', text: 'seed', messageId: 'm1', timestamp: 1 },
          },
        ],
        getReplayWindow: () => ({
          entries: [],
          droppedWindow: false,
          requestedLastSeq: 0,
          earliestAvailableSeq: 0,
          latestAvailableSeq: 0,
        }),
      })) as any,
    });

    await handlers['launch'](client, {
      type: 'launch',
      directoryId: 'dir-1',
      resourceId: 'resource-1',
      prompt: 'continue',
      requestId: 'req-launch',
    });

    expect(launchSession).toHaveBeenCalledWith('dir-1', 'continue', {
      resourceId: 'resource-1',
    });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(sent.find((m) => m['type'] === 'session-started')).toMatchObject({
      resourceId: 'resource-1',
    });
    expect(sent.find((m) => m['type'] === 'session-started')).not.toHaveProperty('projectId');
    expect(sent.find((m) => m['type'] === 'session-update')).toBeTruthy();
    expect(sendAck).toHaveBeenCalledWith(client, 'req-launch', 'ok');
  });

  it('launch accepts resourceId as the resource-first scope', async () => {
    const { client, sent } = createClient();
    const launchSession = vi.fn().mockResolvedValue('s-resource');
    const daemon = {
      directoryManager: {
        get: vi.fn().mockReturnValue({ id: 'dir-1', path: '/tmp/resource-repo' }),
      },
      launchSession,
      sendPrompt: vi.fn(),
    };
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: daemon as any,
      sendAck,
      getOrCreateBuffer: vi.fn(() => ({
        getAll: () => [],
        getReplayWindow: () => ({
          entries: [],
          droppedWindow: false,
          requestedLastSeq: 0,
          earliestAvailableSeq: 0,
          latestAvailableSeq: 0,
        }),
      })) as any,
    });

    await handlers['launch'](client, {
      type: 'launch',
      directoryId: 'dir-1',
      resourceId: 'resource-1',
      requestId: 'req-resource-launch',
    });

    expect(launchSession).toHaveBeenCalledWith('dir-1', '', { resourceId: 'resource-1' });
    expect(sent.find((m) => m['type'] === 'session-started')).toMatchObject({
      resourceId: 'resource-1',
    });
    expect(sent.find((m) => m['type'] === 'session-started')).not.toHaveProperty('projectId');
    expect(sendAck).toHaveBeenCalledWith(client, 'req-resource-launch', 'ok');
  });

  it('resume replays buffered updates and sends prompt after attach', async () => {
    const { client, sent } = createClient();
    const resumeSession = vi.fn().mockResolvedValue('s1');
    const sendPrompt = vi.fn();
    const daemon = {
      directoryManager: { get: vi.fn().mockReturnValue({ id: 'dir-1', path: '/tmp/project' }) },
      getDiscoveredSessions: vi.fn().mockReturnValue(
        new Map([
          [
            'dir-1',
            [
              {
                agentId: 'claude',
                sessionId: 's1',
                summary: 'Resume me',
                lastModified: 1,
                resumable: true,
              },
            ],
          ],
        ]),
      ),
      resumeSession,
      sendPrompt,
    };
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: daemon as any,
      sendAck,
      getOrCreateBuffer: vi.fn(() => ({
        getAll: () => [
          {
            sessionId: 's1',
            seq: 2,
            update: { updateType: 'agent-message', text: 'seed', messageId: 'm2', timestamp: 2 },
          },
        ],
        getReplayWindow: () => ({
          entries: [],
          droppedWindow: false,
          requestedLastSeq: 0,
          earliestAvailableSeq: 0,
          latestAvailableSeq: 0,
        }),
      })) as any,
    });

    await handlers['resume'](client, {
      type: 'resume',
      directoryId: 'dir-1',
      sessionId: 's1',
      resourceId: 'resource-1',
      prompt: 'keep going',
      requestId: 'req-resume',
    });

    expect(resumeSession).toHaveBeenCalledWith('s1', 'dir-1', 'keep going', {
      agent: 'claude',
      resourceId: 'resource-1',
    });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(sent.find((m) => m['type'] === 'session-started')).toMatchObject({
      resourceId: 'resource-1',
    });
    expect(sent.find((m) => m['type'] === 'session-started')).not.toHaveProperty('projectId');
    expect(sent.find((m) => m['type'] === 'session-update')).toBeTruthy();
    expect(sendAck).toHaveBeenCalledWith(client, 'req-resume', 'ok');
  });

  it('prompt rejects empty text', async () => {
    const { client } = createClient();
    const daemon = {
      sendPrompt: vi.fn(),
    };
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: daemon as any,
      sendAck,
      getOrCreateBuffer: getOrCreateBuffer as any,
    });

    await handlers['prompt'](client, {
      type: 'prompt',
      sessionId: 's1',
      text: '   ',
      requestId: 'req-empty',
    });

    expect(daemon.sendPrompt).not.toHaveBeenCalled();
    expect(sendAck).toHaveBeenCalledWith(
      client,
      'req-empty',
      'error',
      'Prompt text must be non-empty',
      { errorCode: 'EMPTY_PROMPT' },
    );
  });

  it('stores and removes discovered watches using directory scope', async () => {
    const { client } = createClient();
    const daemon = {} as Record<string, unknown>;
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: daemon as any,
      sendAck,
      getOrCreateBuffer: getOrCreateBuffer as any,
    });

    await handlers['watch-discovered-session'](client, {
      type: 'watch-discovered-session',
      sessionId: 'disc-1',
      directoryId: 'dir-1',
      requestId: 'watch-1',
    });

    expect(client.watchedDiscoveredSessions.has(discoveredWatchKey('disc-1', 'dir-1'))).toBe(true);

    await handlers['unwatch-discovered-session'](client, {
      type: 'unwatch-discovered-session',
      sessionId: 'disc-1',
      directoryId: 'dir-1',
      requestId: 'unwatch-1',
    });

    expect(client.watchedDiscoveredSessions.has(discoveredWatchKey('disc-1', 'dir-1'))).toBe(false);
    expect(sendAck).toHaveBeenCalledWith(client, 'watch-1', 'ok');
    expect(sendAck).toHaveBeenCalledWith(client, 'unwatch-1', 'ok');
  });

  it('bounds per-client subscription tracking to avoid unbounded growth', async () => {
    const { client } = createClient();
    const daemon = {} as Record<string, unknown>;
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: daemon as any,
      sendAck,
      getOrCreateBuffer: getOrCreateBuffer as any,
    });

    for (let i = 0; i < 1100; i += 1) {
      await handlers['subscribe'](client, {
        type: 'subscribe',
        sessionId: `session-${i}`,
        requestId: `req-${i}`,
      });
    }

    expect(client.subscriptions.size).toBeLessThanOrEqual(1024);
    expect(client.subscriptions.has('session-0')).toBe(false);
    expect(client.subscriptions.has('session-1099')).toBe(true);
  });

  it('bounds discovered watch tracking to avoid unbounded growth', async () => {
    const { client } = createClient();
    const daemon = {} as Record<string, unknown>;
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: daemon as any,
      sendAck,
      getOrCreateBuffer: getOrCreateBuffer as any,
    });

    for (let i = 0; i < 2100; i += 1) {
      await handlers['watch-discovered-session'](client, {
        type: 'watch-discovered-session',
        sessionId: `disc-${i}`,
        directoryId: 'dir-1',
        requestId: `watch-${i}`,
      });
    }

    expect(client.watchedDiscoveredSessions.size).toBeLessThanOrEqual(2048);
    expect(client.watchedDiscoveredSessions.has(discoveredWatchKey('disc-0', 'dir-1'))).toBe(false);
    expect(client.watchedDiscoveredSessions.has(discoveredWatchKey('disc-2099', 'dir-1'))).toBe(
      true,
    );
  });

  it('sync-request sends a fresh sync snapshot before ack', async () => {
    const { client, sent } = createClient();
    const daemon = {
      directoryManager: { list: vi.fn().mockReturnValue([]) },
      getActiveSessions: vi.fn().mockReturnValue([]),
      getDiscoveredSessions: vi.fn().mockReturnValue(new Map()),
      getAvailableAgents: vi.fn().mockReturnValue([]),
      configManager: {
        getMachineId: vi.fn().mockReturnValue('machine-1'),
        getConfig: vi.fn().mockReturnValue({}),
        getDaemonConfig: vi.fn().mockReturnValue({
          profile: 'relay',
          relay: {
            serverUrl: 'https://getviewport.com',
            endpoint: 'wss://relay.getviewport.com/ws',
            workspaceId: 'workspace-1',
          },
          server: {
            url: 'https://getviewport.com',
          },
        }),
      },
    };
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: daemon as any,
      sendAck,
      getOrCreateBuffer: getOrCreateBuffer as any,
    });

    await handlers['sync-request'](client, {
      type: 'sync-request',
      requestId: 'req-sync',
    });

    expect(sent[0]).toMatchObject({
      type: 'sync-snapshot',
      machine: {
        id: 'machine-1',
        runtimeKind: 'managed',
        daemonVersion: expect.any(String),
      },
      directories: [],
      activeSessions: [],
      discoveredSessions: [],
    });
    expect(sendAck).toHaveBeenCalledWith(client, 'req-sync', 'ok');
  });
});
