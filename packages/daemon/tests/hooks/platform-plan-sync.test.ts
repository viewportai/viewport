import { describe, expect, it, vi } from 'vitest';
import { PlatformPlanHookSync } from '../../src/hooks/platform-plan-sync.js';
import type { TransportFetchOptions } from '../../src/cli/network.js';

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
        metadata: { projectId: 'workspace_1', workflowRunId: 'run_1' },
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
      session_id: 'session_1',
      cwd: '/repo',
      title: 'Review plan',
      summary: 'Inspect the diff',
      body: '## Plan\n1. Inspect diff\n2. Report risks',
      source: 'claude',
      source_ref: 'claude://session/session_1',
      payload: { projectId: 'workspace_1', workflowRunId: 'run_1' },
    });
  });

  it('skips sync when no relay issue token or project target is configured', async () => {
    const fetcher = vi.fn();
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

  it('does not sync an event for a different project than the active relay binding', async () => {
    const fetcher = vi.fn();
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
        metadata: { projectId: 'workspace_2' },
      }),
    ).resolves.toEqual({ synced: false, reason: 'missing_platform_target' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
