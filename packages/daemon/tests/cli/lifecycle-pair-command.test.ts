import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('lifecycle pair command', () => {
  const originalArgv = process.argv.slice();
  const originalViewportHome = process.env['VIEWPORT_HOME'];
  const originalCwd = process.cwd();

  let homeDir = '';

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-pair-command-test-'));
    process.env['VIEWPORT_HOME'] = homeDir;
    process.chdir(homeDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.argv = originalArgv;
    process.chdir(originalCwd);
    if (originalViewportHome) process.env['VIEWPORT_HOME'] = originalViewportHome;
    else delete process.env['VIEWPORT_HOME'];
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('does not restart the personal monitor daemon for worker pairing', async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (request, response) => {
      if (request.method === 'POST' && request.url === '/api/pairing-codes') {
        const body = await readJsonBody(request);
        seenBodies.push(body);
        response.writeHead(201, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ code: 'ABC123', status_token: 'status_token_123' }));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/pairing-codes/ABC123/status') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            status: 'approved',
            workspace_id: 'workspace_123',
            workspace_name: 'Payments',
            install_id: 'install_123',
            runtime_target_id: 'runtime_123',
            managed_executor_id: 'executor_123',
            managed_executor_credential: 'vpexec_secret',
            server_id: 'sha256:server_123',
            relay_endpoint: 'wss://relay.getviewport.test/ws',
            token: 'issue_token_123',
            server_url: localServerUrl(server),
          }),
        );
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: 'Not found.' }));
    });
    await listen(server);
    const serverUrl = localServerUrl(server);

    process.argv = ['node', 'vpd', 'pair', '--worker', '--server', serverUrl, '--json'];
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => {
      printed.push(String(value));
    });
    const restartDaemon = vi.fn(async () => {
      throw new Error('worker pairing must not restart monitor daemon');
    });

    try {
      const { runPairCommand } = await import('../../src/cli/lifecycle-pair-command.js');
      await runPairCommand({ restartDaemon });
    } finally {
      await close(server);
    }

    expect(restartDaemon).not.toHaveBeenCalled();
    expect(seenBodies[0]).toMatchObject({
      runtime_role: 'worker',
      worker_lifecycle: 'persistent',
      worker_transport: 'polling',
    });
    const payload = JSON.parse(printed.at(-1) ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({
      command: 'pair',
      ok: true,
      flow: 'code-create',
      workspaceId: 'workspace_123',
      restarted: false,
    });

    const config = JSON.parse(await fs.readFile(path.join(homeDir, 'config.json'), 'utf8')) as {
      daemon: {
        relay?: unknown;
        worker: {
          serverUrl: string;
          workspaceId: string;
          managedExecutorId: string;
          credential: string;
          serverId: string;
        };
      };
    };
    expect(config.daemon.relay).toBeUndefined();
    expect(config.daemon.worker).toMatchObject({
      serverUrl,
      workspaceId: 'workspace_123',
      managedExecutorId: 'executor_123',
      credential: 'vpexec_secret',
      serverId: 'sha256:server_123',
    });
  });
});

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function localServerUrl(server: http.Server): string {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address.');
  }
  return `http://127.0.0.1:${address.port}`;
}
