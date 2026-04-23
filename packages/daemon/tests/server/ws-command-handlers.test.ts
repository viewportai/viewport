import { describe, it, expect, vi } from 'vitest';
import { createWsCommandHandlers } from '../../src/server/ws-command-handlers.js';
import type { ConnectedClient } from '../../src/server/hello-builder.js';
import { discoveredWatchKey } from '../../src/server/discovered-watch-key.js';

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
    const sessions = sessionList?.['sessions'] as Array<Record<string, unknown>>;
    expect(sessions[0]?.['agentId']).toBe('codex');
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

    expect(resumeSession).toHaveBeenCalledWith('s1', 'dir-1', undefined, {
      agent: 'gemini',
      model: 'gemini-pro',
    });
    const started = sent.find((m) => m['type'] === 'session-started');
    expect(started?.['agent']).toBe('gemini');
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
      prompt: 'continue',
      requestId: 'req-launch',
    });

    expect(launchSession).toHaveBeenCalledWith('dir-1', '', undefined);
    expect(sendPrompt).toHaveBeenCalledWith('s-new', 'continue');
    expect(sent.find((m) => m['type'] === 'session-started')).toBeTruthy();
    expect(sent.find((m) => m['type'] === 'session-update')).toBeTruthy();
    expect(sendAck).toHaveBeenCalledWith(client, 'req-launch', 'ok');
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
      prompt: 'keep going',
      requestId: 'req-resume',
    });

    expect(resumeSession).toHaveBeenCalledWith('s1', 'dir-1', undefined, { agent: 'claude' });
    expect(sendPrompt).toHaveBeenCalledWith('s1', 'keep going');
    expect(sent.find((m) => m['type'] === 'session-started')).toBeTruthy();
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
