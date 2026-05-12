import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeLocalOrgBinding } from '../../src/cli/org-binding.js';
import { PlatformPlanHookSync } from '../../src/hooks/platform-plan-sync.js';
import { PLAN_PROPOSAL_SCHEMA_VERSION } from '../../src/hooks/plan-extractor.js';
import { writeLocalOrgBinding } from '../../src/cli/org-binding.js';

describe('PlatformPlanHookSync', () => {
  it('opens an ephemeral web plan draft instead of persisting the proposal', async () => {
    const opener = vi.fn();
    const sync = new PlatformPlanHookSync(
      {
        getDaemonConfig: () => ({
          server: {
            url: 'https://getviewport.test',
            appUrl: 'https://app.getviewport.test',
            tlsVerify: '0',
          },
          relay: { workspaceId: 'workspace_1', issueToken: 'issue-token' },
        }),
      },
      opener,
    );

    await expect(
      sync.send({
        sessionId: 'session_1',
        adapter: 'claude',
        title: 'Review plan',
        summary: 'Inspect the diff',
        body: '## Plan\n1. Inspect diff\n2. Report risks',
        source: 'claude',
        sourceRef: 'claude://session/session_1',
        metadata: {
          hookRequestId: 'hk-1',
          resourceId: 'workspace_2',
          secret: 'do-not-forward',
          workflowRunId: 'run_1',
        },
      }),
    ).resolves.toMatchObject({ opened: true });

    const opened = opener.mock.calls[0]?.[0] as string;
    const url = new URL(opened);
    expect(`${url.origin}${url.pathname}`).toBe('https://app.getviewport.test/plans');
    expect(url.searchParams.get('resource')).toBe('workspace_1');
    expect(url.searchParams.get('draft')).toBe('agent');

    const draft = decodeDraft(url.hash);
    expect(draft).toMatchObject({
      schema: PLAN_PROPOSAL_SCHEMA_VERSION,
      title: 'Review plan',
      summary: 'Inspect the diff',
      body: '## Plan\n1. Inspect diff\n2. Report risks',
      source: 'claude',
      source_ref: 'claude://session/session_1',
      session_id: 'session_1',
      hook_request_id: 'hk-1',
      metadata: { hookRequestId: 'hk-1', workflowRunId: 'run_1' },
    });
    expect(draft.metadata).not.toHaveProperty('secret');
    expect(draft.metadata).not.toHaveProperty('resourceId');
  });

  it('skips opening when no relay workspace is configured', async () => {
    const opener = vi.fn();
    const sync = new PlatformPlanHookSync(
      {
        getDaemonConfig: () => ({
          server: { url: 'https://getviewport.test' },
          relay: {},
        }),
      },
      opener,
    );

    await expect(
      sync.send({
        sessionId: 'session_1',
        adapter: 'codex',
        body: 'Plan',
      }),
    ).resolves.toEqual({ opened: false, reason: 'missing_platform_target' });
    expect(opener).not.toHaveBeenCalled();
  });

  it('routes cwd-scoped plan drafts through the matching local organization binding', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-plan-sync-bound-'));
    await writeLocalOrgBinding({ directory: tempDir, organizationId: 'workspace_2' });
    const opener = vi.fn();
    const sync = new PlatformPlanHookSync(
      {
        getDaemonConfig: () => ({
          server: { url: 'https://api.getviewport.test', appUrl: 'https://app.getviewport.test' },
          relay: {
            bindings: [
              { workspaceId: 'workspace_1', serverUrl: 'https://api.getviewport.test' },
              { workspaceId: 'workspace_2', serverUrl: 'https://api.getviewport.test' },
            ],
          },
        }),
      },
      opener,
    );

    await expect(
      sync.send({
        sessionId: 'session_1',
        adapter: 'claude',
        cwd: tempDir,
        body: 'Plan',
      }),
    ).resolves.toMatchObject({ opened: true });

    const opened = opener.mock.calls[0]?.[0] as string;
    const url = new URL(opened);
    expect(url.searchParams.get('resource')).toBe('workspace_2');
    expect(decodeDraft(url.hash)).toMatchObject({ body: 'Plan' });

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('does not open a cwd-scoped plan draft from a directory with streaming disabled', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-plan-sync-disabled-'));
    await writeLocalOrgBinding({
      directory: tempDir,
      organizationId: 'workspace_1',
      streamEnabled: false,
    });
    const opener = vi.fn();
    const sync = new PlatformPlanHookSync(
      {
        getDaemonConfig: () => ({
          server: { url: 'https://getviewport.test' },
          relay: { workspaceId: 'workspace_1', issueToken: 'issue-token' },
        }),
      },
      opener,
    );

    await expect(
      sync.send({
        sessionId: 'session_1',
        adapter: 'claude',
        cwd: tempDir,
        body: 'Plan',
      }),
    ).resolves.toEqual({ opened: false, reason: 'missing_platform_target' });
    expect(opener).not.toHaveBeenCalled();
    await fs.rm(tempDir, { recursive: true, force: true });
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

function decodeDraft(hash: string): Record<string, unknown> {
  const payload = hash.replace(/^#viewport-plan=/, '');
  const padded = `${payload}${'='.repeat((4 - (payload.length % 4)) % 4)}`;
  const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}
