import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunRecord } from '../../src/workflows/types.js';
import { localRunToSyncPayload } from '../../src/cli/workflow-managed-worker-format.js';

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
          capabilities: { tools: ['shell'], agents: ['codex'], models: ['gpt-5.5'] },
          access_mode: 'relay',
          runner_posture: { transport: { mode: 'relay' } },
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
            schema_versions: { route: 'viewport.route/v1' },
            route_snapshot: { key: 'payments-bugs' },
            execution_profile_snapshot: { key: 'payments-prod' },
            runner_workspace_snapshot: { runner_pool: 'payments-vps' },
            context_receipts_snapshot: [
              {
                schema: 'viewport.context_receipt/v1',
                package: 'payments.domain-rules',
                requested: 'context://vault/payments',
                resolvedVersion: '1.0.0',
                provider: 'viewport-vault',
                digest: 'sha256:payments-domain-rules',
                freshness: 'resolved_at_run',
                usedBy: { runId: 'run_platform_1' },
                resolvedAt: '2026-05-17T10:00:00.000Z',
              },
            ],
            data_capture_policy: { transcripts: 'none', logs: 'metadata', artifacts: 'metadata' },
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
          evidence_packets: [
            expect.objectContaining({
              evidence_key: 'node:tests:output',
              node_key: 'tests',
              kind: 'command_output',
              summary: 'ok',
            }),
          ],
        });
        return jsonResponse({ data: { id: 'run_platform_1', status: 'completed' } });
      }

      return jsonResponse({ message: 'not found' }, 404);
    }) as typeof fetch;

    const daemonFetch = vi.fn(async (urlPath: string, init?: RequestInit) => {
      if (urlPath === '/api/agents') {
        return jsonResponse({ agents: [{ id: 'codex', available: true }] });
      }
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
          dataCapturePolicy: { transcripts: 'none', logs: 'metadata', artifacts: 'metadata' },
          inputs: {
            issue: 'PAY-1842',
            viewport: {
              platformRunId: 'run_platform_1',
              schemaVersions: { route: 'viewport.route/v1' },
              route: { key: 'payments-bugs' },
              executionProfile: { key: 'payments-prod' },
              runnerWorkspace: { runner_pool: 'payments-vps' },
              contextReceipts: [
                expect.objectContaining({
                  schema: 'viewport.context_receipt/v1',
                  package: 'payments.domain-rules',
                  resolvedVersion: '1.0.0',
                  usedBy: { runId: 'run_platform_1' },
                }),
              ],
            },
          },
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
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
    ]);
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? '')).toContain('"claimed": 1');
  });

  it('materializes selected repo and API credentials into transient daemon env only', async () => {
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
      '--once',
      '--json',
    ];

    const platformRequests: Array<{ url: string; method?: string; body?: unknown }> = [];
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      platformRequests.push({ url, method: init?.method, body });

      if (url.endsWith('/heartbeat')) return jsonResponse({ data: { id: 'executor_1' } });
      if (url.endsWith('/claim')) {
        return jsonResponse({
          data: {
            id: 'run_platform_credential_material',
            assignment_claim_token: 'vpclaim_credential_material',
            yaml_snapshot: `
schema: viewport.workflow/v1
name: proof
nodes:
  tests:
    type: shell
    command: printf ok
`,
            source_ref: 'viewport://workflow/proof',
            directory_path: '/repo',
            execution_profile_snapshot: {
              key: 'payments-prod',
              credentials: {
                repo_checkout: [{ handle: 'repo/github/payments-api' }],
                mcp_api: [{ handle: 'agent/anthropic/claude-code' }],
              },
            },
          },
        });
      }
      if (url.endsWith('/workflow-runs/run_platform_credential_material/credential-material')) {
        expect(headerValue(init?.headers, 'X-Viewport-Assignment-Claim')).toBe(
          'vpclaim_credential_material',
        );
        if (body.handle === 'agent/anthropic/claude-code') {
          return jsonResponse({
            data: {
              handle: 'agent/anthropic/claude-code',
              kind: 'mcp_api_secret',
              storage_posture: 'runner_local',
              provider: 'anthropic',
              material_available: false,
              runner_local_required: true,
            },
          });
        }
        expect(body).toMatchObject({
          credential: 'vpexec_secret',
          handle: 'repo/github/payments-api',
        });
        return jsonResponse({
          data: {
            credential_id: 'cred_repo_1',
            handle: 'repo/github/payments-api',
            kind: 'repo_checkout_secret',
            storage_posture: 'viewport_managed',
            provider: 'github',
            scopes: ['repo:viewportai/vp-example-repo'],
            material_available: true,
            runner_local_required: false,
            secret: 'ghs_run_scoped_checkout',
          },
        });
      }
      if (url.endsWith('/workflow-runs/run_platform_credential_material/sync')) {
        return jsonResponse({
          data: { id: 'run_platform_credential_material', status: 'completed' },
        });
      }

      return jsonResponse({ message: 'not found' }, 404);
    }) as typeof fetch;

    const daemonFetch = vi.fn(async (urlPath: string, init?: RequestInit) => {
      if (urlPath === '/api/agents') return jsonResponse({ agents: [] });
      if (urlPath === '/api/directories' && (!init?.method || init.method === 'GET')) {
        return jsonResponse([]);
      }
      if (urlPath === '/api/directories' && init?.method === 'POST') {
        return jsonResponse({ id: 'dir_1' });
      }
      if (urlPath === '/api/workflows/runs' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body.runtimeSecretEnv).toEqual({
          VIEWPORT_CREDENTIAL_REPO_GITHUB_PAYMENTS_API: 'ghs_run_scoped_checkout',
        });
        expect(JSON.stringify(body.inputs)).not.toContain('ghs_run_scoped_checkout');
        expect(body.inputs.viewport.credentials).toEqual([
          expect.objectContaining({
            handle: 'agent/anthropic/claude-code',
            envName: 'VIEWPORT_CREDENTIAL_AGENT_ANTHROPIC_CLAUDE_CODE',
            materialAvailable: false,
            runnerLocalRequired: true,
          }),
          expect.objectContaining({
            handle: 'repo/github/payments-api',
            envName: 'VIEWPORT_CREDENTIAL_REPO_GITHUB_PAYMENTS_API',
            materialAvailable: true,
            runnerLocalRequired: false,
            scopes: ['repo:viewportai/vp-example-repo'],
          }),
        ]);
        return jsonResponse({ run: { id: 'local_run_credential_material' } });
      }
      if (urlPath === '/api/workflows/runs/local_run_credential_material') {
        return jsonResponse({ run: completedLocalRun({ id: 'local_run_credential_material' }) });
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
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_platform_credential_material/credential-material',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_platform_credential_material/credential-material',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/workflow-runs/run_platform_credential_material/sync',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
    ]);
  });

  it('claims provider action replay work only when an action command is configured', async () => {
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
      '--integrations',
      'github,jira',
      '--action-command',
      actionReplayCommand(),
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
          capabilities: {
            tools: ['shell'],
            integrations: ['github', 'jira'],
            action_replay: ['github', 'jira'],
          },
        });
        return jsonResponse({ data: { id: 'executor_1' } });
      }
      if (url.endsWith('/action-replays/claim')) {
        return jsonResponse({
          data: {
            id: 'replay_1',
            claim_token: 'vpaqr_replay_1',
            workflow_run_id: 'run_platform_1',
            workflow_action_proposal_id: 'proposal_1',
            source_execution_receipt_id: 'receipt_dead_letter_1',
            adapter: 'github',
            action: 'pull_request.create',
            idempotency_key: 'pr:PAY-1842',
            action_digest: 'sha256:approved-pr-payload',
            payload: {
              failure: { reason: 'GitHub returned 502' },
              source_workflow_run_id: 'run_platform_1',
            },
            provider_response: { status: 502 },
          },
        });
      }
      if (url.endsWith('/action-replays/replay_1/complete')) {
        expect(headerValue(init?.headers, 'X-Viewport-Action-Replay-Claim')).toBe('vpaqr_replay_1');
        expect(body).toMatchObject({
          status: 'succeeded',
          provider_reference: 'pr:PAY-1842',
          provider_url: 'https://example.test/pr:PAY-1842',
          idempotency_key: 'pr:PAY-1842',
          payload_digest: 'sha256:approved-pr-payload',
          payload: {
            source_workflow_run_id: 'run_platform_1',
          },
          provider_response: { ok: true, adapter: 'github' },
        });
        return jsonResponse({
          data: {
            id: 'replay_1',
            status: 'completed',
            adapter: 'github',
            action: 'pull_request.create',
          },
        });
      }
      if (url.endsWith('/claim')) {
        return new Response(null, { status: 204 });
      }

      return jsonResponse({ message: 'not found' }, 404);
    }) as typeof fetch;

    vi.doMock('../../src/cli/daemon-client.js', () => ({
      isDaemonRunning: vi.fn(async () => true),
      daemonFetch: vi.fn(async () => jsonResponse({ message: 'unexpected daemon request' }, 500)),
    }));

    const { workflow } = await import('../../src/cli/workflow-commands.js');
    await workflow();

    expect(platformRequests.map((request) => request.url)).toEqual([
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/action-replays/claim',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/action-replays/replay_1/complete',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
    ]);
    const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(output.stats).toMatchObject({
      claimed: 0,
      actionReplaysClaimed: 1,
      actionReplaysCompleted: 1,
      completed: 1,
      failed: 0,
    });
  });

  it('can replay a provider action with the built-in action adapters when explicitly enabled', async () => {
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
      '--integrations',
      'github',
      '--provider-actions',
      '--once',
      '--json',
    ];
    const originalGitHubToken = process.env['GITHUB_TOKEN'];
    const originalCredentialRefToken = process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'];
    delete process.env['GITHUB_TOKEN'];
    process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'] = 'ghs_test';

    const platformRequests: Array<{ url: string; method?: string; body?: unknown }> = [];
    try {
      global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;

        if (url.startsWith('https://api.github.com/')) {
          expect(headerValue(init?.headers, 'Authorization')).toBe('Bearer ghs_test');
          if (url === 'https://api.github.com/repos/acme/payments/pulls') {
            expect(init?.method).toBe('POST');
            expect(headerValue(init?.headers, 'Idempotency-Key')).toBe('pr:PAY-1842');
            expect(body).toMatchObject({
              title: 'Fix PAY-1842',
              head: 'fix/pay-1842',
              base: 'main',
              body: 'Generated by Viewport.',
            });
            return jsonResponse(
              {
                html_url: 'https://github.com/acme/payments/pull/4821',
                url: 'https://api.github.com/repos/acme/payments/pulls/4821',
                number: 4821,
              },
              201,
            );
          }
          expect(url).toBe('https://api.github.com/repos/acme/payments/pulls/4821');
          expect(init?.method).toBe('GET');
          return jsonResponse(
            {
              html_url: 'https://github.com/acme/payments/pull/4821',
              url: 'https://api.github.com/repos/acme/payments/pulls/4821',
              number: 4821,
            },
            200,
          );
        }

        platformRequests.push({ url, method: init?.method, body });
        if (url.endsWith('/heartbeat')) {
          expect(body).toMatchObject({
            capabilities: {
              tools: ['shell'],
              integrations: ['github'],
              action_replay: ['github'],
            },
          });
          return jsonResponse({ data: { id: 'executor_1' } });
        }
        if (url.endsWith('/action-replays/claim')) {
          return jsonResponse({
            data: {
              id: 'replay_builtin',
              claim_token: 'vpaqr_builtin',
              workflow_run_id: 'run_platform_builtin',
              workflow_action_proposal_id: 'proposal_builtin',
              adapter: 'github',
              action: 'pull_request.create',
              idempotency_key: 'pr:PAY-1842',
              action_digest: 'sha256:approved-pr-payload',
              payload: { failure: { reason: 'GitHub returned 502' } },
              action_proposal: {
                id: 'proposal_builtin',
                node_key: 'open_pr',
                adapter: 'github',
                action: 'pull_request.create',
                idempotency_key: 'pr:PAY-1842',
                proposal_digest: 'sha256:approved-pr-payload',
                payload: {
                  owner: 'acme',
                  repo: 'payments',
                  title: 'Fix PAY-1842',
                  head: 'fix/pay-1842',
                  base: 'main',
                  body: 'Generated by Viewport.',
                  credential_ref: 'github/token',
                },
              },
            },
          });
        }
        if (url.endsWith('/action-replays/replay_builtin/complete')) {
          expect(headerValue(init?.headers, 'X-Viewport-Action-Replay-Claim')).toBe(
            'vpaqr_builtin',
          );
          expect(body).toMatchObject({
            status: 'succeeded',
            provider_reference: 'https://github.com/acme/payments/pull/4821',
            provider_url: 'https://github.com/acme/payments/pull/4821',
            idempotency_key: 'pr:PAY-1842',
            payload_digest: 'sha256:approved-pr-payload',
            provider_response: {
              status: 201,
              ok: true,
              htmlUrl: 'https://github.com/acme/payments/pull/4821',
              apiUrl: 'https://api.github.com/repos/acme/payments/pulls/4821',
              number: 4821,
            },
            provider_reconciliation: {
              status: 'verified',
              method: 'read_after_write',
              checkedBy: 'vpd.provider_adapter',
              providerReference: 'https://github.com/acme/payments/pull/4821',
              providerUrl: 'https://github.com/acme/payments/pull/4821',
              targetDigest: expect.stringMatching(/^sha256:/),
              payloadDigest: expect.stringMatching(/^sha256:/),
            },
          });
          return jsonResponse({
            data: {
              id: 'replay_builtin',
              status: 'completed',
              adapter: 'github',
              action: 'pull_request.create',
            },
          });
        }
        if (url.endsWith('/claim')) return new Response(null, { status: 204 });

        return jsonResponse({ message: 'not found' }, 404);
      }) as typeof fetch;

      vi.doMock('../../src/cli/daemon-client.js', () => ({
        isDaemonRunning: vi.fn(async () => true),
        daemonFetch: vi.fn(async () => jsonResponse({ message: 'unexpected daemon request' }, 500)),
      }));

      const { workflow } = await import('../../src/cli/workflow-commands.js');
      await workflow();

      expect(platformRequests.map((request) => request.url)).toEqual([
        'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
        'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim',
        'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/action-replays/claim',
        'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
        'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/action-replays/replay_builtin/complete',
        'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      ]);
    } finally {
      if (originalGitHubToken === undefined) {
        delete process.env['GITHUB_TOKEN'];
      } else {
        process.env['GITHUB_TOKEN'] = originalGitHubToken;
      }
      if (originalCredentialRefToken === undefined) {
        delete process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'];
      } else {
        process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'] = originalCredentialRefToken;
      }
    }
  });

  it('does not claim action replay work without a configured action command', async () => {
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
      '--integrations',
      'github',
      '--once',
      '--json',
    ];

    const platformRequests: string[] = [];
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      platformRequests.push(url);
      if (url.endsWith('/heartbeat')) return jsonResponse({ data: { id: 'executor_1' } });
      if (url.endsWith('/claim')) return new Response(null, { status: 204 });
      if (url.endsWith('/action-replays/claim')) {
        throw new Error('Action replays must not be claimed without an action command.');
      }
      return jsonResponse({ message: 'not found' }, 404);
    }) as typeof fetch;

    vi.doMock('../../src/cli/daemon-client.js', () => ({
      isDaemonRunning: vi.fn(async () => true),
      daemonFetch: vi.fn(async () => jsonResponse({ message: 'unexpected daemon request' }, 500)),
    }));

    const { workflow } = await import('../../src/cli/workflow-commands.js');
    await workflow();

    expect(platformRequests).toEqual([
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/claim',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
    ]);
    const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(output.stats).toMatchObject({
      claimed: 0,
      actionReplaysClaimed: 0,
      actionReplaysCompleted: 0,
    });
  });

  it('completes action replay as failed when the configured action command fails', async () => {
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
      '--integrations',
      'jira',
      '--action-command',
      `${shellQuote(process.execPath)} -e ${JSON.stringify("process.stderr.write('provider down'); process.exit(2)")}`,
      '--once',
      '--json',
    ];

    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      if (url.endsWith('/heartbeat')) return jsonResponse({ data: { id: 'executor_1' } });
      if (url.endsWith('/action-replays/claim')) {
        return jsonResponse({
          data: {
            id: 'replay_failed',
            claim_token: 'vpaqr_failed',
            adapter: 'jira',
            action: 'issue.transition',
            idempotency_key: 'jira:PAY-1842',
            action_digest: 'sha256:jira-payload',
            payload: { failure: { reason: 'Jira timeout' } },
          },
        });
      }
      if (url.endsWith('/action-replays/replay_failed/complete')) {
        expect(headerValue(init?.headers, 'X-Viewport-Action-Replay-Claim')).toBe('vpaqr_failed');
        expect(body).toMatchObject({
          status: 'failed',
          idempotency_key: 'jira:PAY-1842',
          payload_digest: 'sha256:jira-payload',
          provider_response: { stderr: 'provider down', exit_code: 2 },
          error: 'provider down',
        });
        return jsonResponse({ data: { id: 'replay_failed', status: 'failed' } });
      }
      if (url.endsWith('/claim')) return new Response(null, { status: 204 });

      return jsonResponse({ message: 'not found' }, 404);
    }) as typeof fetch;

    vi.doMock('../../src/cli/daemon-client.js', () => ({
      isDaemonRunning: vi.fn(async () => true),
      daemonFetch: vi.fn(async () => jsonResponse({ message: 'unexpected daemon request' }, 500)),
    }));

    const { workflow } = await import('../../src/cli/workflow-commands.js');
    await workflow();

    const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(output.stats).toMatchObject({
      actionReplaysClaimed: 1,
      actionReplaysCompleted: 0,
      failed: 1,
    });
  });

  it('fails before claiming when the advertised agent is unavailable in the daemon', async () => {
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
      '--agent-command',
      'codex',
      '--once',
      '--json',
    ];

    global.fetch = vi.fn(async () => {
      throw new Error('The worker must not claim assignments when the daemon lacks the adapter.');
    }) as typeof fetch;

    const daemonFetch = vi.fn(async (urlPath: string) => {
      if (urlPath === '/api/agents') {
        return jsonResponse({ agents: [{ id: 'claude', available: true }] });
      }
      return jsonResponse({ message: `unexpected ${urlPath}` }, 500);
    });

    vi.doMock('../../src/cli/daemon-client.js', () => ({
      isDaemonRunning: vi.fn(async () => true),
      daemonFetch,
    }));

    const { workflow } = await import('../../src/cli/workflow-commands.js');
    await expect(workflow()).rejects.toThrow('Daemon is missing workflow agent adapter(s): codex');
    expect(daemonFetch).toHaveBeenCalledWith(
      '/api/agents',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('preflights advertised daemon capabilities without claiming work', async () => {
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
      'codex,custom',
      '--integrations',
      'github,jira',
      '--preflight',
      '--json',
    ];

    global.fetch = vi.fn(async () => {
      throw new Error('Preflight must not contact the platform or claim work.');
    }) as typeof fetch;

    const daemonFetch = vi.fn(async (urlPath: string) => {
      if (urlPath === '/api/agents') {
        return jsonResponse({
          agents: [
            { id: 'codex', available: true },
            { id: 'custom', available: true },
          ],
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

    expect(daemonFetch).toHaveBeenCalledWith(
      '/api/agents',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? '')).toContain('"preflight": true');
  });

  it('doctors platform credentials and runner pool without claiming work', async () => {
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
      '--runner-profile',
      'payments-vps',
      '--runner-pool',
      'payments-prod',
      '--agents',
      'codex',
      '--agent-command',
      'cat',
      '--doctor',
      '--json',
    ];

    const platformRequests: Array<{ url: string; method?: string; body?: unknown }> = [];
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      platformRequests.push({ url, method: init?.method, body });

      if (url.endsWith('/heartbeat')) {
        expect(body).toMatchObject({
          access_mode: 'relay',
          runner_profile: 'payments-vps',
          capabilities: {
            runner_pool: 'payments-prod',
            tools: ['shell'],
            agents: ['codex'],
          },
        });
        return jsonResponse({ data: { id: 'executor_1' } });
      }

      return jsonResponse({ message: `unexpected ${url}` }, 500);
    }) as typeof fetch;

    const daemonFetch = vi.fn(async (urlPath: string) => {
      if (urlPath === '/api/agents') {
        return jsonResponse({ agents: [{ id: 'codex', available: true }] });
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
      'https://api.getviewport.com/api/runtime/workspaces/workspace_1/managed-executors/executor_1/heartbeat',
    ]);
    expect(platformRequests.map((request) => request.body)).toEqual([
      expect.objectContaining({ status: 'online', health_status: 'idle' }),
      expect.objectContaining({ status: 'offline', health_status: 'offline' }),
    ]);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      command: 'workflow worker doctor',
      ok: true,
      runnerPool: 'payments-prod',
      capabilities: { runnerPool: 'payments-prod' },
    });
  });

  it('loads managed executor registration profiles for doctor checks', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-runner-profile-'));
    const profilePath = path.join(dir, 'runner.json');
    await fs.writeFile(
      profilePath,
      JSON.stringify({
        schema: 'viewport.managed_executor_registration/v1',
        server_url: 'https://api.getviewport.com',
        workspace_id: 'workspace_profile',
        managed_executor_id: 'executor_profile',
        credential: 'vpexec_profile_secret',
        access_mode: 'polling',
        runner_profile: 'profile-runner',
        runner_posture: {
          transport: {
            mode: 'polling',
            endpoint: 'https://runner.example.com/workflow',
          },
          execution: {
            kind: 'customer-managed',
            isolation: 'customer-boundary',
          },
          version: 'viewport.runner_posture/v1',
        },
        capabilities: {
          runner_pool: 'profile-pool',
          agents: ['codex'],
          models: ['gpt-5.5'],
          integrations: ['github'],
          secrets: ['github/token'],
        },
      }),
    );
    process.argv = [
      'node',
      'vpd',
      'workflow',
      'worker',
      '--registration-profile',
      profilePath,
      '--agent-command',
      'cat',
      '--doctor',
      '--json',
    ];

    const platformRequests: Array<{ url: string; method?: string; body?: unknown }> = [];
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      platformRequests.push({ url, method: init?.method, body });

      if (url.endsWith('/heartbeat')) {
        expect(body).toMatchObject({
          access_mode: 'polling',
          runner_profile: 'profile-runner',
          runner_posture: {
            transport: {
              mode: 'polling',
              endpoint: 'https://runner.example.com/workflow',
            },
            execution: {
              kind: 'customer-managed',
              isolation: 'customer-boundary',
            },
            version: 'viewport.runner_posture/v1',
          },
          capabilities: {
            runner_pool: 'profile-pool',
            tools: ['shell'],
            agents: ['codex'],
            models: ['gpt-5.5'],
            integrations: ['github'],
            secrets: ['github/token'],
          },
        });
        return jsonResponse({ data: { id: 'executor_profile' } });
      }

      return jsonResponse({ message: `unexpected ${url}` }, 500);
    }) as typeof fetch;

    const daemonFetch = vi.fn(async (urlPath: string) => {
      if (urlPath === '/api/agents') {
        return jsonResponse({ agents: [{ id: 'codex', available: true }] });
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
      'https://api.getviewport.com/api/runtime/workspaces/workspace_profile/managed-executors/executor_profile/heartbeat',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_profile/managed-executors/executor_profile/heartbeat',
    ]);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      command: 'workflow worker doctor',
      ok: true,
      accessMode: 'polling',
      runnerProfile: 'profile-runner',
      runnerPool: 'profile-pool',
    });
  });

  it('accepts generated equals-style registration profile flags', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-runner-profile-equals-'));
    const profilePath = path.join(dir, 'runner.json');
    await fs.writeFile(
      profilePath,
      JSON.stringify({
        schema: 'viewport.managed_executor_registration/v1',
        server_url: 'https://api.getviewport.com',
        workspace_id: 'workspace_profile',
        managed_executor_id: 'executor_profile',
        credential: 'vpexec_profile_secret',
        access_mode: 'polling',
        runner_profile: 'profile-runner',
        capabilities: {
          runner_pool: 'profile-pool',
          agents: ['codex'],
        },
      }),
    );
    process.argv = [
      'node',
      'vpd',
      'workflow',
      'worker',
      `--registration-profile=${profilePath}`,
      '--doctor',
      '--json',
    ];

    const platformRequests: Array<{ url: string; method?: string; body?: unknown }> = [];
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      platformRequests.push({ url, method: init?.method, body });

      if (url.endsWith('/heartbeat')) {
        expect(body).toMatchObject({
          access_mode: 'polling',
          runner_profile: 'profile-runner',
          capabilities: {
            runner_pool: 'profile-pool',
            agents: ['codex'],
          },
        });
        return jsonResponse({ data: { id: 'executor_profile' } });
      }

      return jsonResponse({ message: `unexpected ${url}` }, 500);
    }) as typeof fetch;

    const daemonFetch = vi.fn(async (urlPath: string) => {
      if (urlPath === '/api/agents') {
        return jsonResponse({ agents: [{ id: 'codex', available: true }] });
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
      'https://api.getviewport.com/api/runtime/workspaces/workspace_profile/managed-executors/executor_profile/heartbeat',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_profile/managed-executors/executor_profile/heartbeat',
    ]);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      command: 'workflow worker doctor',
      ok: true,
      accessMode: 'polling',
      runnerProfile: 'profile-runner',
      runnerPool: 'profile-pool',
    });
  });

  it('advertises profile agent capabilities and claims matching work without manual flags', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-runner-profile-claim-'));
    const profilePath = path.join(dir, 'runner.json');
    await fs.writeFile(
      profilePath,
      JSON.stringify({
        schema: 'viewport.managed_executor_registration/v1',
        server_url: 'https://api.getviewport.com',
        workspace_id: 'workspace_profile',
        managed_executor_id: 'executor_profile',
        credential: 'vpexec_profile_secret',
        access_mode: 'polling',
        runner_profile: 'profile-runner',
        capabilities: {
          runner_pool: 'payments-profile',
          agents: ['codex'],
          models: ['gpt-5.5'],
          integrations: ['linear'],
          secrets: ['linear/vie-commenter'],
        },
      }),
    );
    process.argv = [
      'node',
      'vpd',
      'workflow',
      'worker',
      '--registration-profile',
      profilePath,
      '--workdir',
      '/repo',
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
          access_mode: 'polling',
          runner_profile: 'profile-runner',
          capabilities: {
            runner_pool: 'payments-profile',
            tools: ['shell'],
            agents: ['codex'],
            models: ['gpt-5.5'],
            integrations: ['linear'],
            secrets: ['linear/vie-commenter'],
          },
        });
        return jsonResponse({ data: { id: 'executor_profile' } });
      }
      if (url.endsWith('/claim')) {
        return jsonResponse({
          data: {
            id: 'run_profile_claim',
            assignment_claim_token: 'vpclaim_profile_claim',
            yaml_snapshot: 'schema: viewport.workflow/v1\nname: profile-claim\nnodes: {}\n',
            source_ref: 'viewport://workflow/profile-claim',
            directory_path: '/repo',
            input_snapshot: { issue: 'VIE-30' },
            runner_workspace_snapshot: { runner_pool: 'payments-profile' },
          },
        });
      }
      if (url.endsWith('/workflow-runs/run_profile_claim/sync')) {
        expect(headerValue(init?.headers, 'X-Viewport-Assignment-Claim')).toBe(
          'vpclaim_profile_claim',
        );
        expect(body).toMatchObject({
          runtime_run_id: 'local_run_1',
          status: 'completed',
        });
        return jsonResponse({ data: { id: 'run_profile_claim', status: 'completed' } });
      }

      return jsonResponse({ message: `unexpected ${url}` }, 500);
    }) as typeof fetch;

    const daemonFetch = vi.fn(async (urlPath: string, init?: RequestInit) => {
      if (urlPath === '/api/agents') {
        return jsonResponse({ agents: [{ id: 'codex', available: true }] });
      }
      if (urlPath === '/api/directories' && (!init?.method || init.method === 'GET')) {
        return jsonResponse([]);
      }
      if (urlPath === '/api/directories' && init?.method === 'POST') {
        return jsonResponse({ id: 'dir_1' });
      }
      if (urlPath === '/api/workflows/runs' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
          resourceId: 'workspace_profile',
          platformRunId: 'run_profile_claim',
          inputs: {
            issue: 'VIE-30',
            viewport: {
              runnerWorkspace: { runner_pool: 'payments-profile' },
            },
          },
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
      'https://api.getviewport.com/api/runtime/workspaces/workspace_profile/managed-executors/executor_profile/heartbeat',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_profile/managed-executors/executor_profile/claim',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_profile/managed-executors/executor_profile/heartbeat',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_profile/managed-executors/executor_profile/workflow-runs/run_profile_claim/sync',
      'https://api.getviewport.com/api/runtime/workspaces/workspace_profile/managed-executors/executor_profile/heartbeat',
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
                type: 'action',
                status: 'queued',
                output: 'Approved',
                metadata: {
                  approval: {
                    approved: true,
                    decision: 'approve',
                    message: 'Ship it',
                    actor: {
                      id: '1',
                      kind: 'user',
                      name: 'Mehr',
                      email: 'mehrshad.sahebsara@gmail.com',
                      source: 'viewport-web',
                      displayName: 'Mehr Sahebsara',
                    },
                    executionGrant: {
                      schema: 'viewport.execution_grant/v1',
                      digest: 'sha256:approved-grant',
                      proposal_key: 'action:approve',
                      approval_decision_key: 'approve-open-pr',
                      issued_at: '2026-05-17T10:00:00.000Z',
                    },
                  },
                  action: {
                    digest: 'sha256:reviewed-action',
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
        expect(body.approval_decisions).toEqual([]);
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
          expectedActionDigest: 'sha256:reviewed-action',
          executionGrant: {
            schema: 'viewport.execution_grant/v1',
            digest: 'sha256:approved-grant',
            proposal_key: 'action:approve',
            approval_decision_key: 'approve-open-pr',
            issued_at: '2026-05-17T10:00:00.000Z',
          },
        });
        expect(body.actor).toEqual({
          id: '1',
          name: 'Mehr',
          email: 'mehrshad.sahebsara@gmail.com',
          source: 'viewport-web',
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

    expect(platformSyncStatuses).toEqual(['completed']);
    expect(String(logSpy.mock.calls.at(-1)?.[0] ?? '')).toContain('"blocked": 0');
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

    expect(platformSyncStatuses).toEqual(['completed']);
    expect(daemonFetch).not.toHaveBeenCalledWith('/api/workflows/runs', expect.anything());
  });

  it('resumes a reclaimed approved action before syncing stale local blocked state', async () => {
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
            id: 'run_platform_action_reclaimed',
            assignment_claim_token: 'vpclaim_action_reclaimed',
            yaml_snapshot: 'schema: viewport.workflow/v1\nname: action-reclaimed\nnodes: {}\n',
            directory_path: '/repo',
            runtime_run_id: 'local_run_action_reclaimed',
            status: 'running',
            nodes: [
              {
                node_key: 'post_to_jira',
                type: 'action',
                status: 'queued',
                metadata: {
                  approval: {
                    approved: true,
                    decision: 'approve',
                    message: 'Approved while worker was down',
                    actor: { name: 'Alice', source: 'viewport-web' },
                  },
                  action: {
                    digest: 'sha256:approved-action',
                  },
                },
              },
            ],
          },
        });
      }
      if (url.endsWith('/workflow-runs/run_platform_action_reclaimed') && init?.method === 'GET') {
        expect(headerValue(init?.headers, 'X-Viewport-Assignment-Claim')).toBe(
          'vpclaim_action_reclaimed',
        );
        return jsonResponse({
          data: {
            id: 'run_platform_action_reclaimed',
            status: 'running',
            nodes: [
              {
                node_key: 'post_to_jira',
                type: 'action',
                status: 'queued',
                metadata: {
                  approval: {
                    approved: true,
                    decision: 'approve',
                    message: 'Approved while worker was down',
                    actor: { name: 'Alice', source: 'viewport-web' },
                  },
                  action: {
                    digest: 'sha256:approved-action',
                  },
                },
              },
            ],
          },
        });
      }
      if (url.endsWith('/workflow-runs/run_platform_action_reclaimed/sync')) {
        expect(headerValue(init?.headers, 'X-Viewport-Assignment-Claim')).toBe(
          'vpclaim_action_reclaimed',
        );
        platformSyncStatuses.push(String(body.status));
        return jsonResponse({ data: { id: 'run_platform_action_reclaimed', status: body.status } });
      }

      return jsonResponse({ message: 'not found' }, 404);
    }) as typeof fetch;

    let localApproved = false;
    const now = Date.now();
    const staleBlockedActionRun: WorkflowRunRecord = {
      ...blockedLocalRun('local_run_action_reclaimed'),
      nodes: {
        post_to_jira: {
          id: 'post_to_jira',
          type: 'action',
          status: 'blocked',
          approval: {
            prompt: 'Approve jira.comment side effect?',
            requestedAt: now,
          },
          metadata: {
            action: {
              digest: 'sha256:approved-action',
              status: 'awaiting_approval',
            },
          },
        },
      },
    };
    const daemonFetch = vi.fn(async (urlPath: string, init?: RequestInit) => {
      if (urlPath === '/api/workflows/runs/local_run_action_reclaimed' && init?.method === 'GET') {
        return jsonResponse({
          run: localApproved
            ? completedLocalRun({ id: 'local_run_action_reclaimed' })
            : staleBlockedActionRun,
        });
      }
      if (urlPath === '/api/workflows/runs/local_run_action_reclaimed/approvals/post_to_jira') {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          approved: true,
          message: 'Approved while worker was down',
          actor: { name: 'Alice', source: 'viewport-web' },
          expectedActionDigest: 'sha256:approved-action',
        });
        localApproved = true;
        return jsonResponse({ run: completedLocalRun({ id: 'local_run_action_reclaimed' }) });
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

    expect(platformSyncStatuses).toEqual(['completed']);
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
            action_proposals: expect.arrayContaining([
              expect.objectContaining({
                proposal_key: 'action:open_pr',
                adapter: 'github',
                action: 'pull_request.create',
                proposal_digest: 'sha256:golden-open-pr',
              }),
              expect.objectContaining({
                proposal_key: 'action:update_jira',
                adapter: 'jira',
                action: 'issue.transition',
                proposal_digest: 'sha256:golden-update-jira',
              }),
            ]),
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
          '--access-mode',
          'direct',
          '--runner-profile',
          'payments-vps',
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
        '/api/runtime/workspaces/workspace_process/managed-executors/executor_process/heartbeat',
      ]);
      expect(platformRequests[0]?.body).toMatchObject({
        access_mode: 'direct',
        runner_profile: 'payments-vps',
        runner_posture: { transport: { mode: 'direct' } },
      });
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

  it('formats exhausted action failures as dead-letter execution receipts', () => {
    const now = Date.now();
    const payload = localRunToSyncPayload({
      ...completedLocalRun({
        id: 'local_run_dead_letter',
        status: 'failed',
        nodes: {
          notify_jira: {
            id: 'notify_jira',
            type: 'action',
            status: 'failed',
            error: 'Jira rejected the transition',
            metadata: {
              action: {
                adapter: 'jira',
                action: 'transition_issue',
                status: 'failed',
                idempotencyKey: 'jira:PAY-1842:transition',
                digest: 'sha256:jira-transition',
                response: { status: 400, error: 'invalid_transition' },
                recovery: {
                  state: 'dead_letter',
                  reason: 'Jira rejected the transition',
                  attempts: 2,
                  retryableByRerun: true,
                  idempotencyKey: 'jira:PAY-1842:transition',
                  digest: 'sha256:jira-transition',
                },
              },
            },
          },
        },
        events: [
          {
            id: 'evt_dead_letter',
            runId: 'local_run_dead_letter',
            timestamp: now,
            type: 'action-dead-letter',
            message: 'Action node notify_jira needs remediation after 2 attempts',
            nodeId: 'notify_jira',
            data: {
              action: {
                adapter: 'jira',
                action: 'transition_issue',
                status: 'failed',
                idempotencyKey: 'jira:PAY-1842:transition',
                digest: 'sha256:jira-transition',
                response: { status: 400, error: 'invalid_transition' },
                recovery: {
                  state: 'dead_letter',
                  reason: 'Jira rejected the transition',
                  attempts: 2,
                  retryableByRerun: true,
                },
              },
            },
          },
        ],
      }),
    });

    expect(payload.execution_receipts).toEqual([
      expect.objectContaining({
        receipt_key: 'execution:evt_dead_letter',
        proposal_key: 'action:notify_jira',
        adapter: 'jira',
        action: 'transition_issue',
        status: 'dead_letter',
        idempotency_key: 'jira:PAY-1842:transition',
        payload_digest: 'sha256:jira-transition',
        payload: expect.objectContaining({
          recovery: expect.objectContaining({
            state: 'dead_letter',
            retryableByRerun: true,
          }),
        }),
      }),
    ]);
    expect(payload.audit_receipts).toEqual([
      expect.objectContaining({
        receipt_key: 'audit:evt_dead_letter',
        event_type: 'action-dead-letter',
      }),
    ]);
  });

  it('formats rejected approval decisions with the protocol canonical deny value', () => {
    const now = Date.now();
    const payload = localRunToSyncPayload({
      ...completedLocalRun({
        nodes: {
          open_pr: {
            id: 'open_pr',
            type: 'approval',
            status: 'canceled',
            output: 'Rejected by reviewer',
            approval: {
              approved: false,
              decision: 'reject',
              message: 'Needs a smaller patch.',
              resolvedAt: now,
            },
            startedAt: now - 1000,
            completedAt: now,
          },
        },
      }),
    });

    expect(payload.approval_decisions).toEqual([
      expect.objectContaining({
        decision_key: `approval:open_pr:${now}`,
        node_key: 'open_pr',
        decision: 'deny',
      }),
    ]);
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

function actionReplayCommand(): string {
  const script = [
    "let raw = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => { raw += chunk; });",
    "process.stdin.on('end', () => {",
    'const input = JSON.parse(raw);',
    'console.log(JSON.stringify({',
    "status: 'succeeded',",
    'provider_reference: input.idempotency_key,',
    "provider_url: 'https://example.test/' + input.idempotency_key,",
    'idempotency_key: input.idempotency_key,',
    'payload_digest: input.action_digest,',
    'payload: { source_workflow_run_id: input.payload.source_workflow_run_id },',
    'provider_response: { ok: true, adapter: input.adapter }',
    '}));',
    '});',
  ].join(' ');
  return `${shellQuote(process.execPath)} -e ${JSON.stringify(script)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
