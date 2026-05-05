import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasFlag: vi.fn(),
  isJsonMode: vi.fn(),
  printJson: vi.fn(),
  readDaemonHealth: vi.fn(),
  readDaemonRuntimeState: vi.fn(),
  isPidRunning: vi.fn(),
  resolveDaemonEndpoint: vi.fn(),
  loadConfig: vi.fn(),
  getDaemonConfig: vi.fn(),
  getMachineId: vi.fn(),
  getConfigPaths: vi.fn(),
}));

vi.mock('../../src/cli/args.js', () => ({
  hasFlag: mocks.hasFlag,
}));

vi.mock('../../src/cli/command-shared.js', () => ({
  isJsonMode: mocks.isJsonMode,
  printJson: mocks.printJson,
  readDaemonHealth: mocks.readDaemonHealth,
  shortError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock('../../src/cli/daemon-lifecycle.js', () => ({
  isPidRunning: mocks.isPidRunning,
  readDaemonRuntimeState: mocks.readDaemonRuntimeState,
}));

vi.mock('../../src/cli/daemon-client.js', () => ({
  resolveDaemonEndpoint: mocks.resolveDaemonEndpoint,
}));

vi.mock('../../src/cli/runtime-toolchain.js', () => ({
  compareSemver: vi.fn(),
  fetchLatestVersion: vi.fn(),
  formatNpmInvocation: () => '/usr/local/bin/npm',
  resolveNpmInvocationFromNode: () => ({ binary: '/usr/local/bin/npm', args: [] }),
  resolvePreferredNodePath: () => ({ nodePath: '/usr/local/bin/node', source: 'test' }),
}));

vi.mock('../../src/core/config.js', () => ({
  configDir: () => '/tmp/.viewport',
  ConfigManager: class {
    load = mocks.loadConfig;
    getDaemonConfig = mocks.getDaemonConfig;
    getMachineId = mocks.getMachineId;
    getConfigPaths = mocks.getConfigPaths;
  },
}));

vi.mock('../../src/core/runtime-identity.js', () => ({
  formatDaemonHomeLabel: () => '/tmp/.viewport',
  formatRuntimeKindLabel: () => 'Local dev',
  resolveDaemonRuntimeIdentity: () => ({
    machineId: 'machine_test',
    daemonVersion: '0.2.0-dev',
    runtimeKind: 'local-dev',
    daemonHome: '/tmp/.viewport',
    daemonHomeScope: 'project-override',
    daemonHomeSource: 'project',
    hostedDefaults: false,
    profile: 'local',
    serverUrl: 'https://getviewport.test',
    relayEndpoint: 'wss://getviewport.test:7781/ws',
    relayServerUrl: 'https://getviewport.test',
    relayWorkspaceId: 'workspace_test',
    projectConfigSource: 'nearest',
  }),
}));

vi.mock('../../src/core/package-meta.js', () => ({
  resolveCliEntrypointPath: () => '/repo/packages/daemon/dist/index.js',
  resolveDisplayVersion: () => '0.2.0-dev',
  resolvePackageName: () => '@viewportai/daemon',
  resolvePackageRoot: () => '/repo/packages/daemon',
  resolvePackageSourceInfo: () => ({ kind: 'linked-local-build', gitRef: 'abc1234' }),
}));

function captureConsole() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
    lines.push(String(message ?? ''));
  });

  return {
    lines,
    restore: () => spy.mockRestore(),
  };
}

function relayHealth(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok',
    version: '0.2.0-dev',
    uptime: 1,
    pid: 222,
    listen: '127.0.0.1:7070',
    sessions: 0,
    directories: 0,
    agents: 'claude, codex',
    machine: {
      daemonVersion: '0.2.0-dev',
      runtimeKind: 'local-dev',
      daemonHome: '/tmp/.viewport',
      daemonHomeScope: 'project-override',
      profile: 'local',
      serverUrl: 'https://getviewport.test',
      relayEndpoint: 'wss://getviewport.test:7781/ws',
      relayServerUrl: 'https://getviewport.test',
    },
    relay: {
      state: 'circuit_open',
      reconnectAttempt: 5,
      lastErrorCode: 'CIRCUIT_OPEN',
      lastErrorMessage: 'opened after repeated failures',
      ...overrides,
    },
  };
}

describe('lifecycle relay diagnostic output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasFlag.mockReturnValue(false);
    mocks.isJsonMode.mockReturnValue(false);
    mocks.loadConfig.mockResolvedValue(undefined);
    mocks.getDaemonConfig.mockReturnValue({});
    mocks.getMachineId.mockReturnValue('machine_test');
    mocks.getConfigPaths.mockReturnValue({
      globalPath: '/tmp/.viewport/config.json',
      projectOverridePath: '/repo/.viewport/config.json',
    });
    mocks.resolveDaemonEndpoint.mockResolvedValue({
      type: 'http',
      baseUrl: 'http://127.0.0.1:7070',
      host: '127.0.0.1',
      port: 7070,
    });
    mocks.readDaemonRuntimeState.mockResolvedValue({
      ownerPid: 111,
      workerPid: 222,
      ownerUid: 501,
      ownerHostname: 'Mac.lan',
      startedAt: Date.now(),
      listen: '127.0.0.1:7070',
      profile: 'local',
      runtimeKind: 'local-dev',
      daemonHome: '/tmp/.viewport',
      daemonHomeScope: 'project-override',
      serverUrl: 'https://getviewport.test',
      relayEndpoint: 'wss://getviewport.test:7781/ws',
      relayServerUrl: 'https://getviewport.test',
    });
    mocks.isPidRunning.mockReturnValue(true);
    mocks.readDaemonHealth.mockResolvedValue(relayHealth());
  });

  it('prints a relay recovery hint in status output', async () => {
    const output = captureConsole();
    const { status } = await import('../../src/cli/lifecycle-status-command.js');

    await status();

    expect(output.lines).toContain(
      'Relay hint:  Relay reconnects are paused after repeated failures. Check relay/server health, then run `vpd restart`.',
    );
    output.restore();
  });

  it('prints a relay recovery hint in doctor output', async () => {
    const output = captureConsole();
    const { doctor } = await import('../../src/cli/lifecycle-doctor-command.js');

    await doctor();

    expect(output.lines).toContain(
      'Relay hint:   Relay reconnects are paused after repeated failures. Check relay/server health, then run `vpd restart`.',
    );
    output.restore();
  });

  it('includes the relay recovery hint in status JSON output', async () => {
    mocks.isJsonMode.mockReturnValue(true);
    const { status } = await import('../../src/cli/lifecycle-status-command.js');

    await status();

    expect(mocks.printJson).toHaveBeenCalledWith(
      expect.objectContaining({
        relayRecoveryHint:
          'Relay reconnects are paused after repeated failures. Check relay/server health, then run `vpd restart`.',
      }),
    );
  });
});
