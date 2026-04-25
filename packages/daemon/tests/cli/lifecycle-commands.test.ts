import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearDaemonRuntimeState: vi.fn(),
  readDaemonRuntimeState: vi.fn(),
  stopPid: vi.fn(),
  waitForPidExit: vi.fn(),
  readProcessInfo: vi.fn(),
  isOwnershipMatch: vi.fn(),
  isPidRunning: vi.fn(),
  requestLifecycle: vi.fn(),
  readDaemonHealth: vi.fn(),
  waitForDaemonReady: vi.fn(),
  resolveDaemonSettingsFromSources: vi.fn(),
  startWithLaunchConfig: vi.fn(),
  getArgs: vi.fn(),
  getFlag: vi.fn(),
  hasFlag: vi.fn(),
}));

vi.mock('../../src/cli/daemon-lifecycle.js', () => ({
  clearDaemonRuntimeState: mocks.clearDaemonRuntimeState,
  readDaemonRuntimeState: mocks.readDaemonRuntimeState,
  stopPid: mocks.stopPid,
  DEFAULT_STOP_TIMEOUT_MS: 15_000,
  waitForPidExit: mocks.waitForPidExit,
  readProcessInfo: mocks.readProcessInfo,
  isOwnershipMatch: mocks.isOwnershipMatch,
  isPidRunning: mocks.isPidRunning,
}));

vi.mock('../../src/cli/command-shared.js', async () => {
  const actual = await vi.importActual('../../src/cli/command-shared.js');
  return {
    ...actual,
    requestLifecycle: mocks.requestLifecycle,
    readDaemonHealth: mocks.readDaemonHealth,
    waitForDaemonReady: mocks.waitForDaemonReady,
  };
});

vi.mock('../../src/cli/daemon-settings.js', () => ({
  resolveDaemonSettingsFromSources: mocks.resolveDaemonSettingsFromSources,
}));

vi.mock('../../src/startup.js', () => ({
  startWithLaunchConfig: mocks.startWithLaunchConfig,
}));

vi.mock('../../src/cli/args.js', () => ({
  getArgs: mocks.getArgs,
  getFlag: mocks.getFlag,
  hasFlag: mocks.hasFlag,
}));

describe('lifecycle restart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getArgs.mockReturnValue([]);
    mocks.getFlag.mockReturnValue(undefined);
    mocks.hasFlag.mockReturnValue(false);
    mocks.readDaemonHealth.mockReset();
    mocks.waitForDaemonReady.mockResolvedValue({
      status: 'ok',
      version: '0.3.0',
      uptime: 1,
      sessions: 0,
      directories: 0,
      agents: 'none',
    });
  });

  it('restarts the running daemon with the active runtime endpoint and updated relay config', async () => {
    const runtimeState = {
      ownerPid: 1234,
      workerPid: 2234,
      port: 19990,
      host: '127.0.0.1',
      listen: '127.0.0.1:19990',
      startedAt: 1,
      version: '0.3.0',
      mode: 'supervisor',
      profile: 'local' as const,
      authEnabled: false,
      relayEnabled: true,
      relayEndpoint: 'wss://relay.getviewport.com/ws',
      relayServerUrl: 'https://getviewport.com',
      relayWorkspaceId: 'workspace_demo',
      tlsEnabled: true,
      tlsHost: 'app.getviewport.test',
    };
    mocks.readDaemonRuntimeState.mockResolvedValue(runtimeState);
    mocks.isPidRunning.mockReturnValue(true);
    mocks.readProcessInfo.mockReturnValue({
      pid: 1234,
      uid: 501,
      startedAt: 'Tue Apr 21 2026 20:00:00 GMT-0400',
      command: '__supervisor',
    });
    mocks.isOwnershipMatch.mockReturnValue(true);
    mocks.stopPid.mockResolvedValue('stopped');
    mocks.clearDaemonRuntimeState.mockResolvedValue(undefined);
    mocks.resolveDaemonSettingsFromSources.mockResolvedValue({
      launch: {
        listen: '127.0.0.1:7070',
        host: '127.0.0.1',
        port: 7070,
        version: '0.3.0',
        profile: 'local',
        authEnabled: false,
        detached: true,
        relayEnabled: true,
        relayEndpoint: 'wss://relay.getviewport.com/ws',
        relayServerUrl: 'https://getviewport.com',
        relayWorkspaceId: 'workspace_demo',
        relayTlsVerify: 'auto',
      },
    });

    const { restart } = await import('../../src/cli/lifecycle-commands.js');
    await restart();

    expect(mocks.stopPid).toHaveBeenCalledWith(
      1234,
      expect.objectContaining({ force: true, useProcessGroup: true }),
    );
    expect(mocks.startWithLaunchConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        listen: '127.0.0.1:19990',
        host: '127.0.0.1',
        port: 19990,
        relayEnabled: true,
        relayWorkspaceId: 'workspace_demo',
      }),
      { silent: true },
    );
    expect(process.env['VIEWPORT_TLS']).toBeUndefined();
    expect(process.env['VIEWPORT_TLS_HOST']).toBeUndefined();
  });

  it('preserves the active runtime endpoint when falling back to stop/start', async () => {
    const runtimeState = {
      ownerPid: 1234,
      port: 19990,
      host: '127.0.0.1',
      listen: '127.0.0.1:19990',
      startedAt: Date.now(),
      version: '0.3.0',
      mode: 'supervisor' as const,
      profile: 'local' as const,
      authEnabled: false,
      relayEnabled: true,
      relayEndpoint: 'ws://127.0.0.1:20781/ws',
      relayServerUrl: 'http://127.0.0.1:24780',
      relayWorkspaceId: 'workspace_demo',
      relayTlsVerify: '0' as const,
    };

    mocks.readDaemonRuntimeState.mockResolvedValue(runtimeState);
    mocks.isPidRunning.mockReturnValue(true);
    mocks.readProcessInfo.mockReturnValue({
      pid: 1234,
      uid: 501,
      startedAt: 'Tue Apr 21 2026 20:00:00 GMT-0400',
      command: '__supervisor',
    });
    mocks.isOwnershipMatch.mockReturnValue(true);
    mocks.stopPid.mockResolvedValue('stopped');
    mocks.clearDaemonRuntimeState.mockResolvedValue(undefined);
    mocks.resolveDaemonSettingsFromSources.mockResolvedValue({
      launch: {
        listen: '127.0.0.1:7070',
        host: '127.0.0.1',
        port: 7070,
        version: '0.3.0',
        profile: 'local',
        authEnabled: false,
        detached: true,
        relayEnabled: true,
        relayEndpoint: 'ws://127.0.0.1:20781/ws',
        relayServerUrl: 'http://127.0.0.1:24780',
        relayWorkspaceId: 'workspace_demo',
        relayTlsVerify: '0',
      },
    });

    const { restart } = await import('../../src/cli/lifecycle-commands.js');
    await restart();

    expect(mocks.startWithLaunchConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        listen: '127.0.0.1:19990',
        host: '127.0.0.1',
        port: 19990,
        relayEnabled: true,
        relayWorkspaceId: 'workspace_demo',
      }),
      { silent: true },
    );
  });
});

describe('pairing machine name', () => {
  const originalName = process.env['VIEWPORT_MACHINE_NAME'];

  beforeEach(() => {
    delete process.env['VIEWPORT_MACHINE_NAME'];
  });

  afterEach(() => {
    if (originalName === undefined) {
      delete process.env['VIEWPORT_MACHINE_NAME'];
    } else {
      process.env['VIEWPORT_MACHINE_NAME'] = originalName;
    }
  });

  it('uses an explicit machine name when provided', async () => {
    process.env['VIEWPORT_MACHINE_NAME'] = "  Mehr's MacBook Pro  ";

    const { resolveDefaultPairingName } = await import('../../src/cli/lifecycle-commands.js');

    await expect(resolveDefaultPairingName()).resolves.toBe("Mehr's MacBook Pro");
  });
});
