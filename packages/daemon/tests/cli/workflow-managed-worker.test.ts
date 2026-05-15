import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunRecord } from '../../src/workflows/types.js';

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
});

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

function blockedLocalRun(): WorkflowRunRecord {
  const now = Date.now();
  return {
    id: 'local_run_2',
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
        runId: 'local_run_2',
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
