import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  daemonFetch: vi.fn(),
  resolveDaemonEndpoint: vi.fn(),
}));

vi.mock('../../src/cli/daemon-client.js', () => ({
  daemonFetch: mocks.daemonFetch,
  resolveDaemonEndpoint: mocks.resolveDaemonEndpoint,
  daemonEndpointLabel: (endpoint: { baseUrl?: string; socketPath?: string; type: string }) =>
    endpoint.type === 'socket' ? `unix://${endpoint.socketPath}` : endpoint.baseUrl,
}));

describe('hook notify command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDaemonEndpoint.mockResolvedValue({
      type: 'tcp',
      host: '127.0.0.1',
      port: 19990,
      baseUrl: 'http://127.0.0.1:19990',
      wsUrl: 'ws://127.0.0.1:19990/ws',
    });
  });

  it('prints an actionable diagnostic when the daemon is unreachable', async () => {
    mocks.daemonFetch.mockResolvedValue(null);
    const stderr: string[] = [];
    const { runHookNotify } = await import('../../src/cli/hook-command.js');

    const code = await runHookNotify('{"tool_name":"Bash"}', {
      event: 'PermissionRequest',
      writeStdout: () => undefined,
      writeStderr: (message) => stderr.push(message),
    });

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('Viewport daemon not reachable at http://127.0.0.1:19990');
    expect(stderr.join('')).toContain('vpd status');
  });
});
