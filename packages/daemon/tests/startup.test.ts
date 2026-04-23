import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeAutoRegisterEntry,
  localDaemonBridgeTlsOptions,
  localDaemonWsUrl,
  missingRelayRuntimeConfig,
} from '../src/startup.js';
import type { RuntimeLaunchConfig } from '../src/cli/supervisor-protocol.js';

const ORIGINAL_ENV = { ...process.env };

function baseConfig(overrides: Partial<RuntimeLaunchConfig> = {}): RuntimeLaunchConfig {
  return {
    listen: '127.0.0.1:7070',
    host: '127.0.0.1',
    port: 7070,
    version: '0.3.0',
    profile: 'local',
    authEnabled: false,
    detached: false,
    relayEnabled: false,
    ...overrides,
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('startup auto-register decode', () => {
  it('preserves path hyphens encoded as double-dash', () => {
    expect(decodeAutoRegisterEntry('-Users-dev--user-my--project')).toBe(
      '/Users/dev-user/my-project',
    );
  });

  it('preserves absolute leading slash semantics for non-prefixed entries', () => {
    expect(decodeAutoRegisterEntry('Users-dev-work')).toBe('/Users/dev/work');
  });

  it('uses loopback ws transport when local TLS is disabled', () => {
    process.env['VIEWPORT_TLS'] = '0';
    expect(localDaemonWsUrl(baseConfig({ host: '0.0.0.0', port: 19990 }))).toBe(
      'ws://127.0.0.1:19990/ws',
    );
    expect(localDaemonBridgeTlsOptions()).toBeNull();
  });

  it('uses loopback wss transport and bridge-local tls options when local TLS is enabled', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-startup-tls-'));
    const certPath = path.join(tmpDir, 'local.crt');
    const keyPath = path.join(tmpDir, 'local.key');
    await fs.writeFile(certPath, 'cert');
    await fs.writeFile(keyPath, 'key');

    process.env['VIEWPORT_TLS'] = '1';
    process.env['VIEWPORT_TLS_HOST'] = 'localhost';
    process.env['VIEWPORT_TLS_CERT'] = certPath;
    process.env['VIEWPORT_TLS_KEY'] = keyPath;

    expect(localDaemonWsUrl(baseConfig({ port: 19990 }))).toBe('wss://127.0.0.1:19990/ws');
    expect(localDaemonBridgeTlsOptions()).toEqual({
      daemonTlsVerify: '0',
    });
  });

  it('accepts issue-token-only relay runtime config', () => {
    expect(
      missingRelayRuntimeConfig(
        baseConfig({
          relayEnabled: true,
          relayEndpoint: 'ws://127.0.0.1:20781/ws',
          relayServerUrl: 'http://127.0.0.1:24780',
          relayWorkspaceId: 'workspace_demo',
          relayIssueToken: 'install-issue-token',
        }),
      ),
    ).toEqual([]);
  });

  it('requires an issue token for relay runtime config', () => {
    expect(
      missingRelayRuntimeConfig(
        baseConfig({
          relayEnabled: true,
          relayEndpoint: 'ws://127.0.0.1:20781/ws',
          relayServerUrl: 'http://127.0.0.1:24780',
          relayWorkspaceId: 'workspace_demo',
        }),
      ),
    ).toContain('relay issue token');
  });
});
