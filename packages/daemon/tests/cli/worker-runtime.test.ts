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
      capabilities: { agents: {} },
    });
    await expectSignedRequest(requests[0], homeDir);
  });

  it('fails before control-plane contact when the worker workspace root is missing', async () => {
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests);
    await writeWorkerProfile(serverUrl(server));
    const missingRoot = path.join(homeDir, 'missing-worker-root');
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    const existing = manager.getDaemonConfig() ?? {};
    await manager.setDaemonConfig({
      ...existing,
      worker: {
        ...existing.worker,
        workspaceRoot: missingRoot,
      },
    });
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

    await expect(worker()).rejects.toThrow('Worker workspace root is not available');
    expect(requests).toEqual([]);
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

  it('keeps persistent polling workers online while idle until stopped', async () => {
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests, { claimAlwaysEmpty: true });
    const baseUrl = serverUrl(server);
    await writeWorkerProfile(baseUrl);
    vi.resetModules();
    const { runStandaloneWorker } = await import('../../src/cli/worker-runtime.js');
    const abort = new AbortController();

    const run = runStandaloneWorker({
      lifecycle: 'persistent',
      transport: 'polling',
      once: false,
      pollIntervalMs: 5,
      abortSignal: abort.signal,
    });
    await waitUntil(
      () => requests.filter((request) => request.url === '/api/runtime/workers/claim').length >= 2,
    );
    abort.abort();
    const result = await run;

    expect(result).toMatchObject({ claimed: 0, completed: 0, failed: 0, cleanup: 0 });
    expect(requests.map((request) => request.url)).toEqual([
      '/api/runtime/workers/heartbeat',
      '/api/runtime/workers/claim',
      '/api/runtime/workers/claim',
      '/api/runtime/workers/heartbeat',
    ]);
    expect(requests.at(-1)?.body).toMatchObject({ status: 'offline', health_status: 'offline' });
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
        agents: {
          codex: { id: 'codex', available: true, tier: 'sdk' },
        },
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

  it('retries transient hosted managed executor claim failures before executing', async () => {
    const projectDir = path.join(homeDir, 'hosted-transient-claim-workspace');
    await fs.mkdir(projectDir, { recursive: true });
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests, {
      transientHostedClaimFailures: 1,
      hostedAssignment: {
        yaml_snapshot: `
schema: viewport.workflow/v1
name: hosted-worker-transient-claim-proof
nodes:
  proof:
    type: shell
    argv:
      - printf
      - transient-claim-ok
`,
        source_ref: 'viewport://test/hosted-worker-transient-claim-proof',
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
    expect(
      requests.filter(
        (request) =>
          request.method === 'POST' &&
          request.url === '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim',
      ),
    ).toHaveLength(2);
    const sync = requests.find(
      (request) =>
        request.method === 'PATCH' &&
        request.url ===
          '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync',
    );
    expect(sync?.body).toMatchObject({
      status: 'completed',
      output_snapshot: expect.objectContaining({
        nodes: expect.objectContaining({
          proof: expect.objectContaining({ status: 'completed', output: 'transient-claim-ok' }),
        }),
      }),
    });
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

  it('retries transient hosted managed executor sync failures without losing the lease', async () => {
    const projectDir = path.join(homeDir, 'hosted-transient-sync-workspace');
    await fs.mkdir(projectDir, { recursive: true });
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests, {
      transientHostedSyncFailures: 1,
      hostedAssignment: {
        yaml_snapshot: `
schema: viewport.workflow/v1
name: hosted-worker-transient-sync-proof
nodes:
  proof:
    type: shell
    argv:
      - printf
      - transient-sync-ok
`,
        source_ref: 'viewport://test/hosted-worker-transient-sync-proof',
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
    const syncRequests = requests.filter(
      (request) =>
        request.method === 'PATCH' &&
        request.url ===
          '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync',
    );
    expect(syncRequests).toHaveLength(2);
    expect(syncRequests[0]?.body).toMatchObject({
      status: 'completed',
      output_snapshot: expect.objectContaining({
        nodes: expect.objectContaining({
          proof: expect.objectContaining({ status: 'completed', output: 'transient-sync-ok' }),
        }),
      }),
    });
    expect(syncRequests[1]?.body).toMatchObject(syncRequests[0]?.body ?? {});
    await expectSignedRequest(syncRequests[0], homeDir);
    await expectSignedRequest(syncRequests[1], homeDir);
  });

  it('polls hosted approval commands and resumes a blocked workflow run', async () => {
    const projectDir = path.join(homeDir, 'hosted-approval-workspace');
    await fs.mkdir(projectDir, { recursive: true });
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests, {
      hostedAssignment: {
        yaml_snapshot: `
schema: viewport.workflow/v1
name: hosted-worker-approval-proof
nodes:
  gate:
    type: gate
    gate:
      type: human_review
      prompt: Approve the hosted worker proof.
  proof:
    type: shell
    needs: [gate]
    argv:
      - printf
      - approval-resumed
`,
        source_ref: 'viewport://test/hosted-worker-approval-proof',
        directory_path: projectDir,
      },
      runtimeCommandsAfterBlockedSync: true,
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
      blocked: number;
      failed: number;
      cleanup: number;
    };
    expect(payload).toMatchObject({
      claimed: 1,
      completed: 1,
      blocked: 0,
      failed: 0,
      cleanup: 1,
    });
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim',
      'PATCH /api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync',
      'GET /api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1',
      'PATCH /api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync',
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
    ]);
    expect(requests[2]?.body).toMatchObject({
      status: 'blocked',
      nodes: expect.arrayContaining([
        expect.objectContaining({ node_key: 'gate', status: 'blocked' }),
      ]),
    });
    expect(requests[3]?.headers['x-viewport-assignment-claim']).toBe('vpclaim_run_1');
    await expectSignedRequest(requests[3], homeDir);
    expect(requests[4]?.body).toMatchObject({
      status: 'completed',
      approval_decisions: [],
      output_snapshot: expect.objectContaining({
        nodes: expect.objectContaining({
          gate: expect.objectContaining({ status: 'completed', output: 'Approved in test' }),
          proof: expect.objectContaining({ status: 'completed', output: 'approval-resumed' }),
        }),
      }),
    });
  });

  it('keeps polling hosted approval commands across sequential blocked gates', async () => {
    const projectDir = path.join(homeDir, 'hosted-multigate-workspace');
    await fs.mkdir(projectDir, { recursive: true });
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests, {
      hostedAssignment: {
        yaml_snapshot: `
schema: viewport.workflow/v1
name: hosted-worker-multigate-proof
nodes:
  pm_gate:
    type: gate
    gate:
      type: human_review
      prompt: PM approval.
  eng_gate:
    type: gate
    needs: [pm_gate]
    gate:
      type: human_review
      prompt: Eng approval.
  proof:
    type: shell
    needs: [eng_gate]
    argv:
      - printf
      - multigate-resumed
`,
        source_ref: 'viewport://test/hosted-worker-multigate-proof',
        directory_path: projectDir,
      },
      runtimeCommandsByBlockedNode: {
        pm_gate: { message: 'PM approved in test' },
        eng_gate: { message: 'Eng approved in test' },
      },
      rateLimitOnceForBlockedNode: 'eng_gate',
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
      blocked: number;
      failed: number;
      cleanup: number;
    };
    expect(payload).toMatchObject({
      claimed: 1,
      completed: 1,
      blocked: 0,
      failed: 0,
      cleanup: 1,
    });
    const requestNames = requests.map((request) => `${request.method} ${request.url}`);
    expect(requestNames).toEqual([
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim',
      'PATCH /api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync',
      'GET /api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1',
      'PATCH /api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync',
      'GET /api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1',
      'GET /api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1',
      'PATCH /api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync',
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
    ]);
    expect(requests[2]?.body).toMatchObject({
      status: 'blocked',
      nodes: expect.arrayContaining([
        expect.objectContaining({ node_key: 'pm_gate', status: 'blocked' }),
      ]),
    });
    expect(requests[4]?.body).toMatchObject({
      status: 'blocked',
      nodes: expect.arrayContaining([
        expect.objectContaining({ node_key: 'pm_gate', status: 'completed' }),
        expect.objectContaining({ node_key: 'eng_gate', status: 'blocked' }),
      ]),
    });
    expect(requests[6]?.method).toBe('GET');
    expect(requests[7]?.body).toMatchObject({
      status: 'completed',
      approval_decisions: [],
      output_snapshot: expect.objectContaining({
        nodes: expect.objectContaining({
          pm_gate: expect.objectContaining({ status: 'completed', output: 'PM approved in test' }),
          eng_gate: expect.objectContaining({
            status: 'completed',
            output: 'Eng approved in test',
          }),
          proof: expect.objectContaining({ status: 'completed', output: 'multigate-resumed' }),
        }),
      }),
    });
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
    const { resolvePairingServerTransport } =
      await import('../../src/cli/lifecycle-pair-server.js');
    const { resolveWorkerProfileDefaults, storeWorkerProfile } =
      await import('../../src/cli/worker-profile.js');
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
  let blockedRuntimeRunId: string | null = null;
  let blockedNodeId: string | null = null;
  const rateLimitedBlockedNodes = new Set<string>();
  let transientHostedClaimFailures = options.transientHostedClaimFailures ?? 0;
  let transientHostedSyncFailures = options.transientHostedSyncFailures ?? 0;
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
      if (options.claimAlwaysEmpty) {
        response.statusCode = 204;
        response.end();
        return;
      }
      if (claimCount > 1) {
        response.statusCode = 204;
        response.end();
        return;
      }
      response.end(JSON.stringify({ lease: { id: 'lease_1', run_id: 'run_1' } }));
      return;
    }
    if (request.url === '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim') {
      if (transientHostedClaimFailures > 0) {
        transientHostedClaimFailures -= 1;
        response.statusCode = 500;
        response.end(JSON.stringify({ message: 'database is locked' }));
        return;
      }
      claimCount += 1;
      if (options.claimAlwaysEmpty) {
        response.statusCode = 204;
        response.end();
        return;
      }
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
    if (
      request.url ===
        '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync' &&
      request.method === 'PATCH' &&
      transientHostedSyncFailures > 0
    ) {
      transientHostedSyncFailures -= 1;
      response.statusCode = 500;
      response.end(JSON.stringify({ message: 'database is locked' }));
      return;
    }
    if (
      request.url ===
        '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync' &&
      request.method === 'PATCH' &&
      body['status'] === 'blocked'
    ) {
      blockedRuntimeRunId =
        typeof body['runtime_run_id'] === 'string' ? body['runtime_run_id'] : null;
      blockedNodeId = blockedNodeFromSync(body);
    }
    if (
      request.url ===
        '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1' &&
      request.method === 'GET' &&
      options.runtimeCommandsAfterBlockedSync &&
      blockedRuntimeRunId
    ) {
      response.end(
        JSON.stringify({
          data: {
            id: 'run_1',
            status: 'running',
          },
          runtime_commands: [
            {
              id: 'approval-command-1',
              type: 'workflow.approval_decision',
              workflow_run_id: blockedRuntimeRunId,
              workflow_node_id: 'gate',
              approved: true,
              decision: 'approve',
              message: 'Approved in test',
            },
          ],
        }),
      );
      return;
    }
    if (
      request.url ===
        '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1' &&
      request.method === 'GET' &&
      options.runtimeCommandsByBlockedNode &&
      blockedRuntimeRunId &&
      blockedNodeId
    ) {
      if (
        options.rateLimitOnceForBlockedNode === blockedNodeId &&
        !rateLimitedBlockedNodes.has(blockedNodeId)
      ) {
        rateLimitedBlockedNodes.add(blockedNodeId);
        response.statusCode = 429;
        response.setHeader('Retry-After', '1');
        response.end(JSON.stringify({ message: 'Too Many Attempts.' }));
        return;
      }
      const command = options.runtimeCommandsByBlockedNode[blockedNodeId];
      response.end(
        JSON.stringify({
          data: {
            id: 'run_1',
            status: 'running',
          },
          runtime_commands: command
            ? [
                {
                  id: `approval-command-${blockedNodeId}`,
                  type: 'workflow.approval_decision',
                  workflow_run_id: blockedRuntimeRunId,
                  workflow_node_id: blockedNodeId,
                  approved: true,
                  decision: 'approve',
                  message: command.message,
                },
              ]
            : [],
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
  claimAlwaysEmpty?: boolean;
  transientHostedClaimFailures?: number;
  runtimeCommandsAfterBlockedSync?: boolean;
  runtimeCommandsByBlockedNode?: Record<string, { message: string }>;
  rateLimitOnceForBlockedNode?: string;
  transientHostedSyncFailures?: number;
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

function blockedNodeFromSync(body: Record<string, unknown>): string | null {
  const nodes = body['nodes'];
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;
    if (record['status'] === 'blocked' && typeof record['node_key'] === 'string') {
      return record['node_key'];
    }
  }
  return null;
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
  const signedBody = request!.method === 'GET' ? '' : JSON.stringify(request!.body);
  expect(bodySha256).toBe(crypto.createHash('sha256').update(signedBody).digest('hex'));
  const identity = JSON.parse(
    await fs.readFile(path.join(homeDir, 'worker', 'identity.json'), 'utf8'),
  ) as { publicKey: string };
  const canonical = [request!.method, request!.url, bodySha256, nonce, timestamp].join('\n');
  expect(
    crypto.verify(
      null,
      Buffer.from(canonical),
      identity.publicKey,
      Buffer.from(signature, 'base64'),
    ),
  ).toBe(true);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition.');
}
