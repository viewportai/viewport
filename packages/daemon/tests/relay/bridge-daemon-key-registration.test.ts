import { describe, expect, it } from 'vitest';

import { registerDaemonPublicKeyWithControlPlane } from '../../src/relay/bridge-daemon-key-registration.js';

describe('registerDaemonPublicKeyWithControlPlane', () => {
  it('requests JSON so Laravel API routes do not return HTML redirects', async () => {
    let headers: Record<string, string> | undefined;

    await expect(
      registerDaemonPublicKeyWithControlPlane({
        options: {
          relayServerUrl: 'https://api.getviewport.test',
          workspaceId: 'workspace_123',
          runtimeTargetId: 'runtime_123',
        },
        identity: {
          deviceId: 'device-id',
          createdAt: 1,
          algorithm: 'p256',
          publicKey: 'public-key',
          privateKey: 'private-key',
        },
        daemonIssueToken: 'issue-token',
        fetchImpl: async (_url, init) => {
          headers = init.headers as Record<string, string>;
          return new Response(JSON.stringify({ ok: false, reason: 'expected failure' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        },
      }),
    ).rejects.toThrow('expected failure');

    expect(headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/json',
    });
  });
});
