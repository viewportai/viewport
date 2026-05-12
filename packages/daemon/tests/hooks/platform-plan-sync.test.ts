import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeLocalOrgBinding } from '../../src/cli/org-binding.js';
import { PlatformPlanHookSync } from '../../src/hooks/platform-plan-sync.js';

describe('PlatformPlanHookSync', () => {
  it('opens an ephemeral web plan draft without putting plan content in the URL', async () => {
    const opener = vi.fn();
    const createEphemeralPlanDraft = vi.fn(() => ({ draftId: 'draft_1' }));
    const sync = new PlatformPlanHookSync(
      {
        configManager: {
          getDaemonConfig: () => ({
            server: {
              url: 'https://getviewport.test',
              appUrl: 'https://app.getviewport.test',
              tlsVerify: '0',
            },
            relay: { workspaceId: 'workspace_1', issueToken: 'issue-token' },
          }),
        },
        createEphemeralPlanDraft,
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
    expect(url.searchParams.get('resource_id')).toBe('workspace_1');
    expect(url.searchParams.get('draft')).toBeNull();
    expect(url.hash).toBe('#viewport-plan-draft=draft_1');
    expect(opened).not.toContain('Inspect%20diff');
    expect(opened).not.toContain('Inspect diff');
    expect(opened).not.toContain('do-not-forward');
    expect(createEphemeralPlanDraft).toHaveBeenCalledWith(
      'workspace_1',
      expect.objectContaining({
        body: '## Plan\n1. Inspect diff\n2. Report risks',
        metadata: expect.objectContaining({ secret: 'do-not-forward' }),
      }),
    );
  });

  it('skips opening when no relay workspace is configured', async () => {
    const opener = vi.fn();
    const sync = new PlatformPlanHookSync(
      {
        configManager: {
          getDaemonConfig: () => ({
            server: { url: 'https://getviewport.test' },
            relay: {},
          }),
        },
        createEphemeralPlanDraft: vi.fn(),
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
    const createEphemeralPlanDraft = vi.fn(() => ({ draftId: 'draft_2' }));
    const sync = new PlatformPlanHookSync(
      {
        configManager: {
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
        createEphemeralPlanDraft,
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
    expect(url.searchParams.get('resource_id')).toBe('workspace_2');
    expect(url.hash).toBe('#viewport-plan-draft=draft_2');
    expect(createEphemeralPlanDraft).toHaveBeenCalledWith(
      'workspace_2',
      expect.objectContaining({ body: 'Plan' }),
    );

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
        configManager: {
          getDaemonConfig: () => ({
            server: { url: 'https://getviewport.test' },
            relay: { workspaceId: 'workspace_1', issueToken: 'issue-token' },
          }),
        },
        createEphemeralPlanDraft: vi.fn(),
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
});
