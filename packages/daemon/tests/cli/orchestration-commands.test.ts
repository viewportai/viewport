import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  daemonFetch: vi.fn(),
  isDaemonRunning: vi.fn(),
  DaemonWsClient: vi.fn(),
}));

vi.mock('../../src/cli/daemon-client.js', () => ({
  daemonFetch: mocks.daemonFetch,
  isDaemonRunning: mocks.isDaemonRunning,
}));

vi.mock('../../src/cli/ws-client.js', () => ({
  DaemonWsClient: mocks.DaemonWsClient,
}));

function createWsStub(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  const listeners = new Set<(msg: unknown) => void>();
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    requestAck: vi.fn().mockResolvedValue({ type: 'ack', status: 'ok' }),
    waitForMessage: vi.fn(),
    onMessage: vi.fn((handler: (msg: unknown) => void) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }),
    emit: (msg: unknown) => {
      for (const listener of listeners) listener(msg);
    },
    ...overrides,
  };
}

describe('orchestration commands', () => {
  const originalArgv = process.argv.slice();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    vi.resetModules();
    mocks.daemonFetch.mockReset();
    mocks.isDaemonRunning.mockReset();
    mocks.DaemonWsClient.mockReset();
    logSpy.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('run launches a session and prints structured json output', async () => {
    process.argv = ['node', 'vpd', 'run', '.', '--prompt', 'hello', '--json'];
    mocks.isDaemonRunning.mockResolvedValue(true);
    mocks.daemonFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([{ id: 'dir-1', path: process.cwd(), name: 'cwd', activeSessions: [] }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const ws = createWsStub({
      waitForMessage: vi.fn().mockResolvedValue({
        type: 'session-started',
        sessionId: 'sess-1',
        directoryId: 'dir-1',
      }),
    });
    mocks.DaemonWsClient.mockImplementationOnce(() => ws);

    const { runSession } = await import('../../src/cli/orchestration-commands.js');
    await runSession();

    expect(ws.requestAck).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'launch',
        directoryId: 'dir-1',
        prompt: 'hello',
      }),
      30_000,
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"schemaVersion": 1'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"command": "run"'));
  });

  it('send forwards prompt payloads to websocket command handler', async () => {
    process.argv = ['node', 'vpd', 'send', 'sess-1', '--prompt', 'continue'];
    mocks.isDaemonRunning.mockResolvedValue(true);

    const ws = createWsStub();
    mocks.DaemonWsClient.mockImplementationOnce(() => ws);

    const { sendPromptCommand } = await import('../../src/cli/orchestration-commands.js');
    await sendPromptCommand();

    expect(ws.requestAck).toHaveBeenCalledWith(
      {
        type: 'prompt',
        sessionId: 'sess-1',
        text: 'continue',
      },
      20_000,
    );
  });

  it('wait resolves when a session-ended event arrives', async () => {
    process.argv = ['node', 'vpd', 'wait', 'sess-1', '--json'];
    mocks.isDaemonRunning.mockResolvedValue(true);

    const ws = createWsStub();
    mocks.DaemonWsClient.mockImplementationOnce(() => ws);

    const { waitCommand } = await import('../../src/cli/orchestration-commands.js');
    const waitPromise = waitCommand();
    setTimeout(() => {
      (ws.emit as (msg: unknown) => void)({
        type: 'session-ended',
        sessionId: 'sess-1',
        reason: 'completed',
      });
    }, 25);
    await waitPromise;

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"schemaVersion": 1'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"command": "wait"'));
  });
});
