import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('lifecycle pair server credential storage', () => {
  const originalArgv = process.argv.slice();
  const originalViewportHome = process.env['VIEWPORT_HOME'];
  const originalCwd = process.cwd();

  let homeDir = '';

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-pair-server-test-'));
    process.env['VIEWPORT_HOME'] = homeDir;
    process.argv = ['node', 'vpd'];
    process.chdir(homeDir);
  });

  afterEach(async () => {
    process.argv = originalArgv;
    process.chdir(originalCwd);
    if (originalViewportHome) process.env['VIEWPORT_HOME'] = originalViewportHome;
    else delete process.env['VIEWPORT_HOME'];
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('stores browser-paired bindings with per-server JWKS verification URL', async () => {
    const { storePairingCredentials } = await import('../../src/cli/lifecycle-pair-server.js');
    const { ConfigManager } = await import('../../src/core/config.js');

    await storePairingCredentials(
      {
        status: 'approved',
        workspace_id: 'workspace_demo',
        install_id: 'install_demo',
        runtime_target_id: 'runtime_demo',
        machine_id: 'machine_demo',
        relay_endpoint: 'wss://relay.getviewport.test:7781/ws',
        token: 'install-issue-token',
        server_url: 'https://api.getviewport.test',
      },
      'https://api.getviewport.test',
    );

    const manager = new ConfigManager();
    await manager.load();
    const relay = manager.getDaemonConfig()?.relay;
    expect(relay?.bindings).toHaveLength(1);
    expect(relay?.bindings?.[0]).toMatchObject({
      workspaceId: 'workspace_demo',
      serverUrl: 'https://api.getviewport.test',
      tokenJwksUrl: 'https://api.getviewport.test/api/.well-known/jwks.json',
    });
  });
});
