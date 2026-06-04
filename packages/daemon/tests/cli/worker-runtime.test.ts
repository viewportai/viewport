import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireWorkerProcessLock } from '../../src/cli/worker-process-lock.js';

describe('standalone worker runtime', () => {
  const originalArgv = process.argv.slice();
  const originalHome = process.env['VIEWPORT_HOME'];
  const originalInboundExperimental = process.env['VPD_WORKER_INBOUND_EXPERIMENTAL'];
  const originalRelayWsBaseUrl = process.env['VIEWPORT_RELAY_WS_BASE_URL'];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let homeDir = '';
  let server: http.Server | null = null;

  beforeEach(async () => {
    vi.resetModules();
    logSpy.mockClear();
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-worker-runtime-'));
    process.env['VIEWPORT_HOME'] = homeDir;
    delete process.env['VPD_WORKER_INBOUND_EXPERIMENTAL'];
    delete process.env['VIEWPORT_RELAY_WS_BASE_URL'];
    delete process.env['VIEWPORT_PROFILE'];
  });

  afterEach(async () => {
    process.argv = originalArgv;
    if (originalHome) process.env['VIEWPORT_HOME'] = originalHome;
    else delete process.env['VIEWPORT_HOME'];
    if (originalInboundExperimental) {
      process.env['VPD_WORKER_INBOUND_EXPERIMENTAL'] = originalInboundExperimental;
    } else {
      delete process.env['VPD_WORKER_INBOUND_EXPERIMENTAL'];
    }
    if (originalRelayWsBaseUrl) {
      process.env['VIEWPORT_RELAY_WS_BASE_URL'] = originalRelayWsBaseUrl;
    } else {
      delete process.env['VIEWPORT_RELAY_WS_BASE_URL'];
    }
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

  it('lets hosted polling workers request an explicit lease duration', async () => {
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
      '--lease',
      '3600',
      '--once',
      '--json',
    ];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');

    await worker();

    const claim = requests.find((request) => request.url.endsWith('/claim'));
    expect(claim?.body).toMatchObject({ lease_seconds: 3600 });
  });

  it('requests the hosted default lease duration for polling workers', async () => {
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

    const claim = requests.find((request) => request.url.endsWith('/claim'));
    expect(claim?.body).toMatchObject({ lease_seconds: 1800 });
  });

  it('advertises persisted worker capabilities on standalone heartbeat', async () => {
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests);
    const baseUrl = serverUrl(server);
    await writeWorkerProfile(baseUrl);
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    const existing = manager.getDaemonConfig() ?? {};
    await manager.setDaemonConfig({
      ...existing,
      worker: {
        ...existing.worker,
        runnerPool: 'payments-prod',
        capabilities: {
          agents: {
            claude: {
              id: 'claude',
              displayName: 'Claude',
              tier: 'sdk',
              available: true,
              models: ['claude-sonnet-4.6'],
              default_model: 'claude-sonnet-4.6',
              tools: ['read', 'grep'],
              supports_plan_mode: true,
            },
          },
          models: ['claude-sonnet-4.6'],
          tools: ['shell', 'read', 'grep'],
          integrations: ['github', 'slack'],
          secrets: ['github/pr-writer'],
          runner_pool: 'payments-prod',
        },
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

    await worker();

    expect(requests[0]?.body).toMatchObject({
      lifecycle: 'persistent',
      transport: 'polling',
      public_key_fingerprint: expect.any(String),
      capabilities: {
        agents: {
          claude: expect.objectContaining({
            id: 'claude',
            available: true,
            models: ['claude-sonnet-4.6'],
            supports_plan_mode: true,
          }),
        },
        models: ['claude-sonnet-4.6'],
        tools: ['shell', 'read', 'grep'],
        integrations: ['github', 'slack'],
        secrets: ['github/pr-writer'],
        runner_pool: 'payments-prod',
      },
    });
    expect(requests.at(-1)?.body).toMatchObject({
      status: 'offline',
      capabilities: expect.objectContaining({
        agents: expect.objectContaining({ claude: expect.any(Object) }),
      }),
    });
  });

  it('uses persisted runner pool as hosted managed executor runner profile', async () => {
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests);
    await writeHostedWorkerProfile(serverUrl(server));
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    const existing = manager.getDaemonConfig() ?? {};
    await manager.setDaemonConfig({
      ...existing,
      worker: {
        ...existing.worker,
        capabilities: {
          ...(existing.worker?.capabilities ?? {}),
          runner_pool: 'payments-prod',
        },
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

    await worker();

    expect(requests[0]?.body).toMatchObject({
      credential: 'vpexec_hosted',
      runner_profile: 'payments-prod',
      capabilities: { runner_pool: 'payments-prod' },
    });
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

  it('resets worker pairing and identity before re-pairing', async () => {
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests);
    await writeWorkerProfile(serverUrl(server));
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    const firstWorker = manager.getDaemonConfig()?.worker;
    const firstFingerprint = firstWorker?.publicKeyFingerprint;
    const identityPath = firstWorker?.identityKeyPath;
    expect(firstFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(identityPath).toBeTruthy();
    await expect(fs.stat(String(identityPath))).resolves.toBeTruthy();

    process.argv = ['node', 'vpd', 'worker', 'reset', '--json'];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');
    await worker();

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      ok: boolean;
      hadWorkerProfile: boolean;
      removedIdentity: boolean;
    };
    expect(payload).toMatchObject({
      ok: true,
      hadWorkerProfile: true,
      removedIdentity: true,
    });
    await manager.load();
    expect(manager.getDaemonConfig()?.worker).toBeUndefined();
    await expect(fs.stat(String(identityPath))).rejects.toThrow();

    await writeWorkerProfile(serverUrl(server));
    await manager.load();
    const nextWorker = manager.getDaemonConfig()?.worker;
    expect(nextWorker?.publicKeyFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(nextWorker?.publicKeyFingerprint).not.toBe(firstFingerprint);
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

  it('runs a sandbox bootstrap lease once without polling for idle work or persisting identity', async () => {
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests);
    const workspaceRoot = await fs.mkdtemp(path.join(homeDir, 'bootstrap-workspace-'));
    const identity = createWorkerIdentity();
    const bootstrapPath = path.join(homeDir, 'sandbox-bootstrap.json');
    await fs.writeFile(
      bootstrapPath,
      `${JSON.stringify(
        {
          schema: 'viewport.sandbox_bootstrap/v1',
          server_url: serverUrl(server),
          server_id: 'sha256:server_1',
          workspace_id: 'workspace_1',
          executor_id: 'executor_1',
          credential: 'vpexec_bootstrap',
          workspace_root: workspaceRoot,
          transport: 'polling',
          capabilities: {
            schema: 'viewport.managed_executor_capabilities/v1',
            agents: [{ id: 'codex', displayName: 'Codex', tier: 'sdk', available: true }],
          },
          identity: {
            public_key: identity.publicKey,
            private_key: identity.privateKey,
            public_key_fingerprint: identity.publicKeyFingerprint,
          },
          lease: {
            id: 'workflow_run:run_1',
            workflow_run_id: 'run_1',
            lease_token: 'vplease_bootstrap',
            assignment_claim_token: 'vpclaim_bootstrap',
            yaml_snapshot: [
              'schema: viewport.workflow/v1',
              'name: bootstrap-proof',
              'nodes:',
              '  proof:',
              '    type: shell',
              '    env:',
              '      OPENAI_API_KEY:',
              '        secret: OPENAI_API_KEY',
              '      OPENAI_BASE_URL:',
              '        value: https://gateway.getviewport.test/v1',
              '      VIEWPORT_LLM_PROVIDER:',
              '        value: openai',
              '      VIEWPORT_LLM_MODEL:',
              '        value: gpt-4o-mini',
              '      VIEWPORT_LLM_VIRTUAL_KEY:',
              '        secret: VIEWPORT_LLM_VIRTUAL_KEY',
              '    command: |',
              '      case "$OPENAI_API_KEY" in vk_*) ;; *) exit 12;; esac',
              '      test "$OPENAI_BASE_URL" = "https://gateway.getviewport.test/v1"',
              '      test "$VIEWPORT_LLM_PROVIDER" = "openai"',
              '      test "$VIEWPORT_LLM_MODEL" = "gpt-4o-mini"',
              '      test "$VIEWPORT_LLM_VIRTUAL_KEY" = "$OPENAI_API_KEY"',
              '      printf gateway-env-ok',
              '',
            ].join('\n'),
            directory_path: workspaceRoot,
            gateway: {
              schema: 'viewport.gateway_lease/v1',
              gateway_base_url: 'https://gateway.getviewport.test',
              provider: 'openai',
              model_allow: ['gpt-4o-mini'],
              virtual_key: {
                token: 'vk_bootstrap_gateway',
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    process.argv = ['node', 'vpd', 'worker', 'run-once', '--bootstrap', bootstrapPath, '--json'];
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
      '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync',
      '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
    ]);
    expect(requests[0]?.body.capabilities).not.toHaveProperty('schema');
    expect(requests[0]?.body.capabilities).toMatchObject({
      agents: {
        codex: expect.objectContaining({ available: true }),
      },
    });
    expect(requests.some((request) => request.url.endsWith('/claim'))).toBe(false);
    expect(requests[1]?.headers['x-viewport-run-lease']).toBe('vplease_bootstrap');
    expect(requests[1]?.body).toMatchObject({
      status: 'completed',
      output_snapshot: expect.objectContaining({
        nodes: expect.objectContaining({
          proof: expect.objectContaining({ output: 'gateway-env-ok' }),
        }),
      }),
    });
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? '')).not.toContain('vpexec_bootstrap');
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? '')).not.toContain('vpclaim_bootstrap');
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? '')).not.toContain('vk_bootstrap_gateway');
    expect(process.env['OPENAI_API_KEY']).not.toBe('vk_bootstrap_gateway');
    expect(process.env['VIEWPORT_LLM_VIRTUAL_KEY']).not.toBe('vk_bootstrap_gateway');
    const bootstrapIdentityFiles = await fs.readdir(
      path.join(workspaceRoot, '.viewport', 'bootstrap'),
    );
    expect(bootstrapIdentityFiles).toEqual([]);
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

  it('does not hot-loop persistent polling claims when the control plane has no work', async () => {
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests, { claimAlwaysEmpty: true });
    await writeWorkerProfile(serverUrl(server));
    vi.resetModules();
    const { runStandaloneWorker } = await import('../../src/cli/worker-runtime.js');
    const abort = new AbortController();

    const run = runStandaloneWorker({
      lifecycle: 'persistent',
      transport: 'polling',
      once: false,
      pollIntervalMs: 25,
      abortSignal: abort.signal,
    });
    await waitUntil(
      () => requests.filter((request) => request.url === '/api/runtime/workers/claim').length >= 3,
      2_000,
    );
    abort.abort();
    const result = await run;
    const claimTimes = requests
      .filter((request) => request.url === '/api/runtime/workers/claim')
      .map((request) => request.receivedAtMs);

    expect(result).toMatchObject({ claimed: 0, completed: 0, failed: 0, cleanup: 0 });
    expect(claimTimes.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < Math.min(claimTimes.length, 4); i += 1) {
      expect(claimTimes[i]! - claimTimes[i - 1]!).toBeGreaterThanOrEqual(18);
    }
  });

  it('soaks through multiple persistent polling leases, drains cleanup, then idles until stopped', async () => {
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests, {
      genericLeasesBeforeEmpty: 3,
    });
    await writeWorkerProfile(serverUrl(server));
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
      () => requests.filter((request) => request.url === '/api/runtime/workers/claim').length >= 4,
      2_000,
    );
    abort.abort();
    const result = await run;
    const requestNames = requests.map((request) => `${request.method} ${request.url}`);

    expect(result).toMatchObject({
      claimed: 3,
      completed: 3,
      blocked: 0,
      failed: 0,
      cleanup: 3,
      denied: 0,
    });
    expect(requestNames).toEqual([
      'POST /api/runtime/workers/heartbeat',
      'POST /api/runtime/workers/claim',
      'POST /api/runtime/workers/leases/lease_1/sync',
      'POST /api/runtime/workers/leases/lease_1/cleanup',
      'POST /api/runtime/workers/claim',
      'POST /api/runtime/workers/leases/lease_2/sync',
      'POST /api/runtime/workers/leases/lease_2/cleanup',
      'POST /api/runtime/workers/claim',
      'POST /api/runtime/workers/leases/lease_3/sync',
      'POST /api/runtime/workers/leases/lease_3/cleanup',
      'POST /api/runtime/workers/claim',
      'POST /api/runtime/workers/heartbeat',
    ]);
    expect(requests.at(-1)?.body).toMatchObject({ status: 'offline', health_status: 'offline' });
    for (const request of requests.filter((entry) => entry.url.includes('/leases/'))) {
      await expectSignedRequest(request, homeDir);
    }
  });

  it('drains queued leases across repeated persistent worker restarts', async () => {
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests, {
      genericLeasesBeforeEmpty: 3,
    });
    await writeWorkerProfile(serverUrl(server));
    vi.resetModules();
    const { runStandaloneWorker } = await import('../../src/cli/worker-runtime.js');

    const first = await runStandaloneWorker({
      lifecycle: 'persistent',
      transport: 'polling',
      once: true,
      pollIntervalMs: 5,
    });
    const second = await runStandaloneWorker({
      lifecycle: 'persistent',
      transport: 'polling',
      once: true,
      pollIntervalMs: 5,
    });
    const third = await runStandaloneWorker({
      lifecycle: 'persistent',
      transport: 'polling',
      once: true,
      pollIntervalMs: 5,
    });
    const idleAfterDrain = await runStandaloneWorker({
      lifecycle: 'persistent',
      transport: 'polling',
      once: true,
      pollIntervalMs: 5,
    });

    expect([first, second, third]).toEqual([
      { claimed: 1, completed: 1, blocked: 0, failed: 0, cleanup: 1, denied: 0 },
      { claimed: 1, completed: 1, blocked: 0, failed: 0, cleanup: 1, denied: 0 },
      { claimed: 1, completed: 1, blocked: 0, failed: 0, cleanup: 1, denied: 0 },
    ]);
    expect(idleAfterDrain).toMatchObject({
      claimed: 0,
      completed: 0,
      blocked: 0,
      failed: 0,
      cleanup: 0,
      denied: 0,
    });
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST /api/runtime/workers/heartbeat',
      'POST /api/runtime/workers/claim',
      'POST /api/runtime/workers/leases/lease_1/sync',
      'POST /api/runtime/workers/leases/lease_1/cleanup',
      'POST /api/runtime/workers/heartbeat',
      'POST /api/runtime/workers/heartbeat',
      'POST /api/runtime/workers/claim',
      'POST /api/runtime/workers/leases/lease_2/sync',
      'POST /api/runtime/workers/leases/lease_2/cleanup',
      'POST /api/runtime/workers/heartbeat',
      'POST /api/runtime/workers/heartbeat',
      'POST /api/runtime/workers/claim',
      'POST /api/runtime/workers/leases/lease_3/sync',
      'POST /api/runtime/workers/leases/lease_3/cleanup',
      'POST /api/runtime/workers/heartbeat',
      'POST /api/runtime/workers/heartbeat',
      'POST /api/runtime/workers/claim',
      'POST /api/runtime/workers/heartbeat',
    ]);
    for (const request of requests.filter((entry) => entry.url.includes('/leases/'))) {
      await expectSignedRequest(request, homeDir);
    }
    expect(
      requests.filter((request) => request.url === '/api/runtime/workers/leases/lease_1/cleanup'),
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.url === '/api/runtime/workers/leases/lease_2/cleanup'),
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.url === '/api/runtime/workers/leases/lease_3/cleanup'),
    ).toHaveLength(1);
  });

  it('prevents duplicate standalone persistent workers for the same paired profile', async () => {
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests, { claimAlwaysEmpty: true });
    await writeHostedWorkerProfile(serverUrl(server));
    const lock = acquireWorkerProcessLock({
      server: serverUrl(server),
      workspaceId: 'workspace_1',
      executorId: 'executor_1',
      accessMode: 'polling',
    });
    try {
      process.argv = [
        'node',
        'vpd',
        'worker',
        'start',
        '--mode',
        'persistent',
        '--transport',
        'polling',
        '--json',
      ];
      vi.resetModules();
      const { worker } = await import('../../src/cli/worker-command.js');

      await expect(worker()).rejects.toThrow('vpd worker run-once --lease <lease-token>');
      expect(requests).toEqual([]);
    } finally {
      lock.release();
    }
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
      runner_profile: null,
      capabilities: {
        agents: {
          codex: { id: 'codex', available: true, tier: 'sdk' },
        },
      },
    });
    expect(requests[2]?.headers['x-viewport-run-lease']).toBe('vplease_run_1');
    expect(requests[2]?.headers['x-viewport-assignment-claim']).toBeUndefined();
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

  it('fails hosted managed executor claims before execution when run lease token is missing', async () => {
    const projectDir = path.join(homeDir, 'hosted-missing-lease-token-workspace');
    await fs.mkdir(projectDir, { recursive: true });
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests, {
      omitHostedLeaseToken: true,
      hostedAssignment: {
        yaml_snapshot: `
schema: viewport.workflow/v1
name: hosted-worker-missing-lease-token-proof
nodes:
  proof:
    type: shell
    argv:
      - printf
      - should-not-execute
`,
        source_ref: 'viewport://test/hosted-worker-missing-lease-token-proof',
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
    expect(payload).toMatchObject({ claimed: 1, completed: 0, failed: 1, cleanup: 1 });
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim',
      'PATCH /api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync',
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
    ]);
    expect(requests[2]?.headers['x-viewport-assignment-claim']).toBe('vpclaim_run_1');
    expect(requests[2]?.headers['x-viewport-run-lease']).toBeUndefined();
    expect(requests[2]?.body).toMatchObject({
      credential: 'vpexec_hosted',
      status: 'failed',
      failure: expect.objectContaining({
        schema: 'viewport.workflow_failure/v1',
        error_code: 'RUNNER_LEASE_TOKEN_MISSING',
        failure_class: 'authorization_denied',
        retry_safe: false,
        lease_released: true,
      }),
    });
    expect(requests[2]?.body).not.toMatchObject({
      output_snapshot: expect.objectContaining({
        nodes: expect.objectContaining({
          proof: expect.anything(),
        }),
      }),
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
    expect(requests[3]?.headers['x-viewport-run-lease']).toBe('vplease_run_1');
    expect(requests[3]?.headers['x-viewport-assignment-claim']).toBeUndefined();
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

  it('releases a blocked hosted workflow run when no approval command is available', async () => {
    const projectDir = path.join(homeDir, 'hosted-approval-no-command-workspace');
    await fs.mkdir(projectDir, { recursive: true });
    const requests: RuntimeRequest[] = [];
    server = await startRuntimeServer(requests, {
      hostedAssignment: {
        yaml_snapshot: `
schema: viewport.workflow/v1
name: hosted-worker-no-command-proof
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
      - should-not-run
`,
        source_ref: 'viewport://test/hosted-worker-no-command-proof',
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
      blocked: number;
      failed: number;
      cleanup: number;
    };
    expect(payload).toMatchObject({
      claimed: 1,
      completed: 0,
      blocked: 1,
      failed: 0,
      cleanup: 1,
    });
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim',
      'PATCH /api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync',
      'GET /api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1',
      'POST /api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
    ]);
    expect(requests[2]?.body).toMatchObject({
      status: 'blocked',
      nodes: expect.arrayContaining([
        expect.objectContaining({ node_key: 'gate', status: 'blocked' }),
      ]),
    });
  });

  it('reclaims a blocked hosted run after restart and resumes from local runtime state', async () => {
    const projectDir = path.join(homeDir, 'hosted-restart-approval-workspace');
    await fs.mkdir(projectDir, { recursive: true });
    const requests: RuntimeRequest[] = [];
    const serverOptions: RuntimeServerOptions = {
      reclaimSameHostedAssignment: true,
      runtimeCommandsAfterBlockedSync: false,
      hostedAssignment: {
        yaml_snapshot: `
schema: viewport.workflow/v1
name: hosted-worker-restart-approval-proof
nodes:
  gate:
    type: gate
    gate:
      type: human_review
      prompt: Approve after worker restart.
  proof:
    type: shell
    needs: [gate]
    argv:
      - printf
      - restart-resumed
`,
        source_ref: 'viewport://test/hosted-worker-restart-approval-proof',
        directory_path: projectDir,
      },
    };
    server = await startRuntimeServer(requests, serverOptions);
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
    const first = await import('../../src/cli/worker-command.js');

    await first.worker();

    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? ''))).toMatchObject({
      claimed: 1,
      completed: 0,
      blocked: 1,
      failed: 0,
      cleanup: 1,
    });
    const firstBlockedSync = requests.find(
      (request) =>
        request.method === 'PATCH' &&
        request.url ===
          '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync' &&
        request.body['status'] === 'blocked',
    );
    expect(firstBlockedSync?.body).toMatchObject({
      status: 'blocked',
      runtime_run_id: expect.any(String),
      nodes: expect.arrayContaining([
        expect.objectContaining({ node_key: 'gate', status: 'blocked' }),
      ]),
    });
    expect(String(firstBlockedSync?.body['runtime_run_id'] ?? '')).not.toHaveLength(0);

    serverOptions.runtimeCommandsAfterBlockedSync = true;
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
    const second = await import('../../src/cli/worker-command.js');

    await second.worker();

    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? ''))).toMatchObject({
      claimed: 1,
      completed: 1,
      blocked: 0,
      failed: 0,
      cleanup: 1,
    });
    const claimBodies = requests
      .filter(
        (request) =>
          request.method === 'POST' &&
          request.url === '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim',
      )
      .map((request) => request.body);
    expect(claimBodies).toHaveLength(2);
    const completedSync = requests.find(
      (request) =>
        request.method === 'PATCH' &&
        request.url ===
          '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync' &&
        request.body['status'] === 'completed',
    );
    expect(completedSync?.body).toMatchObject({
      status: 'completed',
      runtime_run_id: firstBlockedSync?.body['runtime_run_id'],
      output_snapshot: expect.objectContaining({
        nodes: expect.objectContaining({
          gate: expect.objectContaining({ status: 'completed', output: 'Approved in test' }),
          proof: expect.objectContaining({ status: 'completed', output: 'restart-resumed' }),
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

  it('denies inbound transport by default before control-plane contact', async () => {
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

    await expect(worker()).rejects.toThrow('Inbound worker transport is disabled by default');
  });

  it('keeps inbound gated when the experimental flag lacks signed request proof', async () => {
    await writeWorkerProfile('http://127.0.0.1:1');
    process.env['VPD_WORKER_INBOUND_EXPERIMENTAL'] = '1';
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

    await expect(worker()).rejects.toThrow(
      'Inbound worker transport is gated: missing signed inbound requests, replay protection, control-plane claim verification.',
    );
  });

  it('keeps inbound gated after threat flags until a signed listener exists', async () => {
    await writeWorkerProfile('http://127.0.0.1:1');
    const { ConfigManager } = await import('../../src/core/config.js');
    const manager = new ConfigManager();
    await manager.load();
    const existing = manager.getDaemonConfig() ?? {};
    await manager.setDaemonConfig({
      ...existing,
      worker: {
        ...existing.worker,
        inbound: {
          enabled: true,
          signedRequests: true,
          replayProtection: true,
          controlPlaneClaimVerify: true,
        },
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
      'inbound',
      '--once',
    ];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');

    await expect(worker()).rejects.toThrow('Inbound worker transport listener is not implemented');
  });

  it('routes hosted managed executor requests through relay worker transport', async () => {
    const requests: RuntimeRequest[] = [];
    const relayFrames: Array<Record<string, unknown>> = [];
    server = await startRuntimeServer(requests);
    const relayServer = http.createServer();
    const wss = new WebSocketServer({ server: relayServer });
    await new Promise<void>((resolve, reject) => {
      relayServer.once('error', reject);
      relayServer.listen(0, '127.0.0.1', () => {
        relayServer.off('error', reject);
        resolve();
      });
    });
    const relayAddress = relayServer.address();
    if (!relayAddress || typeof relayAddress === 'string') {
      throw new Error('Missing relay test server address.');
    }
    process.env['VIEWPORT_RELAY_WS_BASE_URL'] = `ws://127.0.0.1:${relayAddress.port}/ws`;
    wss.on('connection', (ws, request) => {
      expect(request.url).toContain('role=worker');
      expect(request.url).toContain('workspaceId=workspace_1');
      expect(request.headers.authorization).toBe('Bearer relay_worker_token');
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        relayFrames.push(frame);
        const path = String(frame['path']);
        const requestId = String(frame['requestId']);
        const status =
          path.endsWith('/claim') || path.includes('/workflow-runs/run_1/sync') ? 200 : 200;
        const body = path.endsWith('/claim')
          ? JSON.stringify({
              data: {
                id: 'run_1',
                assignment_claim_token: 'vpclaim_run_1',
                run_lease: {
                  lease_id: 'workflow_run:run_1',
                  lease_token: 'vplease_run_1',
                  workflow_run_id: 'run_1',
                },
              },
            })
          : JSON.stringify({ ok: true });
        ws.send(
          JSON.stringify({
            type: 'viewport.worker_transport.response/v1',
            requestId,
            status,
            headers: { 'content-type': 'application/json' },
            body,
          }),
        );
      });
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
      'relay',
      '--once',
      '--json',
    ];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');

    try {
      await worker();
    } finally {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await closeServer(relayServer);
    }

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      claimed: number;
      failed: number;
    };
    expect(payload).toMatchObject({ claimed: 1, failed: 1 });
    expect(requests.map((request) => request.url)).toEqual([
      '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/relay-token',
    ]);
    expect(relayFrames.map((frame) => frame['path'])).toEqual([
      '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim',
      '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_1/sync',
      '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
    ]);
    expect(relayFrames[0]?.['headers']).toMatchObject({
      Authorization: 'Bearer vpexec_hosted',
      'X-Viewport-Worker-Fingerprint': expect.any(String),
      'X-Viewport-Worker-Signature': expect.any(String),
    });
  });

  it('treats a relay-routed 204 claim response as no available work', async () => {
    const requests: RuntimeRequest[] = [];
    const relayFrames: Array<Record<string, unknown>> = [];
    server = await startRuntimeServer(requests);
    const relayServer = http.createServer();
    const wss = new WebSocketServer({ server: relayServer });
    await new Promise<void>((resolve, reject) => {
      relayServer.once('error', reject);
      relayServer.listen(0, '127.0.0.1', () => {
        relayServer.off('error', reject);
        resolve();
      });
    });
    const relayAddress = relayServer.address();
    if (!relayAddress || typeof relayAddress === 'string') {
      throw new Error('Missing relay test server address.');
    }
    process.env['VIEWPORT_RELAY_WS_BASE_URL'] = `ws://127.0.0.1:${relayAddress.port}/ws`;
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        relayFrames.push(frame);
        const path = String(frame['path']);
        const requestId = String(frame['requestId']);
        const status = path.endsWith('/claim') ? 204 : 200;
        ws.send(
          JSON.stringify({
            type: 'viewport.worker_transport.response/v1',
            requestId,
            status,
            headers: { 'content-type': 'application/json' },
            body: status === 204 ? '' : JSON.stringify({ ok: true }),
          }),
        );
      });
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
      'relay',
      '--once',
      '--json',
    ];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');

    try {
      await worker();
    } finally {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await closeServer(relayServer);
    }

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '')) as {
      claimed: number;
      completed: number;
      failed: number;
    };
    expect(payload).toMatchObject({ claimed: 0, completed: 0, failed: 0 });
    expect(relayFrames.map((frame) => frame['path'])).toEqual([
      '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim',
      '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
    ]);
  });

  it('denies ephemeral inbound run-once transport before control-plane contact', async () => {
    await writeWorkerProfile('http://127.0.0.1:1');
    process.argv = [
      'node',
      'vpd',
      'worker',
      'run-once',
      '--lease',
      'lease_inbound',
      '--transport',
      'inbound',
    ];
    vi.resetModules();
    const { worker } = await import('../../src/cli/worker-command.js');
    await expect(worker()).rejects.toThrow('Inbound worker transport is disabled by default');
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
    const worker = existing.worker;
    const stateDir = worker?.stateDir ?? path.join(homeDir, 'worker');
    const serverId = 'sha256:server_1';
    const workspaceId = 'workspace_1';
    const managedExecutorId = 'executor_1';
    await manager.setDaemonConfig({
      ...existing,
      worker: {
        ...worker,
        workspaceId,
        managedExecutorId,
        credential: 'vpexec_hosted',
        serverId,
        capabilities: {
          agents: [{ id: 'codex', displayName: 'Codex', tier: 'sdk', available: true }],
        },
      },
    });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'pairing.json'),
      `${JSON.stringify(
        {
          version: 1,
          workspaceId,
          workspaceName: 'Test Workspace',
          managedExecutorId,
          serverUrl,
          serverId,
          pairedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
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
      receivedAtMs: Date.now(),
    });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/runtime/workers/claim') {
      claimCount += 1;
      if (options.claimAlwaysEmpty) {
        response.statusCode = 204;
        response.end();
        return;
      }
      const genericLeasesBeforeEmpty = options.genericLeasesBeforeEmpty ?? 1;
      if (claimCount > genericLeasesBeforeEmpty) {
        response.statusCode = 204;
        response.end();
        return;
      }
      response.end(
        JSON.stringify({ lease: { id: `lease_${claimCount}`, run_id: `run_${claimCount}` } }),
      );
      return;
    }
    if (
      request.url ===
        '/api/runtime/workspaces/workspace_1/managed-executors/executor_1/relay-token' &&
      request.method === 'POST'
    ) {
      response.end(
        JSON.stringify({
          ok: true,
          relayToken: 'relay_worker_token',
          claims: {
            role: 'worker',
            workspaceId: 'workspace_1',
            managedExecutorId: 'executor_1',
            relayWsBaseUrl: process.env['VIEWPORT_RELAY_WS_BASE_URL'],
          },
        }),
      );
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
      if (claimCount > 1 && !options.reclaimSameHostedAssignment) {
        response.statusCode = 204;
        response.end();
        return;
      }
      response.end(
        JSON.stringify({
          data: {
            id: 'run_1',
            assignment_claim_token: 'vpclaim_run_1',
            ...(options.reclaimSameHostedAssignment && blockedRuntimeRunId
              ? { runtime_run_id: blockedRuntimeRunId }
              : {}),
            ...(options.hostedAssignment ?? {}),
            run_lease: {
              lease_id: 'workflow_run:run_1',
              ...(options.omitHostedLeaseToken ? {} : { lease_token: 'vplease_run_1' }),
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
  omitHostedLeaseToken?: boolean;
  transientHostedClaimFailures?: number;
  runtimeCommandsAfterBlockedSync?: boolean;
  runtimeCommandsByBlockedNode?: Record<string, { message: string }>;
  rateLimitOnceForBlockedNode?: string;
  transientHostedSyncFailures?: number;
  reclaimSameHostedAssignment?: boolean;
  genericLeasesBeforeEmpty?: number;
}

interface RuntimeRequest {
  url: string;
  method: string;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
  receivedAtMs: number;
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

function createWorkerIdentity(): {
  publicKey: string;
  privateKey: string;
  publicKeyFingerprint: string;
} {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicKeyDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  return {
    publicKey,
    privateKey,
    publicKeyFingerprint: crypto.createHash('sha256').update(publicKeyDer).digest('hex'),
  };
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
  const serverId =
    typeof headers['x-viewport-server-id'] === 'string'
      ? headers['x-viewport-server-id']
      : undefined;
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(timestamp).toContain('T');
  expect(nonce).toMatch(/^[a-f0-9]{32}$/);
  const signedBody = request!.method === 'GET' ? '' : JSON.stringify(request!.body);
  expect(bodySha256).toBe(crypto.createHash('sha256').update(signedBody).digest('hex'));
  const identity = JSON.parse(
    await fs.readFile(path.join(homeDir, 'worker', 'identity.json'), 'utf8'),
  ) as { publicKey: string };
  const config = JSON.parse(await fs.readFile(path.join(homeDir, 'config.json'), 'utf8')) as {
    daemon?: { worker?: { serverId?: string } };
  };
  const expectedServerId = config.daemon?.worker?.serverId;
  if (expectedServerId) {
    expect(serverId).toBe(expectedServerId);
  } else {
    expect(serverId).toBeUndefined();
  }
  const canonical = [
    request!.method,
    request!.url,
    bodySha256,
    nonce,
    timestamp,
    ...(expectedServerId ? [expectedServerId] : []),
  ].join('\n');
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
