import { describe, expect, it } from 'vitest';
import {
  resolveDaemonRuntimeIdentity,
  toInstallCapabilities,
} from '../../src/core/runtime-identity.js';

describe('runtime identity', () => {
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
      env: {},
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
        VIEWPORT_SERVER_URL: 'https://getviewport.test',
        VIEWPORT_RELAY_ENDPOINT: 'wss://getviewport.test:7781/ws',
      },
    });

    expect(identity.runtimeKind).toBe('local-dev');
    expect(identity.daemonHomeScope).toBe('isolated');
    expect(identity.hostedDefaults).toBe(false);
  });

  it('treats non-hosted remote targets as self-hosted and derives install capabilities', () => {
    const identity = resolveDaemonRuntimeIdentity({
      daemonVersion: '1.2.3',
      env: {
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
