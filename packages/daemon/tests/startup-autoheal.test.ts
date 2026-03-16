import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readDaemonRuntimeState: vi.fn(),
  isPidRunning: vi.fn(),
  clearDaemonRuntimeState: vi.fn(),
  readProcessInfo: vi.fn(),
  isOwnershipMatch: vi.fn(),
  stopPid: vi.fn(),
  resolveDaemonSettingsFromSources: vi.fn(),
  startSupervisorDetached: vi.fn(),
  runSupervisorForeground: vi.fn(),
  daemonFetch: vi.fn(),
  hasFlag: vi.fn(),
}));

vi.mock('../src/cli/daemon-lifecycle.js', () => ({
  readDaemonRuntimeState: mocks.readDaemonRuntimeState,
  isPidRunning: mocks.isPidRunning,
  clearDaemonRuntimeState: mocks.clearDaemonRuntimeState,
  readProcessInfo: mocks.readProcessInfo,
  isOwnershipMatch: mocks.isOwnershipMatch,
  stopPid: mocks.stopPid,
}));

vi.mock('../src/cli/daemon-settings.js', () => ({
  resolveDaemonSettingsFromSources: mocks.resolveDaemonSettingsFromSources,
}));

vi.mock('../src/cli/supervisor.js', () => ({
  startSupervisorDetached: mocks.startSupervisorDetached,
  runSupervisorForeground: mocks.runSupervisorForeground,
  runSupervisorFromEnv: vi.fn(),
  loadWorkerConfigFromEnv: vi.fn(),
}));

vi.mock('../src/cli/daemon-client.js', () => ({
  daemonFetch: mocks.daemonFetch,
}));

vi.mock('../src/cli/args.js', () => ({
  hasFlag: mocks.hasFlag,
}));

describe('startup auto-heal', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.hasFlag.mockReturnValue(false);
    mocks.resolveDaemonSettingsFromSources.mockResolvedValue({
      launch: {
        listen: '127.0.0.1:7070',
        host: '127.0.0.1',
        port: 7070,
        version: '0.3.0',
        profile: 'local',
        authEnabled: false,
        detached: true,
      },
      listenTarget: {
        type: 'tcp',
        host: '127.0.0.1',
        port: 7070,
        listen: '127.0.0.1:7070',
      },
    });
    mocks.startSupervisorDetached.mockResolvedValue({ pid: 9999, logPath: '/tmp/daemon.log' });
    mocks.clearDaemonRuntimeState.mockResolvedValue(undefined);
    mocks.runSupervisorForeground.mockResolvedValue(0);
  });

  it('auto-heals stale matching supervisor when daemon health is unreachable', async () => {
    mocks.readDaemonRuntimeState.mockResolvedValue({
      ownerPid: 82507,
      port: 7070,
      host: '127.0.0.1',
      listen: '127.0.0.1:7070',
      startedAt: Date.now(),
      version: '0.3.0',
      mode: 'supervisor',
    });
    mocks.isPidRunning.mockReturnValue(true);
    mocks.readProcessInfo.mockReturnValue({
      pid: 82507,
      uid: 501,
      startedAt: 'Mon Mar 2 13:19:36 2026',
      command: '__supervisor',
    });
    mocks.isOwnershipMatch.mockReturnValue(true);
    mocks.daemonFetch.mockResolvedValue(null);
    mocks.stopPid.mockResolvedValue('force-stopped');

    const { start } = await import('../src/startup.js');
    await start({ silent: true });

    expect(mocks.stopPid).toHaveBeenCalledWith(82507, {
      timeoutMs: 1500,
      force: true,
      useProcessGroup: true,
    });
    expect(mocks.startSupervisorDetached).toHaveBeenCalledTimes(1);
  });

  it('does not auto-heal when existing matching daemon is healthy', async () => {
    mocks.readDaemonRuntimeState.mockResolvedValue({
      ownerPid: 82507,
      port: 7070,
      host: '127.0.0.1',
      listen: '127.0.0.1:7070',
      startedAt: Date.now(),
      version: '0.3.0',
      mode: 'supervisor',
    });
    mocks.isPidRunning.mockReturnValue(true);
    mocks.readProcessInfo.mockReturnValue({
      pid: 82507,
      uid: 501,
      startedAt: 'Mon Mar 2 13:19:36 2026',
      command: '__supervisor',
    });
    mocks.isOwnershipMatch.mockReturnValue(true);
    mocks.daemonFetch.mockResolvedValue({ ok: true });

    const { start } = await import('../src/startup.js');
    await expect(start({ silent: true })).rejects.toThrow('Daemon already running');
    expect(mocks.stopPid).not.toHaveBeenCalled();
  });
});
