import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  daemonFetch: vi.fn(),
  isDaemonRunning: vi.fn(),
}));

vi.mock('../../src/cli/daemon-client.js', () => ({
  daemonFetch: mocks.daemonFetch,
  isDaemonRunning: mocks.isDaemonRunning,
}));

describe('operator CLI commands', () => {
  const originalArgv = process.argv.slice();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    vi.resetModules();
    mocks.daemonFetch.mockReset();
    mocks.isDaemonRunning.mockReset();
    logSpy.mockClear();
    mocks.isDaemonRunning.mockResolvedValue(true);
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('vpd ls returns structured JSON', async () => {
    process.argv = ['node', 'vpd', 'ls', '--json'];
    mocks.daemonFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          sessions: [
            {
              source: 'active',
              sessionId: 'sess-1',
              directoryId: 'dir-1',
              directoryPath: '/tmp/project',
              agentId: 'claude',
              state: 'running',
              mode: 'detect',
              resumable: true,
              lastActivity: null,
              summary: null,
              messageCount: null,
            },
          ],
          counts: { active: 1, discovered: 0, total: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { listSessions } = await import('../../src/cli/session-commands.js');
    await listSessions();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"schemaVersion": 1'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"command": "ls"'));
  });

  it('vpd session stop calls stop endpoint', async () => {
    process.argv = ['node', 'vpd', 'session', 'stop', 'sess-1'];
    mocks.daemonFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const { stopSession } = await import('../../src/cli/session-commands.js');
    await stopSession();

    expect(mocks.daemonFetch).toHaveBeenCalledWith('/api/sessions/sess-1/stop', { method: 'POST' });
  });

  it('vpd permit ls returns structured JSON', async () => {
    process.argv = ['node', 'vpd', 'permit', 'ls', '--json'];
    mocks.daemonFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          pending: [
            {
              sessionId: 'sess-1',
              requestId: 'req-1',
              toolName: 'Bash',
              description: 'Bash wants to execute',
              createdAt: Date.now(),
            },
          ],
          count: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { permit } = await import('../../src/cli/permission-commands.js');
    await permit();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"schemaVersion": 1'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"command": "permit ls"'));
  });

  it('vpd permit allow supports --always', async () => {
    process.argv = ['node', 'vpd', 'permit', 'allow', 'sess-1', 'req-1', '--always', '--json'];
    mocks.daemonFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const { permit } = await import('../../src/cli/permission-commands.js');
    await permit();

    expect(mocks.daemonFetch).toHaveBeenCalledWith(
      '/api/permissions/respond',
      expect.objectContaining({ method: 'POST' }),
    );
    const call = mocks.daemonFetch.mock.calls[0]?.[1] as { body?: string };
    expect(call.body).toContain('"allowAlways":true');
  });

  it('vpd agent mode updates active session mode', async () => {
    process.argv = ['node', 'vpd', 'agent', 'mode', 'sess-1', 'bypass'];
    mocks.daemonFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const { agent } = await import('../../src/cli/agent-commands.js');
    await agent();

    expect(mocks.daemonFetch).toHaveBeenCalledWith(
      '/api/sessions/sess-1/mode',
      expect.objectContaining({ method: 'PUT' }),
    );
  });
});
