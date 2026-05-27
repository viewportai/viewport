import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('standalone worker runtime', () => {
  const originalArgv = process.argv.slice();
  const originalHome = process.env['VIEWPORT_HOME'];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let homeDir = '';
  let server: http.Server | null = null;

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-worker-runtime-'));
    process.env['VIEWPORT_HOME'] = homeDir;
    delete process.env['VIEWPORT_PROFILE'];
  });

  afterEach(async () => {
    process.argv = originalArgv;
    if (originalHome) process.env['VIEWPORT_HOME'] = originalHome;
    else delete process.env['VIEWPORT_HOME'];
    if (server) {
      await closeServer(server);
      server = null;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('runs one persistent polling claim through sync and cleanup', async () => {
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests);
    const baseUrl = serverUrl(server);
    await writeWorkerProfile(baseUrl);
    process.argv = [
      'node',
      'vpd',
      'worker',
      'start',
      '--mode',
      'persistent',
      '--transport',
      'polling',
      '--once',
      '--json',
    ];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');

    await worker();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      claimed: number;
      completed: number;
      failed: number;
      cleanup: number;
    };
    expect(payload).toMatchObject({ claimed: 1, completed: 1, failed: 0, cleanup: 1 });
    expect(requests.map((request) => request.url)).toEqual([
      '/api/runtime/workers/heartbeat',
      '/api/runtime/workers/claim',
      '/api/runtime/workers/leases/lease_1/sync',
      '/api/runtime/workers/leases/lease_1/cleanup',
      '/api/runtime/workers/heartbeat',
    ]);
    expect(requests[0]?.body).toMatchObject({
      lifecycle: 'persistent',
      transport: 'polling',
      capabilities: { agents: [] },
    });
    await expectSignedRequest(requests[0], homeDir);
  });

  it('runs an ephemeral lease token through sync and cleanup', async () => {
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests);
    await writeWorkerProfile(serverUrl(server));
    process.argv = [
      'node',
      'vpd',
      'worker',
      'run-once',
      '--lease',
      'lease_token_123',
      '--transport',
      'polling',
      '--json',
    ];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');

    await worker();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      claimed: number;
      completed: number;
      failed: number;
      cleanup: number;
    };
    expect(payload).toMatchObject({ claimed: 1, completed: 1, failed: 0, cleanup: 1 });
    expect(requests.map((request) => request.url)).toEqual([
      '/api/runtime/workers/heartbeat',
      '/api/runtime/workers/leases/lease_token_123/sync',
      '/api/runtime/workers/leases/lease_token_123/cleanup',
    ]);
  });

  it('fails closed for hosted managed executor claims without executable workflow material', async () => {
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests);
    await writeHostedWorkerProfile(serverUrl(server));
    process.argv = [
      'node',
      'vpd',
      'worker',
      'start',
      '--mode',
      'persistent',
      '--transport',
      'polling',
      '--once',
      '--json',
    ];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');

    await worker();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      claimed: number;
      completed: number;
      failed: number;
      cleanup: number;
    };
    expect(payload).toMatchObject({ claimed: 1, completed: 0, failed: 1, cleanup: 1 });
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim',
      'PATCH /api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync',
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
    ]);
    expect(requests[0]?.body).toMatchObject({
      credential: 'vpexec_hosted',
      access_mode: 'polling',
      runner_mode: 'self_hosted',
      runner_provider: 'local',
      capabilities: {
        agents: [{ id: 'codex', available: true, tier: 'sdk' }],
      },
    });
    expect(requests[2]?.headers['x-viewport-assignment-claim']).toBe('vpclaim_run_1');
    expect(requests[2]?.body).toMatchObject({
      credential: 'vpexec_hosted',
      runtime_run_id: 'vpd-worker-run_1',
      status: 'failed',
      error_summary:
        'Standalone hosted worker claimed the run but no workflow execution engine is wired yet.',
      failure: expect.objectContaining({
        schema: 'viewport.workflow_failure/v1',
        error_code: 'RUNNER_EXECUTION_ENGINE_UNAVAILABLE',
        failure_class: 'internal_error',
        retry_safe: false,
        lease_released: true,
      }),
      events: [expect.objectContaining({ type: 'run-failed', severity: 'error' })],
    });
    await expectSignedRequest(requests[2], homeDir);
  });

  it('executes hosted managed executor workflow material in-process before syncing', async () => {
    const projectDir = path.join(homeDir, 'hosted-workspace');
    await fs.mkdir(projectDir, { recursive: true });
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests, {
      hostedAssignment: {
        yaml_snapshot: `
schema: viewport.workflow/v1
name: hosted-worker-shell-proof
nodes:
  proof:
    type: shell
    argv:
      - printf
      - hosted-ok
`,
        source_ref: 'viewport://test/hosted-worker-shell-proof',
        directory_path: projectDir,
      },
    });
    await writeHostedWorkerProfile(serverUrl(server));
    process.argv = [
      'node',
      'vpd',
      'worker',
      'start',
      '--mode',
      'persistent',
      '--transport',
      'polling',
      '--once',
      '--json',
    ];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');

    await worker();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      claimed: number;
      completed: number;
      failed: number;
      cleanup: number;
    };
    expect(payload).toMatchObject({ claimed: 1, completed: 1, failed: 0, cleanup: 1 });
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim',
      'PATCH /api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync',
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
    ]);
    const sync = requests[2]?.body;
    expect(sync).toMatchObject({
      credential: 'vpexec_hosted',
      status: 'completed',
      output_snapshot: expect.objectContaining({
        nodes: expect.objectContaining({
          proof: expect.objectContaining({ status: 'completed', output: 'hosted-ok' }),
        }),
      }),
      events: expect.arrayContaining([expect.objectContaining({ type: 'run-completed' })]),
    });
    expect(String(sync?.['runtime_run_id'] ?? '')).not.toBe('vpd-worker-run_1');
    expect(sync?.['nodes']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node_key: 'proof',
          status: 'completed',
          output: 'hosted-ok',
        }),
      ]),
    );
    await expectSignedRequest(requests[2], homeDir);
  });

  it('denies inbound transport until signed inbound proof exists', async () => {
    await writeWorkerProfile('http://127.0.0.1:1');
    process.argv = [
      'node',
      'vpd',
      'worker',
      'start',
      '--mode',
      'persistent',
      '--transport',
      'inbound',
      '--once',
    ];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');

    await expect(worker()).rejects.toThrow('Inbound worker transport is disabled');
  });

  it('reports relay as unsupported until relay worker runtime lands', async () => {
    await writeWorkerProfile('http://127.0.0.1:1');
    process.argv = [
      'node',
      'vpd',
      'worker',
      'start',
      '--mode',
      'persistent',
      '--transport',
      'relay',
      '--once',
    ];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');

    await expect(worker()).rejects.toThrow('Relay worker transport is not supported');
  });

  it('denies ephemeral inbound and relay run-once transports before control-plane contact', async () => {
    await writeWorkerProfile('http://127.0.0.1:1');
    for (const transport of ['inbound', 'relay']) {
      process.argv = [
        'node',
        'vpd',
        'worker',
        'run-once',
        '--lease',
        `lease_${transport}`,
        '--transport',
        transport,
      ];
      vi.resetModules();
      const { worker } = await import('../../src/cli/worker-command.js');
      await expect(worker()).rejects.toThrow(
        transport === 'inbound' ? 'Inbound worker transport is disabled' : 'Relay worker transport',
      );
    }
  });

  async function writeWorkerProfile(serverUrl: string): Promise<void> {
    process.argv = ['node', 'vpd', 'pair', '--worker', '--server', serverUrl];
    vi.resetModules();
    const { resolvePairingServerTransport } = await import(
      '../../src/cli/lifecycle-pair-server.js'
    );
    const { resolveWorkerProfileDefaults, storeWorkerProfile } = await import(
      '../../src/cli/worker-profile.js'
    );
    await storeWorkerProfile(
      null,
      await resolveWorkerProfileDefaults({
        server: await resolvePairingServerTransport(),
        detectCapabilities: false,
      }),
    );
  }

  async function writeHostedWorkerProfile(serverUrl: string): Promise<void> {
    await writeWorkerProfile(serverUrl);
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    const existing = manager.getDaemonConfig() ?? {};
    await manager.setDaemonConfig({
      ...existing,
      worker: {
        ...existing.worker,
        workspaceId: 'workspace_1',
        managedExecutorId: 'executor_1',
        credential: 'vpexec_hosted',
        capabilities: {
          agents: [{ id: 'codex', displayName: 'Codex', tier: 'sdk', available: true }],
        },
      },
    });
  }
});

async function startRuntimeServer(
  requests: RuntimeRequest[],
  options: RuntimeServerOptions = {},
): Promise<http.Server> {
  let claimCount = 0;
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({
      url: request.url ?? '',
      method: request.method ?? 'GET',
      body,
      headers: request.headers,
    });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/runtime/workers/claim') {
      claimCount += 1;
      if (claimCount > 1) {
        response.statusCode = 204;
        response.end();
        return;
      }
      response.end(JSON.stringify({ lease: { id: 'lease_1', run_id: 'run_1' } }));
      return;
    }
    if (
      request.url === '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim'
    ) {
      claimCount += 1;
      if (claimCount > 1) {
        response.statusCode = 204;
        response.end();
        return;
      }
      response.end(
        JSON.stringify({
          data: {
            id: 'run_1',
            assignment_claim_token: 'vpclaim_run_1',
            ...(options.hostedAssignment ?? {}),
            run_lease: {
              lease_id: 'workflow_run:run_1',
              workflow_run_id: 'run_1',
            },
          },
        }),
      );
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

interface RuntimeServerOptions {
  hostedAssignment?: Record<string, unknown>;
}

interface RuntimeRequest {
  url: string;
  method: string;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

function serverUrl(server: http.Server): string {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address.');
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function expectSignedRequest(request: RuntimeRequest | undefined, homeDir: string) {
  expect(request).toBeDefined();
  const headers = request!.headers;
  const fingerprint = String(headers['x-viewport-worker-fingerprint'] ?? '');
  const timestamp = String(headers['x-viewport-worker-timestamp'] ?? '');
  const nonce = String(headers['x-viewport-worker-nonce'] ?? '');
  const bodySha256 = String(headers['x-viewport-worker-body-sha256'] ?? '');
  const signature = String(headers['x-viewport-worker-signature'] ?? '');
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(timestamp).toContain('T');
  expect(nonce).toMatch(/^[a-f0-9]{32}$/);
  expect(bodySha256).toBe(
    crypto.createHash('sha256').update(JSON.stringify(request!.body)).digest('hex'),
  );
  const identity = JSON.parse(
    await fs.readFile(path.join(homeDir, 'worker', 'identity.json'), 'utf8'),
  ) as { publicKey: string };
  const canonical = [request!.method, request!.url, bodySha256, nonce, timestamp].join('\n');
  expect(
    crypto.verify(null, Buffer.from(canonical), identity.publicKey, Buffer.from(signature, 'base64')),
  ).toBe(true);
}
