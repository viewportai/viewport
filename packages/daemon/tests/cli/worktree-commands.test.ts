import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  daemonFetch: vi.fn(),
  isDaemonRunning: vi.fn(),
}));

vi.mock('../../src/cli/daemon-client.js', () => ({
  daemonFetch: mocks.daemonFetch,
  isDaemonRunning: mocks.isDaemonRunning,
}));

describe('worktree CLI commands', () => {
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

  it('lists worktrees in table format', async () => {
    process.argv = ['node', 'vpd', 'worktree', 'ls', '--format', 'table'];
    mocks.daemonFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          worktrees: [
            {
              sessionId: 'sess-1',
              directoryId: 'dir-1',
              agent: 'claude',
              state: 'running',
              mode: 'detect',
              worktreePath: '/tmp/project/.viewport/worktrees/sess-1',
              stepCount: 2,
              lastStepSha: 'abc123',
              lastStepAt: 1_700_000_000_000,
            },
          ],
          count: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { worktree } = await import('../../src/cli/worktree-commands.js');
    await worktree();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Session'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('sess-1'));
  });

  it('renders diffs as structured json', async () => {
    process.argv = ['node', 'vpd', 'worktree', 'diffs', 'sess-1', '--json'];
    mocks.daemonFetch.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            step: 1,
            sha: 'abc123',
            diff: 'diff --git a/a.ts b/a.ts\n+hello\n',
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { worktree } = await import('../../src/cli/worktree-commands.js');
    await worktree();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"command": "worktree diffs"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"sessionId": "sess-1"'));
  });

  it('calls rollback endpoint', async () => {
    process.argv = ['node', 'vpd', 'worktree', 'rollback', 'sess-1', 'abc123'];
    mocks.daemonFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const { worktree } = await import('../../src/cli/worktree-commands.js');
    await worktree();

    expect(mocks.daemonFetch).toHaveBeenCalledWith('/api/worktrees/sess-1/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toSha: 'abc123' }),
    });
  });
});
