import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import {
  waitForCompletedRun,
  waitForRunState,
  waitForTerminalRun,
} from './support/workflow-runner-support.js';

let tempHome: string;
let projectDir: string;
let originalHome: string | undefined;
let originalCodexHome: string | undefined;
const originalFetch = global.fetch;

async function setup(): Promise<Daemon> {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-actions-home-'));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-actions-project-'));
  originalHome = process.env['HOME'];
  originalCodexHome = process.env['CODEX_HOME'];
  process.env['HOME'] = tempHome;
  process.env['CODEX_HOME'] = path.join(tempHome, '.codex');

  const daemon = new Daemon();
  await daemon.initialize();
  await daemon.directoryManager.register(projectDir);
  return daemon;
}

async function cleanup(): Promise<void> {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
  else process.env['CODEX_HOME'] = originalCodexHome;
  await fs.rm(tempHome, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
}

describe('workflow runner action adapters', () => {
  afterEach(cleanup);

  it('executes a generic webhook action and records response evidence', async () => {
    const fetchMock = vi.fn(async () => new Response('accepted', { status: 202 }));
    global.fetch = fetchMock as typeof fetch;

    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: webhook-action-proof
inputs:
  issue: { type: string, required: true }
nodes:
  notify:
    type: action
    adapter: webhook
    action: post
    idempotencyKey: "issue:{{ inputs.issue }}"
    with:
      url: https://hooks.example.test/workflow
      headers:
        X-Viewport-Test: yes
      body:
        issue: "{{ inputs.issue }}"
        status: ready
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      inputs: { issue: 'PAY-1842' },
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.example.test/workflow',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Viewport-Test': 'yes',
          'Idempotency-Key': 'issue:PAY-1842',
        }),
        body: JSON.stringify({ issue: 'PAY-1842', status: 'ready' }),
      }),
    );
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.notify?.output).toBe('webhook.post 202');
    expect(completed?.nodes.notify?.metadata?.action).toMatchObject({
      adapter: 'webhook',
      action: 'post',
      idempotencyKey: 'issue:PAY-1842',
      status: 'executed',
      response: { status: 202, ok: true, bodyExcerpt: 'accepted' },
    });
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'action-executed',
        nodeId: 'notify',
      }),
    );
  });

  it('blocks approved side-effect actions until approval, then executes on resume', async () => {
    const fetchMock = vi.fn(async () => new Response('approved action', { status: 200 }));
    global.fetch = fetchMock as typeof fetch;

    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: action-approval-proof
nodes:
  post_approval:
    type: action
    adapter: webhook
    action: post
    requiresApproval: true
    with:
      url: https://hooks.example.test/workflow
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    const blocked = await waitForRunState(
      daemon,
      run.id,
      (candidate) =>
        candidate.status === 'blocked' && candidate.nodes.post_approval?.status === 'blocked',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(blocked.nodes.post_approval?.approval?.prompt).toBe('Approve webhook.post side effect?');
    expect(blocked.nodes.post_approval?.metadata?.action).toMatchObject({
      adapter: 'webhook',
      action: 'post',
      status: 'awaiting_approval',
      requiresApproval: true,
    });
    expect(blocked.nodes.post_approval?.metadata?.action?.digest).toMatch(/^sha256:/);

    await expect(
      daemon.workflowRunner.decideApproval(run.id, 'post_approval', {
        approved: true,
        message: 'Stale approval',
        expectedActionDigest: 'sha256:stale',
      }),
    ).rejects.toThrow('The proposed action changed before approval');
    expect(fetchMock).not.toHaveBeenCalled();

    await daemon.workflowRunner.decideApproval(run.id, 'post_approval', {
      approved: true,
      decision: 'approve',
      message: 'Approved by test',
      expectedActionDigest: String(blocked.nodes.post_approval?.metadata?.action?.digest),
      actor: {
        id: '42',
        name: 'Test User',
        email: 'test@example.test',
        source: 'unit-test',
      },
    });

    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.example.test/workflow',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.post_approval?.metadata?.action).toMatchObject({
      adapter: 'webhook',
      action: 'post',
      status: 'executed',
      requiresApproval: true,
    });
    expect(completed?.nodes.post_approval?.metadata?.action?.digest).toBe(
      blocked.nodes.post_approval?.metadata?.action?.digest,
    );
    expect(completed?.nodes.post_approval?.approval?.decision).toBe('approve');
  });

  it('cancels approved side-effect actions on request changes without executing', async () => {
    const fetchMock = vi.fn(async () => new Response('should not run', { status: 200 }));
    global.fetch = fetchMock as typeof fetch;

    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: action-request-changes-proof
nodes:
  open_pr:
    type: action
    adapter: webhook
    action: post
    requiresApproval: true
    with:
      url: https://hooks.example.test/pr
      body:
        title: Fix PAY-1842
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    const blocked = await waitForRunState(
      daemon,
      run.id,
      (candidate) => candidate.status === 'blocked' && candidate.nodes.open_pr?.status === 'blocked',
    );

    await daemon.workflowRunner.decideApproval(run.id, 'open_pr', {
      approved: false,
      decision: 'request_changes',
      message: 'Add a regression test before opening the PR.',
      expectedActionDigest: String(blocked.nodes.open_pr?.metadata?.action?.digest),
    });

    await waitForTerminalRun(daemon, run.id);
    const canceled = await daemon.workflowRunner.getRun(run.id);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(canceled?.status).toBe('canceled');
    expect(canceled?.nodes.open_pr?.status).toBe('failed');
    expect(canceled?.nodes.open_pr?.approval?.decision).toBe('request_changes');
    expect(canceled?.events.some((event) => event.type === 'action-executed')).toBe(false);
  });

  it('executes native GitHub PR actions with runner-local credentials', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            number: 4821,
            html_url: 'https://github.com/acme/payments/pull/4821',
            url: 'https://api.github.com/repos/acme/payments/pulls/4821',
          }),
          { status: 201 },
        ),
    );
    global.fetch = fetchMock as typeof fetch;
    const originalToken = process.env['GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'runner-token';

    try {
      const daemon = await setup();
      const workflowPath = path.join(projectDir, 'workflow.yaml');
      await fs.writeFile(
        workflowPath,
        `
schema: viewport.workflow/v1
name: github-pr-proof
nodes:
  open_pr:
    type: action
    adapter: github
    action: create_pr
    idempotencyKey: pr:PAY-1842
    with:
      owner: acme
      repo: payments
      title: Fix checkout discount normalization
      head: viewport/pay-1842
      base: main
      body: "Generated by Viewport workflow."
`,
        'utf-8',
      );

      const run = await daemon.workflowRunner.startRun({
        workflowPath,
        directoryId: DirectoryManager.idFromPath(projectDir),
        initiation: 'cli',
      });

      await waitForTerminalRun(daemon, run.id);
      const completed = await daemon.workflowRunner.getRun(run.id);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/acme/payments/pulls',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer runner-token',
            'X-GitHub-Api-Version': '2022-11-28',
            'Idempotency-Key': 'pr:PAY-1842',
          }),
          body: JSON.stringify({
            title: 'Fix checkout discount normalization',
            head: 'viewport/pay-1842',
            base: 'main',
            body: 'Generated by Viewport workflow.',
          }),
        }),
      );
      expect(completed?.status).toBe('completed');
      expect(completed?.nodes.open_pr?.metadata?.action).toMatchObject({
        adapter: 'github',
        action: 'create_pr',
        idempotencyKey: 'pr:PAY-1842',
        status: 'executed',
        response: {
          status: 201,
          htmlUrl: 'https://github.com/acme/payments/pull/4821',
          number: 4821,
        },
      });
    } finally {
      if (originalToken === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = originalToken;
    }
  });

  it('executes native GitHub issue comments with runner-local credentials', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            html_url: 'https://github.com/acme/payments/issues/1842#issuecomment-42',
            url: 'https://api.github.com/repos/acme/payments/issues/comments/42',
          }),
          { status: 201 },
        ),
    );
    global.fetch = fetchMock as typeof fetch;
    const originalToken = process.env['GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'runner-token';

    try {
      const daemon = await setup();
      const workflowPath = path.join(projectDir, 'workflow.yaml');
      await fs.writeFile(
        workflowPath,
        `
schema: viewport.workflow/v1
name: github-comment-proof
nodes:
  comment_issue:
    type: action
    adapter: github
    action: comment_issue
    with:
      owner: acme
      repo: payments
      issue_number: "1842"
      body: "Viewport workflow opened PR #4821 and moved PAY-1842 to review."
`,
        'utf-8',
      );

      const run = await daemon.workflowRunner.startRun({
        workflowPath,
        directoryId: DirectoryManager.idFromPath(projectDir),
        initiation: 'cli',
      });

      await waitForTerminalRun(daemon, run.id);
      const completed = await daemon.workflowRunner.getRun(run.id);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/acme/payments/issues/1842/comments',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer runner-token',
            'X-GitHub-Api-Version': '2022-11-28',
          }),
          body: JSON.stringify({
            body: 'Viewport workflow opened PR #4821 and moved PAY-1842 to review.',
          }),
        }),
      );
      expect(completed?.status).toBe('completed');
      expect(completed?.nodes.comment_issue?.metadata?.action).toMatchObject({
        adapter: 'github',
        action: 'comment_issue',
        status: 'executed',
        response: {
          status: 201,
          htmlUrl: 'https://github.com/acme/payments/issues/1842#issuecomment-42',
        },
      });
    } finally {
      if (originalToken === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = originalToken;
    }
  });

  it('executes native Jira comments and transitions with runner-local credentials', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: '10042' }), { status: 201 }),
    );
    global.fetch = fetchMock as typeof fetch;
    const originalBaseUrl = process.env['JIRA_BASE_URL'];
    const originalToken = process.env['JIRA_API_TOKEN'];
    const originalEmail = process.env['JIRA_EMAIL'];
    process.env['JIRA_BASE_URL'] = 'https://acme.atlassian.net';
    process.env['JIRA_API_TOKEN'] = 'jira-token';
    process.env['JIRA_EMAIL'] = 'bot@example.test';

    try {
      const daemon = await setup();
      const workflowPath = path.join(projectDir, 'workflow.yaml');
      await fs.writeFile(
        workflowPath,
        `
schema: viewport.workflow/v1
name: jira-action-proof
nodes:
  comment:
    type: action
    adapter: jira
    action: issue.comment
    idempotencyKey: jira-comment:PAY-1842
    with:
      issue_key: PAY-1842
      body: "Fixed in PR #4821."
  transition:
    type: action
    adapter: jira
    action: issue.transition
    idempotencyKey: jira-transition:PAY-1842
    needs: [comment]
    with:
      issue_key: PAY-1842
      transition_id: "31"
`,
        'utf-8',
      );

      const run = await daemon.workflowRunner.startRun({
        workflowPath,
        directoryId: DirectoryManager.idFromPath(projectDir),
        initiation: 'cli',
      });

      await waitForTerminalRun(daemon, run.id);
      const completed = await daemon.workflowRunner.getRun(run.id);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://acme.atlassian.net/rest/api/3/issue/PAY-1842/comment',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Basic ${Buffer.from('bot@example.test:jira-token').toString('base64')}`,
            'Idempotency-Key': 'jira-comment:PAY-1842',
          }),
        }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        'https://acme.atlassian.net/rest/api/3/issue/PAY-1842/transitions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Idempotency-Key': 'jira-transition:PAY-1842',
          }),
          body: JSON.stringify({ transition: { id: '31' } }),
        }),
      );
      expect(completed?.status).toBe('completed');
      expect(completed?.nodes.comment?.metadata?.action).toMatchObject({
        adapter: 'jira',
        action: 'issue.comment',
        idempotencyKey: 'jira-comment:PAY-1842',
        status: 'executed',
      });
      expect(completed?.nodes.transition?.metadata?.action).toMatchObject({
        adapter: 'jira',
        action: 'issue.transition',
        idempotencyKey: 'jira-transition:PAY-1842',
        status: 'executed',
      });
    } finally {
      if (originalBaseUrl === undefined) delete process.env['JIRA_BASE_URL'];
      else process.env['JIRA_BASE_URL'] = originalBaseUrl;
      if (originalToken === undefined) delete process.env['JIRA_API_TOKEN'];
      else process.env['JIRA_API_TOKEN'] = originalToken;
      if (originalEmail === undefined) delete process.env['JIRA_EMAIL'];
      else process.env['JIRA_EMAIL'] = originalEmail;
    }
  });

  it('executes native Slack messages and treats Slack ok false as action failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, channel: 'C123', ts: '177000.0001' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }),
      );
    global.fetch = fetchMock as typeof fetch;
    const originalToken = process.env['SLACK_BOT_TOKEN'];
    process.env['SLACK_BOT_TOKEN'] = 'slack-token';

    try {
      const daemon = await setup();
      const workflowPath = path.join(projectDir, 'workflow.yaml');
      await fs.writeFile(
        workflowPath,
        `
schema: viewport.workflow/v1
name: slack-action-proof
nodes:
  announce:
    type: action
    adapter: slack
    action: post_message
    idempotencyKey: slack-announce:PAY-1842
    with:
      channel: C123
      text: "Codex found the bug and tests are passing."
  fail_slack:
    type: action
    adapter: slack
    action: post_message
    needs: [announce]
    with:
      channel: missing
      text: "This should fail."
`,
        'utf-8',
      );

      const run = await daemon.workflowRunner.startRun({
        workflowPath,
        directoryId: DirectoryManager.idFromPath(projectDir),
        initiation: 'cli',
      });

      await waitForTerminalRun(daemon, run.id);
      const failed = await daemon.workflowRunner.getRun(run.id);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postMessage',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer slack-token',
            'Idempotency-Key': 'slack-announce:PAY-1842',
          }),
        }),
      );
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        channel: 'C123',
        client_msg_id: 'slack-announce:PAY-1842',
        text: 'Codex found the bug and tests are passing.',
      });
      expect(failed?.status).toBe('failed');
      expect(failed?.nodes.announce?.metadata?.action).toMatchObject({
        adapter: 'slack',
        action: 'post_message',
        idempotencyKey: 'slack-announce:PAY-1842',
        status: 'executed',
        response: { channel: 'C123', ts: '177000.0001' },
      });
      expect(failed?.nodes.fail_slack?.metadata?.action).toMatchObject({
        adapter: 'slack',
        action: 'post_message',
        status: 'failed',
        response: { error: 'channel_not_found' },
      });
    } finally {
      if (originalToken === undefined) delete process.env['SLACK_BOT_TOKEN'];
      else process.env['SLACK_BOT_TOKEN'] = originalToken;
    }
  });
});
