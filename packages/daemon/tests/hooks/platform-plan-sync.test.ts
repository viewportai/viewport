import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeLocalOrgBinding } from '../../src/cli/org-binding.js';
import { PlatformPlanHookSync } from '../../src/hooks/platform-plan-sync.js';

describe('PlatformPlanHookSync', () => {
  it('saves an encrypted trusted-edge plan and opens the saved plan without putting content in the URL', async () => {
    const opener = vi.fn();
    const createEphemeralPlanDraft = vi.fn();
    const planSaver = vi.fn(async () => ({
      planId: 'plan_1',
      sourceRef: 'claude://session/session_1',
      envelope: {
        schema: 'viewport.plan_body_encrypted/v1',
        algorithm: 'AES-GCM-256',
        key_ref: 'key_1',
        ciphertext: 'ciphertext',
        iv: 'iv',
        tag: 'tag',
        digest: 'sha256:abc',
        aad: {},
      },
    }));
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
      planSaver,
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
    expect(url.searchParams.get('plan_id')).toBe('plan_1');
    expect(url.hash).toBe('');
    expect(opened).not.toContain('Inspect%20diff');
    expect(opened).not.toContain('Inspect diff');
    expect(opened).not.toContain('do-not-forward');
    expect(createEphemeralPlanDraft).not.toHaveBeenCalled();
    expect(planSaver).toHaveBeenCalledWith({
      event: expect.objectContaining({
        body: '## Plan\n1. Inspect diff\n2. Report risks',
        metadata: expect.objectContaining({ secret: 'do-not-forward' }),
      }),
      target: expect.objectContaining({
        workspaceId: 'workspace_1',
        credential: 'issue-token',
      }),
    });
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
    const createEphemeralPlanDraft = vi.fn();
    const planSaver = vi.fn(async () => ({
      planId: 'plan_2',
      sourceRef: 'agent-hook:session_1',
      envelope: {
        schema: 'viewport.plan_body_encrypted/v1',
        algorithm: 'AES-GCM-256',
        key_ref: 'key_2',
        ciphertext: 'ciphertext',
        iv: 'iv',
        tag: 'tag',
        digest: 'sha256:def',
        aad: {},
      },
    }));
    const sync = new PlatformPlanHookSync(
      {
        configManager: {
          getDaemonConfig: () => ({
            server: { url: 'https://api.getviewport.test', appUrl: 'https://app.getviewport.test' },
            relay: {
              bindings: [
                {
                  workspaceId: 'workspace_1',
                  serverUrl: 'https://api.getviewport.test',
                  issueToken: 'issue-token-1',
                },
                {
                  workspaceId: 'workspace_2',
                  serverUrl: 'https://api.getviewport.test',
                  issueToken: 'issue-token-2',
                },
              ],
            },
          }),
        },
        createEphemeralPlanDraft,
      },
      opener,
      planSaver,
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
    expect(url.searchParams.get('plan_id')).toBe('plan_2');
    expect(url.hash).toBe('');
    expect(createEphemeralPlanDraft).not.toHaveBeenCalled();
    expect(planSaver).toHaveBeenCalledWith({
      event: expect.objectContaining({ body: 'Plan' }),
      target: expect.objectContaining({
        workspaceId: 'workspace_2',
        credential: 'issue-token-2',
      }),
    });

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('fails closed when the trusted-edge plan save fails', async () => {
    const opener = vi.fn();
    const createEphemeralPlanDraft = vi.fn();
    const planSaver = vi.fn(async () => {
      throw new Error('server unavailable');
    });
    const sync = new PlatformPlanHookSync(
      {
        configManager: {
          getDaemonConfig: () => ({
            server: {
              url: 'https://getviewport.test',
              appUrl: 'https://app.getviewport.test',
            },
            relay: { workspaceId: 'workspace_1', issueToken: 'issue-token' },
          }),
        },
        createEphemeralPlanDraft,
      },
      opener,
      planSaver,
    );

    await expect(
      sync.send({
        sessionId: 'session_1',
        adapter: 'claude',
        body: '## Plan',
      }),
    ).resolves.toEqual({ opened: false, reason: 'trusted_edge_save_failed' });
    expect(opener).not.toHaveBeenCalled();
    expect(createEphemeralPlanDraft).not.toHaveBeenCalled();
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
