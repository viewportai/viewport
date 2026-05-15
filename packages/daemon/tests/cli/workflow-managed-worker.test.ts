import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunRecord } from '../../src/workflows/types.js';

const exec = promisify(execFile);

describe('workflow managed worker CLI', () => {
  const originalArgv = process.argv.slice();
  const originalFetch = global.fetch;
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    vi.resetModules();
    logSpy.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    global.fetch = originalFetch;
    vi.doUnmock('../../src/cli/daemon-client.js');
  });

  it('claims a managed assignment, runs it locally, and syncs evidence back', async () => {
    process.argv = [
      'node',
      'vpd',
      'workflow',
      'worker',
      '--server',
      'https://api.getviewport.com',
      '--workspace',
      'workspace_1',
      '--executor',
      'executor_1',
      '--credential',
      'vpexec_secret',
      '--workdir',
      '/repo',
      '--agents',
      'codex',
      '--models',
      'gpt-5.5',
      '--agent-command',
      'cat',
      '--once',
      '--json',
    ];

    const platformRequests: Array<{ url: string; method?: string; body?: unknown }> = [];
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      platformRequests.push({ url, method: init?.method, body });

      if (url.endsWith('/heartbeat')) {
        expect(body).toMatchObject({
          status: 'online',
          capabilities: { tools: ['shell'], agents: ['codex'], models: ['gpt-5.5'] },
        });
        return jsonResponse({ data: { id: 'executor_1' } });
      }
      if (url.endsWith('/claim')) {
        return jsonResponse({
          data: {
            id: 'run_platform_1',
            assignment_claim_token: 'vpclaim_run_platform_1',
            yaml_snapshot: 'schema: viewport.workflow/v1\nname: proof\nnodes: {}\n',
            source_ref: 'viewport://workflow/proof',
            directory_path: '/repo',
            input_snapshot: { issue: 'PAY-1842' },
          },
        });
      }
      if (url.endsWith('/workflow-runs/run_platform_1/sync')) {
        expect(headerValue(init?.headers, 'X-Viewport-Assignment-Claim')).toBe(
          'vpclaim_run_platform_1',
        );
        expect(body).toMatchObject({
          runtime_run_id: 'local_run_1',
          status: 'completed',
          nodes: [expect.objectContaining({ node_key: 'tests', status: 'completed' })],
          events: [expect.objectContaining({ type: 'run-completed' })],
        });
        return jsonResponse({ data: { id: 'run_platform_1', status: 'completed' } });
      }

      return jsonResponse({ message: 'not found' }, 404);
    }) as typeof fetch;

    const daemonFetch = vi.fn(async (urlPath: string, init?: RequestInit) => {
      if (urlPath === '/api/directories' && (!init?.method || init.method === 'GET')) {
        return jsonResponse([]);
      }
      if (urlPath === '/api/directories' && init?.method === 'POST') {
        return jsonResponse({ id: 'dir_1' });
      }
      if (urlPath === '/api/workflows/runs' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
          workflowYaml: expect.stringContaining('name: proof'),
          directoryId: 'dir_1',
          resourceId: 'workspace_1',
          platformRunId: 'run_platform_1',
        });
        return jsonResponse({ run: { id: 'local_run_1' } });
      }
      if (urlPath === '/api/workflows/runs/local_run_1') {
        return jsonResponse({ run: completedLocalRun() });
      }
      return jsonResponse({ message: `unexpected ${urlPath}` }, 500);
    });

    vi.doMock('../../src/cli/daemon-client.js', () => ({
      isDaemonRunning: vi.fn(async () => true),
      daemonFetch,
    }));

    const { workflow } = await import('../../src/cli/workflow-commands.js');
    await workflow();

    expect(platformRequests.map((request) => request.url)).toEqual([
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_platform_1/sync',
    ]);
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? '')).toContain('"claimed": 1');
  });

  it('waits for platform approval, approves the local gate, and syncs the resumed run', async () => {
    process.argv = [
      'node',
      'vpd',
      'workflow',
      'worker',
      '--server',
      'https://api.getviewport.com',
      '--workspace',
      'workspace_1',
      '--executor',
      'executor_1',
      '--credential',
      'vpexec_secret',
      '--workdir',
      '/repo',
      '--sleep',
      '1',
      '--max-runs',
      '1',
      '--json',
    ];

    const platformSyncStatuses: string[] = [];
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      if (url.endsWith('/heartbeat')) return jsonResponse({ data: { id: 'executor_1' } });
      if (url.endsWith('/claim')) {
        return jsonResponse({
          data: {
            id: 'run_platform_2',
            assignment_claim_token: 'vpclaim_run_platform_2',
            yaml_snapshot: 'schema: viewport.workflow/v1\nname: gated\nnodes: {}\n',
            directory_path: '/repo',
          },
        });
      }
      if (url.endsWith('/workflow-runs/run_platform_2') && init?.method === 'GET') {
        expect(headerValue(init?.headers, 'X-Viewport-Assignment-Claim')).toBe(
          'vpclaim_run_platform_2',
        );
        return jsonResponse({
          data: {
            id: 'run_platform_2',
            status: 'running',
            nodes: [
              {
                node_key: 'approve',
                type: 'approval',
                status: 'completed',
                output: 'Approved',
                metadata: {
                  approval: {
                    message: 'Ship it',
                    actor: { name: 'Mehr', source: 'viewport-web' },
                  },
                },
              },
            ],
          },
        });
      }
      if (url.endsWith('/workflow-runs/run_platform_2/sync')) {
        expect(headerValue(init?.headers, 'X-Viewport-Assignment-Claim')).toBe(
          'vpclaim_run_platform_2',
        );
        platformSyncStatuses.push(String(body.status));
        return jsonResponse({ data: { id: 'run_platform_2', status: body.status } });
      }

      return jsonResponse({ message: 'not found' }, 404);
    }) as typeof fetch;

    let localApproved = false;
    const daemonFetch = vi.fn(async (urlPath: string, init?: RequestInit) => {
      if (urlPath === '/api/directories' && (!init?.method || init.method === 'GET')) {
        return jsonResponse([{ id: 'dir_1', path: '/repo' }]);
      }
      if (urlPath === '/api/workflows/runs' && init?.method === 'POST') {
        return jsonResponse({ run: { id: 'local_run_2' } });
      }
      if (urlPath === '/api/workflows/runs/local_run_2') {
        return jsonResponse({
          run: localApproved ? completedLocalRun({ id: 'local_run_2' }) : blockedLocalRun(),
        });
      }
      if (urlPath === '/api/workflows/runs/local_run_2/approvals/approve') {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          approved: true,
          message: 'Ship it',
          actor: { name: 'Mehr', source: 'viewport-web' },
        });
        localApproved = true;
        return jsonResponse({ run: completedLocalRun({ id: 'local_run_2' }) });
      }
      return jsonResponse({ message: `unexpected ${urlPath}` }, 500);
    });

    vi.doMock('../../src/cli/daemon-client.js', () => ({
      isDaemonRunning: vi.fn(async () => true),
      daemonFetch,
    }));

    const { workflow } = await import('../../src/cli/workflow-commands.js');
    await workflow();

    expect(platformSyncStatuses).toEqual(['blocked', 'completed']);
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? '')).toContain('"blocked": 1');
  });

  it('resumes an already-started local run after a blocked assignment is reclaimed', async () => {
    process.argv = [
      'node',
      'vpd',
      'workflow',
      'worker',
      '--server',
      'https://api.getviewport.com',
      '--workspace',
      'workspace_1',
      '--executor',
      'executor_1',
      '--credential',
      'vpexec_secret',
      '--workdir',
      '/repo',
      '--sleep',
      '1',
      '--max-runs',
      '1',
      '--json',
    ];

    const platformSyncStatuses: string[] = [];
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      if (url.endsWith('/heartbeat')) return jsonResponse({ data: { id: 'executor_1' } });
      if (url.endsWith('/claim')) {
        return jsonResponse({
          data: {
            id: 'run_platform_reclaimed',
            assignment_claim_token: 'vpclaim_reclaimed',
            yaml_snapshot: 'schema: viewport.workflow/v1\nname: reclaimed\nnodes: {}\n',
            directory_path: '/repo',
            runtime_run_id: 'local_run_reclaimed',
            status: 'running',
            nodes: [
              {
                node_key: 'approve',
                type: 'approval',
                status: 'blocked',
              },
            ],
          },
        });
      }
      if (url.endsWith('/workflow-runs/run_platform_reclaimed') && init?.method === 'GET') {
        expect(headerValue(init?.headers, 'X-Viewport-Assignment-Claim')).toBe('vpclaim_reclaimed');
        return jsonResponse({
          data: {
            id: 'run_platform_reclaimed',
            status: 'running',
            nodes: [
              {
                node_key: 'approve',
                type: 'approval',
                status: 'completed',
                output: 'Approved',
                metadata: {
                  approval: {
                    message: 'Resume after restart',
                    actor: { name: 'Alice', source: 'viewport-web' },
                  },
                },
              },
            ],
          },
        });
      }
      if (url.endsWith('/workflow-runs/run_platform_reclaimed/sync')) {
        expect(headerValue(init?.headers, 'X-Viewport-Assignment-Claim')).toBe('vpclaim_reclaimed');
        platformSyncStatuses.push(String(body.status));
        return jsonResponse({ data: { id: 'run_platform_reclaimed', status: body.status } });
      }

      return jsonResponse({ message: 'not found' }, 404);
    }) as typeof fetch;

    let localApproved = false;
    const daemonFetch = vi.fn(async (urlPath: string, init?: RequestInit) => {
      if (urlPath === '/api/workflows/runs/local_run_reclaimed' && init?.method === 'GET') {
        return jsonResponse({
          run: localApproved
            ? completedLocalRun({ id: 'local_run_reclaimed' })
            : blockedLocalRun('local_run_reclaimed'),
        });
      }
      if (urlPath === '/api/workflows/runs/local_run_reclaimed/approvals/approve') {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          approved: true,
          message: 'Resume after restart',
          actor: { name: 'Alice', source: 'viewport-web' },
        });
        localApproved = true;
        return jsonResponse({ run: completedLocalRun({ id: 'local_run_reclaimed' }) });
      }
      if (urlPath === '/api/workflows/runs' && init?.method === 'POST') {
        throw new Error(
          'Reclaimed assignments must resume the existing local run, not start over.',
        );
      }
      return jsonResponse({ message: `unexpected ${urlPath}` }, 500);
    });

    vi.doMock('../../src/cli/daemon-client.js', () => ({
      isDaemonRunning: vi.fn(async () => true),
      daemonFetch,
    }));

    const { workflow } = await import('../../src/cli/workflow-commands.js');
    await workflow();

    expect(platformSyncStatuses).toEqual(['blocked', 'completed']);
    expect(daemonFetch).not.toHaveBeenCalledWith('/api/workflows/runs', expect.anything());
  });

  it('syncs running progress before a long local run completes so the platform lease can renew', async () => {
    process.argv = [
      'node',
      'vpd',
      'workflow',
      'worker',
      '--server',
      'https://api.getviewport.com',
      '--workspace',
      'workspace_1',
      '--executor',
      'executor_1',
      '--credential',
      'vpexec_secret',
      '--workdir',
      '/repo',
      '--lease',
      '2',
      '--once',
      '--json',
    ];

    const platformSyncStatuses: string[] = [];
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      if (url.endsWith('/heartbeat')) return jsonResponse({ data: { id: 'executor_1' } });
      if (url.endsWith('/claim')) {
        return jsonResponse({
          data: {
            id: 'run_platform_3',
            assignment_claim_token: 'vpclaim_run_platform_3',
            yaml_snapshot: 'schema: viewport.workflow/v1\nname: long-running\nnodes: {}\n',
            directory_path: '/repo',
          },
        });
      }
      if (url.endsWith('/workflow-runs/run_platform_3/sync')) {
        expect(headerValue(init?.headers, 'X-Viewport-Assignment-Claim')).toBe(
          'vpclaim_run_platform_3',
        );
        platformSyncStatuses.push(String(body.status));
        return jsonResponse({ data: { id: 'run_platform_3', status: body.status } });
      }

      return jsonResponse({ message: 'not found' }, 404);
    }) as typeof fetch;

    let pollCount = 0;
    const daemonFetch = vi.fn(async (urlPath: string, init?: RequestInit) => {
      if (urlPath === '/api/directories' && (!init?.method || init.method === 'GET')) {
        return jsonResponse([{ id: 'dir_1', path: '/repo' }]);
      }
      if (urlPath === '/api/workflows/runs' && init?.method === 'POST') {
        return jsonResponse({ run: { id: 'local_run_3' } });
      }
      if (urlPath === '/api/workflows/runs/local_run_3') {
        pollCount += 1;
        return jsonResponse({
          run:
            pollCount === 1
              ? runningLocalRun({ id: 'local_run_3' })
              : completedLocalRun({ id: 'local_run_3' }),
        });
      }
      return jsonResponse({ message: `unexpected ${urlPath}` }, 500);
    });

    vi.doMock('../../src/cli/daemon-client.js', () => ({
      isDaemonRunning: vi.fn(async () => true),
      daemonFetch,
    }));

    const { workflow } = await import('../../src/cli/workflow-commands.js');
    await workflow();

    expect(platformSyncStatuses).toEqual(['running', 'completed']);
  });

  it('runs through real CLI HTTP boundaries against platform and daemon endpoints', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-worker-process-'));
    const goldenYaml = await goldenWorkflowYaml();
    const platformRequests: Array<{ path: string; method: string; body: unknown; claim?: string }> =
      [];
    const daemonRequests: Array<{ path: string; method: string; body: unknown }> = [];
    const platform = await listen(
      http.createServer(async (req, res) => {
        const body = await readRequestJson(req);
        const claim = req.headers['x-viewport-assignment-claim'];
        platformRequests.push({
          path: req.url ?? '',
          method: req.method ?? 'GET',
          body,
          claim: Array.isArray(claim) ? claim[0] : claim,
        });

        if (req.url?.endsWith('/heartbeat')) {
          writeJson(res, { data: { id: 'executor_process' } });
          return;
        }
        if (req.url?.endsWith('/claim')) {
          expect(req.headers.authorization).toBe('Bearer vpexec_process');
          writeJson(res, {
            data: {
              id: 'run_platform_process',
              assignment_claim_token: 'vpclaim_process',
              yaml_snapshot: goldenYaml,
              source_ref: 'viewport://workflow/payments/jira-autofix',
              directory_path: tempHome,
              input_snapshot: {
                integration_event: {
                  provider: 'jira',
                  payload: { key: 'PAY-1842', summary: 'Checkout fails for lowercase codes' },
                },
              },
            },
          });
          return;
        }
        if (req.url?.endsWith('/workflow-runs/run_platform_process/sync')) {
          expect(claim).toBe('vpclaim_process');
          expect(body).toMatchObject({
            runtime_run_id: 'local_run_process',
            status: 'completed',
            nodes: expect.arrayContaining([
              expect.objectContaining({
                node_key: 'tests',
                title: 'Tests passing',
                status: 'completed',
              }),
              expect.objectContaining({
                node_key: 'open_pr',
                title: 'Open PR',
                status: 'completed',
                metadata: expect.objectContaining({
                  action: expect.objectContaining({
                    adapter: 'github',
                    action: 'pull_request.create',
                    policyReason:
                      'Payment code changes require a human reviewer before a PR is opened.',
                    digest: expect.stringMatching(/^sha256:/),
                    idempotencyKey: 'pr:PAY-1842',
                  }),
                }),
              }),
              expect.objectContaining({
                node_key: 'update_jira',
                title: 'Jira side effects',
                status: 'completed',
                metadata: expect.objectContaining({
                  action: expect.objectContaining({
                    adapter: 'jira',
                    action: 'issue.transition',
                    digest: expect.stringMatching(/^sha256:/),
                    idempotencyKey: 'jira:PAY-1842',
                  }),
                }),
              }),
            ]),
            events: expect.arrayContaining([
              expect.objectContaining({ type: 'action-executed', node_key: 'open_pr' }),
              expect.objectContaining({ type: 'action-executed', node_key: 'update_jira' }),
              expect.objectContaining({ type: 'run-completed' }),
            ]),
          });
          writeJson(res, { data: { id: 'run_platform_process', status: 'completed' } });
          return;
        }
        writeJson(res, { message: 'not found' }, 404);
      }),
    );

    const daemon = await listen(
      http.createServer(async (req, res) => {
        const body = await readRequestJson(req);
        daemonRequests.push({ path: req.url ?? '', method: req.method ?? 'GET', body });

        if (req.url === '/health') {
          writeJson(res, { ok: true });
          return;
        }
        if (req.url === '/api/directories' && req.method === 'GET') {
          writeJson(res, []);
          return;
        }
        if (req.url === '/api/directories' && req.method === 'POST') {
          expect(body).toMatchObject({ path: tempHome });
          writeJson(res, { id: 'dir_process' });
          return;
        }
        if (req.url === '/api/workflows/runs' && req.method === 'POST') {
          expect(body).toMatchObject({
            workflowYaml: goldenYaml,
            directoryId: 'dir_process',
            resourceId: 'workspace_process',
            platformRunId: 'run_platform_process',
          });
          writeJson(res, { run: { id: 'local_run_process' } });
          return;
        }
        if (req.url === '/api/workflows/runs/local_run_process' && req.method === 'GET') {
          writeJson(res, {
            run: completedGoldenLocalRun({
              id: 'local_run_process',
              yamlSnapshot: goldenYaml,
              directoryId: 'dir_process',
              directoryPath: tempHome,
            }),
          });
          return;
        }
        writeJson(res, { message: 'not found' }, 404);
      }),
    );

    try {
      const result = await exec(
        tsxBin(),
        [
          'src/index.ts',
          'workflow',
          'worker',
          '--server',
          `http://127.0.0.1:${platform.port}`,
          '--workspace',
          'workspace_process',
          '--executor',
          'executor_process',
          '--credential',
          'vpexec_process',
          '--workdir',
          tempHome,
          '--listen',
          `127.0.0.1:${daemon.port}`,
          '--once',
          '--json',
        ],
        {
          cwd: packageRoot(),
          env: {
            ...process.env,
            VIEWPORT_HOME: tempHome,
            VPD_HOME: tempHome,
            VPD_PROFILE: '',
            VIEWPORT_PROFILE: '',
            NO_COLOR: '1',
            FORCE_COLOR: '0',
          },
          timeout: 20_000,
          maxBuffer: 1024 * 1024 * 4,
        },
      );
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: 'workflow worker',
        ok: true,
        stats: { claimed: 1, completed: 1, blocked: 0, failed: 0 },
      });
      expect(platformRequests.map((request) => request.path)).toEqual([
        '/api/runtime/workspaces/workspace_process/managed-executors/executor_process/heartbeat',
        '/api/runtime/workspaces/workspace_process/managed-executors/executor_process/claim',
        '/api/runtime/workspaces/workspace_process/managed-executors/executor_process/heartbeat',
        '/api/runtime/workspaces/workspace_process/managed-executors/executor_process/workflow-runs/run_platform_process/sync',
      ]);
      expect(daemonRequests.map((request) => request.path)).toEqual([
        '/health',
        '/api/directories',
        '/api/directories',
        '/api/workflows/runs',
        '/api/workflows/runs/local_run_process',
      ]);
    } finally {
      await Promise.all([
        closeServer(platform.server),
        closeServer(daemon.server),
        fs.rm(tempHome, { recursive: true, force: true }),
      ]);
    }
  });
});

async function goldenWorkflowYaml(): Promise<string> {
  return fs.readFile(
    path.join(packageRoot(), 'tests', 'fixtures', 'workflows', 'jira-autofix-golden.yaml'),
    'utf8',
  );
}

function completedLocalRun(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  const now = Date.now();
  return {
    id: 'local_run_1',
    workflowName: 'proof',
    sourceType: 'viewport_snapshot',
    sourcePath: 'viewport://workflow/proof',
    digest: 'sha256:proof',
    schema: 'viewport.workflow/v1',
    yamlSnapshot: 'schema: viewport.workflow/v1\nname: proof\nnodes: {}\n',
    directoryId: 'dir_1',
    directoryPath: '/repo',
    machineId: 'machine_1',
    initiation: 'cli',
    status: 'completed',
    inputs: { issue: 'PAY-1842' },
    preflight: { ok: true, issues: [] },
    nodes: {
      tests: {
        id: 'tests',
        type: 'shell',
        status: 'completed',
        output: 'ok',
        startedAt: now - 1000,
        completedAt: now,
      },
    },
    artifacts: [],
    events: [
      {
        id: 'evt_1',
        runId: 'local_run_1',
        timestamp: now,
        type: 'run-completed',
        message: 'Workflow run completed',
      },
    ],
    createdAt: now - 2000,
    startedAt: now - 1000,
    updatedAt: now,
    completedAt: now,
    ...overrides,
  };
}

function completedGoldenLocalRun(
  overrides: Partial<WorkflowRunRecord> & { yamlSnapshot: string },
): WorkflowRunRecord {
  const now = Date.now();
  return {
    id: 'local_run_process',
    workflowName: 'payments/jira-autofix',
    sourceType: 'viewport_snapshot',
    sourcePath: 'viewport://workflow/payments/jira-autofix',
    digest: 'sha256:payments-jira-autofix',
    schema: 'viewport.workflow/v1',
    yamlSnapshot: overrides.yamlSnapshot,
    directoryId: 'dir_process',
    directoryPath: '/repo',
    machineId: 'machine_1',
    initiation: 'cli',
    status: 'completed',
    inputs: {
      integration_event: {
        provider: 'jira',
        payload: { key: 'PAY-1842', summary: 'Checkout fails for lowercase codes' },
      },
    },
    preflight: { ok: true, issues: [] },
    nodes: {
      gather_context: {
        id: 'gather_context',
        title: 'Context attached',
        type: 'context',
        status: 'completed',
        output: 'Payment guardrails attached.',
        startedAt: now - 9000,
        completedAt: now - 8000,
      },
      investigate: {
        id: 'investigate',
        title: 'Codex investigates bug',
        type: 'agent',
        status: 'completed',
        output: 'Found lowercase discount code normalization bug.',
        startedAt: now - 8000,
        completedAt: now - 5000,
      },
      tests: {
        id: 'tests',
        title: 'Tests passing',
        type: 'shell',
        status: 'completed',
        output: 'tests-pass',
        startedAt: now - 5000,
        completedAt: now - 4000,
      },
      open_pr: {
        id: 'open_pr',
        title: 'Open PR',
        type: 'action',
        status: 'completed',
        output: 'github.pull_request.create',
        metadata: {
          action: {
            adapter: 'github',
            action: 'pull_request.create',
            state: 'executed',
            idempotencyKey: 'pr:PAY-1842',
            policyReason: 'Payment code changes require a human reviewer before a PR is opened.',
            digest: 'sha256:golden-open-pr',
            input: {
              title: 'Fix PAY-1842',
              body: 'Generated by Viewport workflow.',
            },
            response: {
              status: 201,
              ok: true,
              body: { html_url: 'https://github.com/acme/payments/pull/4821' },
            },
          },
        },
        startedAt: now - 4000,
        completedAt: now - 3000,
      },
      update_jira: {
        id: 'update_jira',
        title: 'Jira side effects',
        type: 'action',
        status: 'completed',
        output: 'jira.issue.transition',
        metadata: {
          action: {
            adapter: 'jira',
            action: 'issue.transition',
            state: 'executed',
            idempotencyKey: 'jira:PAY-1842',
            digest: 'sha256:golden-update-jira',
            input: {
              issue: 'PAY-1842',
              status: 'In Review',
            },
            response: {
              status: 204,
              ok: true,
            },
          },
        },
        startedAt: now - 3000,
        completedAt: now - 2000,
      },
    },
    artifacts: [],
    events: [
      {
        id: 'evt_open_pr',
        runId: 'local_run_process',
        timestamp: now - 3000,
        type: 'action-executed',
        message: 'Action node open_pr executed github.pull_request.create',
        nodeId: 'open_pr',
      },
      {
        id: 'evt_update_jira',
        runId: 'local_run_process',
        timestamp: now - 2000,
        type: 'action-executed',
        message: 'Action node update_jira executed jira.issue.transition',
        nodeId: 'update_jira',
      },
      {
        id: 'evt_completed',
        runId: 'local_run_process',
        timestamp: now,
        type: 'run-completed',
        message: 'Workflow run completed',
      },
    ],
    createdAt: now - 10_000,
    startedAt: now - 9000,
    updatedAt: now,
    completedAt: now,
    ...overrides,
  };
}

function blockedLocalRun(id = 'local_run_2'): WorkflowRunRecord {
  const now = Date.now();
  return {
    id,
    workflowName: 'gated',
    sourceType: 'viewport_snapshot',
    sourcePath: 'viewport://workflow/gated',
    digest: 'sha256:gated',
    schema: 'viewport.workflow/v1',
    yamlSnapshot: 'schema: viewport.workflow/v1\nname: gated\nnodes: {}\n',
    directoryId: 'dir_1',
    directoryPath: '/repo',
    machineId: 'machine_1',
    initiation: 'cli',
    status: 'blocked',
    inputs: {},
    preflight: { ok: true, issues: [] },
    nodes: {
      approve: {
        id: 'approve',
        type: 'approval',
        status: 'blocked',
        approval: {
          prompt: 'Approve side effects',
          requestedAt: now,
        },
      },
    },
    artifacts: [],
    events: [
      {
        id: 'evt_blocked',
        runId: id,
        timestamp: now,
        type: 'approval-requested',
        message: 'Approval requested',
        nodeId: 'approve',
      },
    ],
    createdAt: now - 2000,
    startedAt: now - 1000,
    updatedAt: now,
  };
}

function runningLocalRun(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  const now = Date.now();
  return {
    id: 'local_run_3',
    workflowName: 'long-running',
    sourceType: 'viewport_snapshot',
    sourcePath: 'viewport://workflow/long-running',
    digest: 'sha256:long-running',
    schema: 'viewport.workflow/v1',
    yamlSnapshot: 'schema: viewport.workflow/v1\nname: long-running\nnodes: {}\n',
    directoryId: 'dir_1',
    directoryPath: '/repo',
    machineId: 'machine_1',
    initiation: 'cli',
    status: 'running',
    inputs: {},
    preflight: { ok: true, issues: [] },
    nodes: {
      inspect: {
        id: 'inspect',
        type: 'shell',
        status: 'running',
        output: 'still working',
        startedAt: now - 1000,
      },
    },
    artifacts: [],
    events: [
      {
        id: 'evt_running',
        runId: 'local_run_3',
        timestamp: now,
        type: 'node-started',
        message: 'Inspect started',
        nodeId: 'inspect',
      },
    ],
    createdAt: now - 2000,
    startedAt: now - 1000,
    updatedAt: now,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1];
  }
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

async function readRequestJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : undefined;
}

function writeJson(res: http.ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function listen(server: http.Server): Promise<{ server: http.Server; port: number }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind to a TCP port.');
  }
  return { server, port: address.port };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function packageRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
}

function tsxBin(): string {
  return path.resolve(
    packageRoot(),
    '..',
    '..',
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );
}
