import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('remote CLI commands', () => {
  const originalArgv = process.argv.slice();
  const originalViewportHome = process.env['VIEWPORT_HOME'];
  const originalFetch = global.fetch;
  const originalCwd = process.cwd();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  let homeDir = '';

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/.well-known/context-candidate-decision-keys.json')) {
        return new Response(
          JSON.stringify({
            schema_version: 'viewport.context_candidate_decision_keys/v1',
            keys: [
              {
                kid: 'local-v1',
                algorithm: 'Ed25519',
                public_key: 'test-public-key',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-remote-cli-test-'));
    process.env['VIEWPORT_HOME'] = homeDir;
    process.chdir(homeDir);
  });

  afterEach(async () => {
    process.argv = originalArgv;
    process.chdir(originalCwd);
    if (originalViewportHome) process.env['VIEWPORT_HOME'] = originalViewportHome;
    else delete process.env['VIEWPORT_HOME'];
    global.fetch = originalFetch;
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('infers relay endpoint scheme from server URL', async () => {
    const { inferRelayEndpointFromServer } = await import('../../src/cli/remote-commands.js');

    expect(inferRelayEndpointFromServer('https://getviewport.com')).toBe(
      'wss://relay.getviewport.com/ws',
    );
    expect(inferRelayEndpointFromServer('https://app.getviewport.com')).toBe(
      'wss://relay.getviewport.com/ws',
    );
    expect(inferRelayEndpointFromServer('https://api.getviewport.com')).toBe(
      'wss://relay.getviewport.com/ws',
    );
    expect(inferRelayEndpointFromServer('https://getviewport.test')).toBe(
      'wss://getviewport.test:7781/ws',
    );
    expect(inferRelayEndpointFromServer('https://app.getviewport.test')).toBe(
      'wss://relay.getviewport.test:7781/ws',
    );
    expect(inferRelayEndpointFromServer('https://api.getviewport.test')).toBe(
      'wss://relay.getviewport.test:7781/ws',
    );
    expect(inferRelayEndpointFromServer('http://127.0.0.1:7780')).toBe('ws://127.0.0.1:7781/ws');
  });

  it('login writes daemon relay config from an explicit issue token', async () => {
    process.argv = [
      'node',
      'vpd',
      'remote',
      'login',
      '--json',
      '--server',
      'https://getviewport.com',
      '--workspace',
      'workspace_demo',
      '--token',
      'install-issue-token',
      '--enable',
    ];

    const { remote } = await import('../../src/cli/remote-commands.js');
    const { ConfigManager } = await import('../../src/core/config.js');

    await remote();

    const output = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const payload = JSON.parse(output) as {
      ok: boolean;
      relay: { endpoint: string; issueToken: string; enabled: boolean; machineId: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.relay.endpoint).toBe('wss://relay.getviewport.com/ws');
    expect(payload.relay.issueToken).toContain('...');
    expect(payload.relay.machineId).toMatch(/^machine_/);

    const manager = new ConfigManager();
    await manager.load();
    const daemonConfig = manager.getDaemonConfig();
    expect(daemonConfig?.relay?.enabled).toBe(true);
    expect(daemonConfig?.relay?.serverUrl).toBe('https://getviewport.com');
    expect(daemonConfig?.relay?.workspaceId).toBe('workspace_demo');
    expect(daemonConfig?.relay?.issueToken).toBe('install-issue-token');
    expect(daemonConfig?.relay?.machineId).toMatch(/^machine_/);
    expect(daemonConfig?.relay?.bindings?.[0]?.workspaceId).toBe('workspace_demo');
    expect(daemonConfig?.relay?.bindings?.[0]?.machineId).toBe(daemonConfig?.relay?.machineId);
    expect(daemonConfig?.relay?.bindings?.[0]?.tokenJwksUrl).toBe(
      'https://getviewport.com/api/.well-known/jwks.json',
    );
    expect(daemonConfig?.server?.contextCandidateDecisionKeys).toEqual({
      'local-v1': 'test-public-key',
    });
  });

  it('keeps explicitly provided context decision signing keys without discovery', async () => {
    process.argv = [
      'node',
      'vpd',
      'remote',
      'login',
      '--json',
      '--server',
      'https://getviewport.com',
      '--workspace',
      'workspace_demo',
      '--token',
      'install-issue-token',
      '--context-decision-key',
      'manual-v1:manual-public-key',
    ];

    const { remote } = await import('../../src/cli/remote-commands.js');
    const { ConfigManager } = await import('../../src/core/config.js');

    await remote();

    const manager = new ConfigManager();
    await manager.load();
    expect(manager.getDaemonConfig()?.server?.contextCandidateDecisionKeys).toEqual({
      'manual-v1': 'manual-public-key',
    });
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/.well-known/context-candidate-decision-keys.json'),
      expect.anything(),
    );
  });

  it('login clears stale issued-install credentials when switching workspaces', async () => {
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    await manager.setDaemonConfig({
      relay: {
        enabled: true,
        endpoint: 'wss://relay.getviewport.com/ws',
        serverUrl: 'https://getviewport.com',
        workspaceId: 'workspace_old',
        installId: 'install_old',
        issueToken: 'install-issue-old',
        tlsVerify: 'auto',
      },
    });

    process.argv = [
      'node',
      'vpd',
      'remote',
      'login',
      '--json',
      '--server',
      'https://getviewport.com',
      '--workspace',
      'workspace_new',
      '--token',
      'install-issue-new',
      '--replace',
    ];

    const { remote } = await import('../../src/cli/remote-commands.js');
    await remote();

    const refreshed = new ConfigManager();
    await refreshed.load();
    const relay = refreshed.getDaemonConfig()?.relay;
    expect(relay?.workspaceId).toBe('workspace_new');
    expect(relay?.installId).toBeUndefined();
    expect(relay?.issueToken).toBe('install-issue-new');
    expect(relay?.machineId).toMatch(/^machine_/);
    expect(relay?.bindings).toHaveLength(1);
    expect(relay?.bindings?.[0]?.workspaceId).toBe('workspace_new');
    expect(relay?.bindings?.[0]?.machineId).toBe(relay?.machineId);
  });

  it('requires --replace before switching workspaces', async () => {
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    await manager.setDaemonConfig({
      relay: {
        enabled: true,
        endpoint: 'wss://relay.getviewport.com/ws',
        serverUrl: 'https://getviewport.com',
        workspaceId: 'workspace_old',
        issueToken: 'install-issue-old',
        tlsVerify: 'auto',
      },
    });

    process.argv = [
      'node',
      'vpd',
      'remote',
      'login',
      '--json',
      '--server',
      'https://getviewport.com',
      '--workspace',
      'workspace_new',
      '--token',
      'install-issue-new',
    ];

    const { remote } = await import('../../src/cli/remote-commands.js');
    await expect(remote()).rejects.toThrow('Use --add to keep both organizations paired');
  });

  it('adds a second relay binding without replacing the existing workspace', async () => {
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    await manager.setDaemonConfig({
      relay: {
        enabled: true,
        endpoint: 'wss://relay.acme.test/ws',
        serverUrl: 'https://app.acme.test',
        workspaceId: 'workspace_acme',
        issueToken: 'install-issue-acme',
        tlsVerify: 'auto',
      },
    });

    process.argv = [
      'node',
      'vpd',
      'remote',
      'login',
      '--json',
      '--add',
      '--server',
      'https://app.personal.test',
      '--relay-endpoint',
      'wss://relay.personal.test/ws',
      '--workspace',
      'workspace_personal',
      '--token',
      'install-issue-personal',
      '--context-decision-key',
      'manual-v1:manual-public-key',
    ];

    const { remote } = await import('../../src/cli/remote-commands.js');
    await remote();

    const refreshed = new ConfigManager();
    await refreshed.load();
    const relay = refreshed.getDaemonConfig()?.relay;
    expect(relay?.workspaceId).toBe('workspace_acme');
    expect(relay?.bindings?.map((binding) => binding.workspaceId)).toEqual([
      'workspace_acme',
      'workspace_personal',
    ]);
    expect(relay?.bindings?.[0]?.issueToken).toBe('install-issue-acme');
    expect(relay?.bindings?.[1]?.issueToken).toBe('install-issue-personal');
    expect(relay?.bindings?.[0]?.machineId).toMatch(/^machine_/);
    expect(relay?.bindings?.[1]?.machineId).toMatch(/^machine_/);
    expect(relay?.bindings?.[0]?.machineId).not.toBe(relay?.bindings?.[1]?.machineId);
    expect(relay?.bindings?.[1]?.tokenJwksUrl).toBe(
      'https://app.personal.test/api/.well-known/jwks.json',
    );
  });

  it('status redacts issue token in JSON output', async () => {
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    await manager.setDaemonConfig({
      server: {
        contextCandidateDecisionKeys: {
          'local-v1': 'test-public-key',
        },
      },
      relay: {
        enabled: true,
        endpoint: 'wss://relay.test/ws',
        serverUrl: 'https://getviewport.com',
        workspaceId: 'workspace_demo',
        issueToken: 'super-secret-issue-token',
        tlsVerify: 'auto',
      },
    });

    process.argv = ['node', 'vpd', 'remote', 'status', '--json'];

    const { remote } = await import('../../src/cli/remote-commands.js');
    await remote();

    const output = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    const payload = JSON.parse(output) as {
      relay: { issueToken: string; contextCandidateDecisionKeyIds: string[] };
    };
    expect(payload.relay.issueToken).toBe('supe...oken');
    expect(payload.relay.contextCandidateDecisionKeyIds).toEqual(['local-v1']);
  });

  it('throws actionable error when issue token is missing', async () => {
    process.argv = [
      'node',
      'vpd',
      'remote',
      'login',
      '--server',
      'https://getviewport.com',
      '--workspace',
      'workspace_missing',
    ];

    const { remote } = await import('../../src/cli/remote-commands.js');

    await expect(remote()).rejects.toThrow('Missing relay issue token');
  });

  it('logout clears persisted relay credentials', async () => {
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    await manager.setDaemonConfig({
      relay: {
        enabled: true,
        endpoint: 'wss://relay.getviewport.com/ws',
        serverUrl: 'https://getviewport.com',
        workspaceId: 'workspace_demo',
        issueToken: 'install-issue-token',
        tlsVerify: 'auto',
      },
    });

    process.argv = ['node', 'vpd', 'remote', 'logout', '--json'];

    const { remote } = await import('../../src/cli/remote-commands.js');
    await remote();

    const refreshed = new ConfigManager();
    await refreshed.load();
    const relay = refreshed.getDaemonConfig()?.relay;
    expect(relay?.enabled).toBe(false);
    expect(relay?.issueToken).toBeUndefined();
    expect(relay?.bindings).toEqual([]);
  });
});
