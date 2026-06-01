import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSandboxProvider } from '../src/fake-provider.js';
import { createServer } from '../src/http.js';
import { ManagedRunnerService } from '../src/runner-service.js';

describe('managed runner HTTP API', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer(new ManagedRunnerService(new FakeSandboxProvider()));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.close();
    await once(server, 'close');
  });

  it('starts, reads, and destroys managed runs without exposing secrets', async () => {
    const started = await fetch(`${baseUrl}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-2',
        workspaceId: 'workspace-2',
        serverUrl: 'https://api.getviewport.test',
        leaseToken: 'lease-secret',
        vpdInstallCommand: 'true',
        workerCommand: 'echo ok',
        secrets: [{ name: 'TOKEN', value: 'secret-token' }],
      }),
    });
    expect(started.status).toBe(202);
    const startBody = (await started.json()) as { data: { id: string } };
    expect(JSON.stringify(startBody)).not.toContain('secret-token');

    const read = await fetch(`${baseUrl}/runs/${startBody.data.id}`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { data: { status: string } };
    expect(readBody.data.status).toBe('completed');
    expect(JSON.stringify(readBody)).not.toContain('secret-token');

    const destroyed = await fetch(`${baseUrl}/runs/${startBody.data.id}`, { method: 'DELETE' });
    expect(destroyed.status).toBe(200);
    const destroyBody = (await destroyed.json()) as { data: { status: string } };
    expect(destroyBody.data.status).toBe('destroyed');
  });
});
