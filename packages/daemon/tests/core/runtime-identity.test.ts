import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveDaemonRuntimeIdentity,
  toInstallCapabilities,
} from '../../src/core/runtime-identity.js';

describe('runtime identity', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-runtime-identity-test-'));
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('treats hosted defaults with global home as managed', () => {
    const identity = resolveDaemonRuntimeIdentity({
      daemonVersion: '1.2.3',
      daemonConfig: {
        profile: 'relay',
        relay: {
          serverUrl: 'https://getviewport.com',
          endpoint: 'wss://relay.getviewport.com/ws',
          workspaceId: 'workspace_demo',
        },
        server: {
          url: 'https://getviewport.com',
        },
      } as any,
      env: {
        VIEWPORT_RESOURCE_OVERRIDE_DIR: '/tmp/viewport-no-resource-override',
      },
      machineId: 'machine-1',
    });

    expect(identity.runtimeKind).toBe('managed');
    expect(identity.daemonHomeScope).toBe('global');
    expect(identity.hostedDefaults).toBe(true);
  });

  it('treats explicit daemon home and local targets as local-dev', () => {
    const identity = resolveDaemonRuntimeIdentity({
      daemonVersion: '1.2.3',
      env: {
        VIEWPORT_HOME: '/tmp/viewport-dev',
        VIEWPORT_RESOURCE_OVERRIDE_DIR: '/tmp/viewport-no-resource-override',
        VIEWPORT_SERVER_URL: 'https://getviewport.test',
        VIEWPORT_RELAY_ENDPOINT: 'wss://getviewport.test:7781/ws',
      },
    });

    expect(identity.runtimeKind).toBe('local-dev');
    expect(identity.daemonHomeScope).toBe('global');
    expect(identity.hostedDefaults).toBe(false);
  });

  it('treats non-hosted remote targets as self-hosted and derives install capabilities', () => {
    const identity = resolveDaemonRuntimeIdentity({
      daemonVersion: '1.2.3',
      env: {
        VIEWPORT_RESOURCE_OVERRIDE_DIR: '/tmp/viewport-no-resource-override',
        VIEWPORT_SERVER_URL: 'https://viewport.internal.example.com',
        VIEWPORT_RELAY_ENDPOINT: 'wss://relay.internal.example.com/ws',
      },
    });

    expect(identity.runtimeKind).toBe('self-hosted');

    expect(toInstallCapabilities(identity)).toEqual({
      runtime: {
        daemonVersion: '1.2.3',
        runtimeKind: 'self-hosted',
        daemonHomeScope: 'global',
        profile: undefined,
        serverUrl: 'https://viewport.internal.example.com',
        relayEndpoint: 'wss://relay.internal.example.com/ws',
        relayServerUrl: undefined,
      },
    });
  });
});
