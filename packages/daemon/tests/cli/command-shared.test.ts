import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const daemonFetchMock = vi.fn();

vi.mock('../../src/cli/daemon-client.js', () => ({
  daemonFetch: daemonFetchMock,
}));

describe('command-shared readiness helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    daemonFetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits until relay reports connected', async () => {
    daemonFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.3.0',
            uptime: 1,
            sessions: 0,
            directories: 0,
            agents: 'none',
            relay: { enabled: true, state: 'connecting', reconnectAttempt: 1 },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.3.0',
            uptime: 2,
            sessions: 0,
            directories: 0,
            agents: 'none',
            relay: { enabled: true, state: 'connected', reconnectAttempt: 0 },
          }),
        ),
      );

    const { waitForDaemonReady } = await import('../../src/cli/command-shared.js');

    const readyPromise = waitForDaemonReady({
      requireRelayConnected: true,
      timeoutMs: 2_000,
      intervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);
    const health = await readyPromise;

    expect(daemonFetchMock).toHaveBeenCalledTimes(2);
    expect(health.relay?.state).toBe('connected');
  });

  it('times out when relay never reconnects', async () => {
    daemonFetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.3.0',
            uptime: 1,
            sessions: 0,
            directories: 0,
            agents: 'none',
            relay: { enabled: true, state: 'waiting_retry', reconnectAttempt: 2 },
          }),
        ),
    );

    const { waitForDaemonReady } = await import('../../src/cli/command-shared.js');

    const readyPromise = waitForDaemonReady({
      requireRelayConnected: true,
      timeoutMs: 250,
      intervalMs: 100,
    });
    const assertion = expect(readyPromise).rejects.toThrow(
      'Timed out waiting for daemon relay reconnect',
    );

    await vi.advanceTimersByTimeAsync(500);

    await assertion;
  });
});
