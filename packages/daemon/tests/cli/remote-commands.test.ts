import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('remote CLI commands', () => {
  const originalArgv = process.argv.slice();
  const originalViewportHome = process.env['VIEWPORT_HOME'];
  const originalFetch = global.fetch;
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  let homeDir = '';

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-remote-cli-test-'));
    process.env['VIEWPORT_HOME'] = homeDir;
  });

  afterEach(async () => {
    process.argv = originalArgv;
    if (originalViewportHome) process.env['VIEWPORT_HOME'] = originalViewportHome;
    else delete process.env['VIEWPORT_HOME'];
    global.fetch = originalFetch;
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('infers relay endpoint scheme from server URL', async () => {
    const { inferRelayEndpointFromServer } = await import('../../src/cli/remote-commands.js');

    expect(inferRelayEndpointFromServer('https://getviewport.test')).toBe(
      'wss://getviewport.test:7781/ws',
    );
    expect(inferRelayEndpointFromServer('http://127.0.0.1:7780')).toBe('ws://127.0.0.1:7781/ws');
  });

  it('login auto-enrolls workspace and writes daemon relay config', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      // discoverRelayEndpoint
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          state: { wsBaseUrl: 'wss://relay.getviewport.test:7781/ws' },
        }),
      )
      // resetWorkspaceEnrollToken (workspace missing)
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'workspace not found' }, 404))
      // enrollWorkspace
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          workspaceId: 'workspace_demo',
          workspaceEnrollToken: 'workspace-token-enrolled',
        }),
      );
    global.fetch = fetchMock;

    process.argv = [
      'node',
      'vpd',
      'remote',
      'login',
      '--json',
      '--server',
      'https://getviewport.test',
      '--workspace',
      'workspace_demo',
      '--user',
      'user_demo',
      '--enable',
    ];

    const { remote } = await import('../../src/cli/remote-commands.js');
    const { ConfigManager } = await import('../../src/core/config.js');

    await remote();

    const output = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const payload = JSON.parse(output) as {
      ok: boolean;
      tokenSource: string;
      relay: { endpoint: string; enrollToken: string; enabled: boolean };
    };
    expect(payload.ok).toBe(true);
    expect(payload.tokenSource).toBe('enroll');
    expect(payload.relay.endpoint).toBe('wss://relay.getviewport.test:7781/ws');
    expect(payload.relay.enrollToken).toContain('...');

    const manager = new ConfigManager();
    await manager.load();
    const daemonConfig = manager.getDaemonConfig();
    expect(daemonConfig?.relay?.enabled).toBe(true);
    expect(daemonConfig?.relay?.serverUrl).toBe('https://getviewport.test');
    expect(daemonConfig?.relay?.workspaceId).toBe('workspace_demo');
    expect(daemonConfig?.relay?.enrollToken).toBe('workspace-token-enrolled');
  });

  it('login uses reset token flow when workspace already exists', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      // discoverRelayEndpoint fails -> fallback infer
      .mockResolvedValueOnce(jsonResponse({ ok: false }, 500))
      // resetWorkspaceEnrollToken success
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          workspaceId: 'workspace_demo',
          workspaceEnrollToken: 'workspace-token-rotated',
        }),
      );
    global.fetch = fetchMock;

    process.argv = [
      'node',
      'vpd',
      'remote',
      'login',
      '--json',
      '--server',
      'https://getviewport.test',
      '--workspace',
      'workspace_demo',
    ];

    const { remote } = await import('../../src/cli/remote-commands.js');
    const { ConfigManager } = await import('../../src/core/config.js');

    await remote();

    const output = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const payload = JSON.parse(output) as {
      tokenSource: string;
      relay: { endpoint: string; enabled: boolean };
    };
    expect(payload.tokenSource).toBe('reset');
    expect(payload.relay.endpoint).toBe('wss://getviewport.test:7781/ws');

    const manager = new ConfigManager();
    await manager.load();
    expect(manager.getDaemonConfig()?.relay?.enrollToken).toBe('workspace-token-rotated');
    expect(manager.getDaemonConfig()?.relay?.enabled).toBe(true);
  });

  it('status redacts enroll token in JSON output', async () => {
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    await manager.setDaemonConfig({
      relay: {
        enabled: true,
        endpoint: 'wss://relay.test/ws',
        serverUrl: 'https://getviewport.test',
        workspaceId: 'workspace_demo',
        enrollToken: 'super-secret-enroll-token',
        tlsVerify: 'auto',
      },
    });

    process.argv = ['node', 'vpd', 'remote', 'status', '--json'];

    const { remote } = await import('../../src/cli/remote-commands.js');
    await remote();

    const output = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const payload = JSON.parse(output) as { relay: { enrollToken: string } };
    expect(payload.relay.enrollToken).toBe('supe...oken');
  });

  it('throws actionable error when workspace missing and no user/token provided', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: false }, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'workspace not found' }, 404));
    global.fetch = fetchMock;

    process.argv = [
      'node',
      'vpd',
      'remote',
      'login',
      '--server',
      'https://getviewport.test',
      '--workspace',
      'workspace_missing',
    ];

    const { remote } = await import('../../src/cli/remote-commands.js');

    await expect(remote()).rejects.toThrow('Workspace not found and no --user provided');
  });
});
