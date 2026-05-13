import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PlatformPlanHookSync } from '../../src/hooks/platform-plan-sync.js';
import type { TransportFetchOptions } from '../../src/cli/network.js';
import { PLAN_PROPOSAL_SCHEMA_VERSION } from '../../src/hooks/plan-extractor.js';
import { writeLocalOrgBinding } from '../../src/cli/org-binding.js';

describe('PlatformPlanHookSync', () => {
  it('sends plan proposals to the daemon-authenticated platform ingestion endpoint', async () => {
    const requests: Array<{ url: string; options: TransportFetchOptions }> = [];
    const fetcher = vi.fn(async (url: string, options: TransportFetchOptions) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ data: { id: 'plan_1' } }), { status: 201 });
    });
    const sync = new PlatformPlanHookSync(
      {
        getDaemonConfig: () => ({
          server: { url: 'https://getviewport.test', tlsVerify: '0' },
          relay: { workspaceId: 'workspace_1', issueToken: 'issue-token' },
        }),
      },
      fetcher,
    );

    await expect(
      sync.send({
        sessionId: 'session_1',
        adapter: 'claude',
        cwd: '/repo',
        title: 'Review plan',
        summary: 'Inspect the diff',
        body: '## Plan\n1. Inspect diff\n2. Report risks',
        source: 'claude',
        sourceRef: 'claude://session/session_1',
        metadata: {
          resourceId: 'workspace_2',
          secret: 'do-not-forward',
          workflowRunId: 'run_1',
        },
      }),
    ).resolves.toEqual({ synced: true });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://getviewport.test/api/runtime/workspaces/workspace_1/agent-hooks/plans',
    );
    expect(requests[0]?.options.tlsVerify).toBe('0');
    expect(JSON.parse(String(requests[0]?.options.body))).toMatchObject({
      credential: 'issue-token',
      hook_event_name: 'PlanProposed',
      schema: PLAN_PROPOSAL_SCHEMA_VERSION,
      session_id: 'session_1',
      title: 'Review plan',
      summary: 'Inspect the diff',
      body: '## Plan\n1. Inspect diff\n2. Report risks',
      source: 'claude',
      source_ref: 'claude://session/session_1',
      payload: { workflowRunId: 'run_1' },
    });
    expect(JSON.parse(String(requests[0]?.options.body))).not.toHaveProperty('cwd');
  });

  it('skips sync when no relay issue token or runtime target is configured', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { id: 'plan_1' } })));
    const sync = new PlatformPlanHookSync(
      {
        getDaemonConfig: () => ({
          server: { url: 'https://getviewport.test' },
          relay: {},
        }),
      },
      fetcher,
    );

    await expect(
      sync.send({
        sessionId: 'session_1',
        adapter: 'codex',
        body: 'Plan',
      }),
    ).resolves.toEqual({ synced: false, reason: 'missing_platform_target' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes only to the active relay project, not agent-controlled metadata', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { id: 'plan_1' } })));
    const sync = new PlatformPlanHookSync(
      {
        getDaemonConfig: () => ({
          server: { url: 'https://getviewport.test' },
          relay: { workspaceId: 'workspace_1', issueToken: 'issue-token' },
        }),
      },
      fetcher,
    );

    await expect(
      sync.send({
        sessionId: 'session_1',
        adapter: 'viewport-workflow',
        body: 'Plan',
        metadata: { resourceId: 'workspace_2' },
      }),
    ).resolves.toEqual({ synced: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('routes plan proposals to the repo-bound workspace when multiple relay bindings exist', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-plan-sync-'));
    await writeLocalOrgBinding({ directory: cwd, organizationId: 'workspace_2' });

    const requests: Array<{ url: string; options: TransportFetchOptions }> = [];
    const fetcher = vi.fn(async (url: string, options: TransportFetchOptions) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ data: { id: 'plan_1' } }), { status: 201 });
    });
    const sync = new PlatformPlanHookSync(
      {
        getDaemonConfig: () => ({
          server: { url: 'https://fallback.getviewport.test' },
          relay: {
            bindings: [
              {
                workspaceId: 'workspace_1',
                serverUrl: 'https://api.getviewport.test',
                issueToken: 'token-1',
              },
              {
                workspaceId: 'workspace_2',
                serverUrl: 'https://api.getviewport.test',
                issueToken: 'token-2',
              },
            ],
          },
        }),
      },
      fetcher,
    );

    await expect(
      sync.send({
        sessionId: 'session_1',
        adapter: 'claude',
        cwd,
        body: 'Plan',
      }),
    ).resolves.toEqual({ synced: true });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://api.getviewport.test/api/runtime/workspaces/workspace_2/agent-hooks/plans',
    );
    expect(JSON.parse(String(requests[0]?.options.body))).toMatchObject({
      credential: 'token-2',
      hook_event_name: 'PlanProposed',
    });
  });

  it('does not guess a plan workspace when multiple relay bindings exist without a repo binding', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: { id: 'plan_1' } })));
    const sync = new PlatformPlanHookSync(
      {
        getDaemonConfig: () => ({
          relay: {
            bindings: [
              {
                workspaceId: 'workspace_1',
                serverUrl: 'https://api.getviewport.test',
                issueToken: 'token-1',
              },
              {
                workspaceId: 'workspace_2',
                serverUrl: 'https://api.getviewport.test',
                issueToken: 'token-2',
              },
            ],
          },
        }),
      },
      fetcher,
    );

    await expect(
      sync.send({
        sessionId: 'session_1',
        adapter: 'claude',
        cwd: '/no/local/binding',
        body: 'Plan',
      }),
    ).resolves.toEqual({ synced: false, reason: 'missing_platform_target' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
