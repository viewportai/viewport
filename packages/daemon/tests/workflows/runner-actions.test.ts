import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import { workflowRunToSyncPayload } from '../../src/workflows/platform-sync-payload.js';
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

  it('suppresses duplicate side effects with the same idempotency key in one run', async () => {
    const fetchMock = vi.fn(async () => new Response('created once', { status: 201 }));
    global.fetch = fetchMock as typeof fetch;

    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: webhook-action-idempotency-proof
nodes:
  create_once:
    type: action
    adapter: webhook
    action: post
    idempotencyKey: issue:PAY-1842
    with:
      url: https://hooks.example.test/workflow
      body:
        issue: PAY-1842
        status: ready
  duplicate_create:
    type: action
    adapter: webhook
    action: post
    needs: [create_once]
    idempotencyKey: issue:PAY-1842
    with:
      url: https://hooks.example.test/workflow
      body:
        issue: PAY-1842
        status: ready
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(completed?.status).toBe('completed');
    expect(completed?.actionLedger?.['idempotency:issue:PAY-1842']).toMatchObject({
      nodeId: 'create_once',
      idempotencyKey: 'issue:PAY-1842',
    });
    expect(completed?.nodes.duplicate_create?.metadata?.action).toMatchObject({
      status: 'already_executed',
      duplicateOfNodeId: 'create_once',
      idempotencyKey: 'issue:PAY-1842',
    });
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'action-duplicate-suppressed',
        nodeId: 'duplicate_create',
      }),
    );
  });

  it('fails closed when an idempotency key is reused with a different action payload', async () => {
    const fetchMock = vi.fn(async () => new Response('created once', { status: 201 }));
    global.fetch = fetchMock as typeof fetch;

    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: webhook-action-idempotency-conflict-proof
nodes:
  create_once:
    type: action
    adapter: webhook
    action: post
    idempotencyKey: issue:PAY-1842
    with:
      url: https://hooks.example.test/workflow
      body:
        issue: PAY-1842
        status: ready
  conflicting_create:
    type: action
    adapter: webhook
    action: post
    needs: [create_once]
    idempotencyKey: issue:PAY-1842
    with:
      url: https://hooks.example.test/workflow
      body:
        issue: PAY-1842
        status: different
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.conflicting_create?.status).toBe('failed');
    expect(failed?.nodes.conflicting_create?.error).toContain(
      "Action idempotency key 'issue:PAY-1842' was already used with a different proposed action",
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
      policyReason: 'This side effect is configured to require human approval before execution.',
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

  it('preserves brokered provider proposals after platform approval grants execution', async () => {
    const fetchMock = vi.fn(async () => new Response('runner must not execute', { status: 200 }));
    global.fetch = fetchMock as typeof fetch;

    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: brokered-provider-approval-proof
nodes:
  open_pr:
    type: action
    adapter: github
    action: open_pr
    proposalKey: github.open_pr
    requiresApproval: true
    with:
      credential_ref: github/installation/123
      owner: acme
      repo: payments
      head: viewport/pay-1842
      base: main
      title: Fix checkout discount normalization
      body: Generated by Viewport workflow.
  after:
    type: shell
    needs: [open_pr]
    command: printf "{{ nodes.open_pr.output }}"
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
        candidate.status === 'blocked' && candidate.nodes.open_pr?.status === 'blocked',
    );

    const action = blocked.nodes.open_pr?.metadata?.action as { digest?: string };
    expect(action.digest).toMatch(/^sha256:/);

    await daemon.workflowRunner.decideApproval(run.id, 'open_pr', {
      approved: true,
      decision: 'approve',
      message: 'Approved by Viewport broker',
      expectedActionDigest: action.digest,
      executionGrant: {
        schema: 'viewport.execution_grant/v1',
        digest: 'sha256:grant',
        proposal_key: 'github.open_pr',
        approval_decision_key: 'viewport-web:action-proposal:test',
        issued_at: '2026-05-24T00:00:00.000Z',
      },
    });

    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);
    const completedAction = completed?.nodes.open_pr?.metadata?.action as {
      digest?: string;
      status?: string;
      executionGrant?: Record<string, unknown>;
    };

    expect(fetchMock).not.toHaveBeenCalled();
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.after?.output).toBe('github.open_pr');
    expect(completedAction).toMatchObject({
      adapter: 'github',
      action: 'open_pr',
      status: 'awaiting_approval',
      digest: action.digest,
      executionGrant: {
        proposal_key: 'github.open_pr',
        approval_decision_key: 'viewport-web:action-proposal:test',
      },
    });

    const syncPayload = workflowRunToSyncPayload(completed!);
    expect(syncPayload['action_proposals']).toEqual([
      expect.objectContaining({
        proposal_key: 'github.open_pr',
        adapter: 'github',
        action: 'open_pr',
        state: 'awaiting_approval',
        proposal_digest: action.digest,
      }),
    ]);
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
      (candidate) =>
        candidate.status === 'blocked' && candidate.nodes.open_pr?.status === 'blocked',
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
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 4821,
            html_url: 'https://github.com/acme/payments/pull/4821',
            url: 'https://api.github.com/repos/acme/payments/pulls/4821',
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 4821,
            html_url: 'https://github.com/acme/payments/pull/4821',
            url: 'https://api.github.com/repos/acme/payments/pulls/4821',
          }),
          { status: 200 },
        ),
      );
    global.fetch = fetchMock as typeof fetch;
    const originalToken = process.env['GITHUB_TOKEN'];
    const originalCredentialRefToken = process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'];
    delete process.env['GITHUB_TOKEN'];
    process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'] = 'runner-token';

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
      credential_ref: github/token
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
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/acme/payments/pulls/4821',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer runner-token',
            'X-GitHub-Api-Version': '2022-11-28',
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
        providerReconciliation: {
          status: 'verified',
          method: 'read_after_write',
          checkedBy: 'vpd.provider_adapter',
          providerReference: 'https://github.com/acme/payments/pull/4821',
          providerUrl: 'https://github.com/acme/payments/pull/4821',
          targetDigest: expect.stringMatching(/^sha256:/),
          payloadDigest: expect.stringMatching(/^sha256:/),
          payload: {
            provider: 'github',
            kind: 'pull_request',
            apiUrl: 'https://api.github.com/repos/acme/payments/pulls/4821',
            htmlUrl: 'https://github.com/acme/payments/pull/4821',
            number: 4821,
          },
        },
      });
    } finally {
      if (originalToken === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = originalToken;
      if (originalCredentialRefToken === undefined)
        delete process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'];
      else process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'] = originalCredentialRefToken;
    }
  });

  it('blocks GitHub provider actions against repositories outside the workflow authority contract', async () => {
    const fetchMock = vi.fn(async () => new Response('should not be called', { status: 500 }));
    global.fetch = fetchMock as typeof fetch;
    const originalToken = process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'];
    process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'] = 'runner-token';

    try {
      const daemon = await setup();
      const workflowPath = path.join(projectDir, 'workflow.yaml');
      await fs.writeFile(
        workflowPath,
        `
schema: viewport.workflow/v1
name: github-authority-proof
nodes:
  open_pr:
    type: action
    adapter: github
    action: create_pr
    idempotencyKey: pr:PAY-1842
    with:
      owner: acme
      repo: out-of-scope
      title: Fix checkout discount normalization
      head: viewport/pay-1842
      base: main
      body: "Generated by Viewport workflow."
      credential_ref: github/token
`,
        'utf-8',
      );

      const run = await daemon.workflowRunner.startRun({
        workflowPath,
        directoryId: DirectoryManager.idFromPath(projectDir),
        initiation: 'cli',
        workflowAuthorityContract: {
          schema_version: 'viewport.workflow_execution_authority/v1',
          digest: 'sha256:authority',
          repos: {
            allowed: ['acme/payments'],
            runner_pool_owns_repo_scope: false,
          },
          side_effects: {
            allowed: [{ provider: 'github', actions: ['create_pr'] }],
          },
        },
      });

      await waitForTerminalRun(daemon, run.id);
      const failed = await daemon.workflowRunner.getRun(run.id);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(failed?.status).toBe('failed');
      expect(failed?.nodes.open_pr?.error).toContain('does not allow repository acme/out-of-scope');
      expect(failed?.nodes.open_pr?.metadata?.node_contract_ack).toMatchObject({
        enforcement: {
          repos: 'contract_guarded',
          side_effects: 'contract_guarded',
          context: 'contract_guarded',
        },
        modeled: ['tools', 'budgets'],
      });
      expect(failed?.events).toContainEqual(
        expect.objectContaining({
          type: 'action-blocked',
          nodeId: 'open_pr',
          data: expect.objectContaining({
            workflow_authority_denial: expect.objectContaining({
              reason: 'repository_not_allowed',
              repository: 'acme/out-of-scope',
              allowed: ['acme/payments'],
            }),
          }),
        }),
      );
    } finally {
      if (originalToken === undefined) delete process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'];
      else process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'] = originalToken;
    }
  });

  it('does not fall back to ambient GitHub credentials when an explicit credential ref is missing', async () => {
    const fetchMock = vi.fn(async () => new Response('should not be called', { status: 500 }));
    global.fetch = fetchMock as typeof fetch;
    const originalToken = process.env['GITHUB_TOKEN'];
    const originalCredentialRefToken = process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'ambient-token';
    delete process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'];

    try {
      const daemon = await setup();
      const workflowPath = path.join(projectDir, 'workflow.yaml');
      await fs.writeFile(
        workflowPath,
        `
schema: viewport.workflow/v1
name: github-explicit-credential-proof
nodes:
  open_pr:
    type: action
    adapter: github
    action: create_pr
    with:
      owner: acme
      repo: payments
      title: Should not run
      head: viewport/pay-1842
      base: main
      credential_ref: github/token
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

      expect(fetchMock).not.toHaveBeenCalled();
      expect(completed?.status).toBe('completed');
      expect(completed?.nodes.open_pr?.metadata?.action).toMatchObject({
        adapter: 'github',
        action: 'create_pr',
        status: 'missing_url',
      });
    } finally {
      if (originalToken === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = originalToken;
      if (originalCredentialRefToken === undefined)
        delete process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'];
      else process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'] = originalCredentialRefToken;
    }
  });

  it('does not use ambient GitHub credentials when provider action omits credential ref', async () => {
    const fetchMock = vi.fn(async () => new Response('should not be called', { status: 500 }));
    global.fetch = fetchMock as typeof fetch;
    const originalToken = process.env['GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'ambient-token';

    try {
      const daemon = await setup();
      const workflowPath = path.join(projectDir, 'workflow.yaml');
      await fs.writeFile(
        workflowPath,
        `
schema: viewport.workflow/v1
name: github-no-credential-ref-proof
nodes:
  comment_issue:
    type: action
    adapter: github
    action: comment_issue
    with:
      owner: acme
      repo: payments
      issue_number: "1842"
      body: "Should not run."
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

      expect(fetchMock).not.toHaveBeenCalled();
      expect(completed?.status).toBe('completed');
      expect(completed?.nodes.comment_issue?.metadata?.action).toMatchObject({
        adapter: 'github',
        action: 'comment_issue',
        status: 'missing_url',
      });
    } finally {
      if (originalToken === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = originalToken;
    }
  });

  it('executes native GitHub issue comments with runner-local credentials', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            html_url: 'https://github.com/acme/payments/issues/1842#issuecomment-42',
            url: 'https://api.github.com/repos/acme/payments/issues/comments/42',
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            html_url: 'https://github.com/acme/payments/issues/1842#issuecomment-42',
            url: 'https://api.github.com/repos/acme/payments/issues/comments/42',
          }),
          { status: 200 },
        ),
      );
    global.fetch = fetchMock as typeof fetch;
    const originalToken = process.env['GITHUB_TOKEN'];
    const originalCredentialRefToken = process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'];
    delete process.env['GITHUB_TOKEN'];
    process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'] = 'runner-token';

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
      credential_ref: github/token
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
        providerReconciliation: {
          status: 'verified',
          method: 'read_after_write',
          providerReference: 'https://github.com/acme/payments/issues/1842#issuecomment-42',
          providerUrl: 'https://github.com/acme/payments/issues/1842#issuecomment-42',
        },
      });
    } finally {
      if (originalToken === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = originalToken;
      if (originalCredentialRefToken === undefined)
        delete process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'];
      else process.env['VIEWPORT_CREDENTIAL_GITHUB_TOKEN'] = originalCredentialRefToken;
    }
  });

  it('executes GitHub pull_request.create with repository shorthand and runner-local credentials', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 42,
            html_url: 'https://github.com/acme/payments/pull/42',
            url: 'https://api.github.com/repos/acme/payments/pulls/42',
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            number: 42,
            html_url: 'https://github.com/acme/payments/pull/42',
            url: 'https://api.github.com/repos/acme/payments/pulls/42',
          }),
          { status: 200 },
        ),
      );
    global.fetch = fetchMock as typeof fetch;
    const originalCredentialRefToken = process.env['VIEWPORT_CREDENTIAL_GITHUB_PR_WRITER'];
    process.env['VIEWPORT_CREDENTIAL_GITHUB_PR_WRITER'] = 'runner-token';

    try {
      const daemon = await setup();
      const workflowPath = path.join(projectDir, 'workflow.yaml');
      await fs.writeFile(
        workflowPath,
        `
schema: viewport.workflow/v1
name: github-pr-alias-proof
nodes:
  open_pr:
    type: action
    adapter: github
    action: pull_request.create
    idempotencyKey: pr-alias:PAY-1842
    with:
      repository: acme/payments
      title: Viewport support fix
      head: viewport/pay-1842
      base: main
      body: "Tests are passing."
      credential_ref: github/pr-writer
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
            'Idempotency-Key': 'pr-alias:PAY-1842',
          }),
        }),
      );
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        title: 'Viewport support fix',
        head: 'viewport/pay-1842',
        base: 'main',
        body: 'Tests are passing.',
      });
      expect(completed?.status).toBe('completed');
      expect(completed?.nodes.open_pr?.metadata?.action).toMatchObject({
        adapter: 'github',
        action: 'pull_request.create',
        status: 'executed',
        response: {
          status: 201,
          htmlUrl: 'https://github.com/acme/payments/pull/42',
          number: 42,
        },
      });
    } finally {
      if (originalCredentialRefToken === undefined)
        delete process.env['VIEWPORT_CREDENTIAL_GITHUB_PR_WRITER'];
      else process.env['VIEWPORT_CREDENTIAL_GITHUB_PR_WRITER'] = originalCredentialRefToken;
    }
  });

  it('executes native Jira comments and transitions with runner-local credentials', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://acme.atlassian.net/rest/api/3/issue/PAY-1842/comment') {
        expect(init?.method).toBe('POST');
        return new Response(
          JSON.stringify({
            id: '10042',
            self: 'https://acme.atlassian.net/rest/api/3/issue/PAY-1842/comment/10042',
          }),
          { status: 201 },
        );
      }
      if (url === 'https://acme.atlassian.net/rest/api/3/issue/PAY-1842/comment/10042') {
        expect(init?.method).toBe('GET');
        return new Response(
          JSON.stringify({
            id: '10042',
            self: 'https://acme.atlassian.net/rest/api/3/issue/PAY-1842/comment/10042',
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: 'transition-response' }), { status: 201 });
    });
    global.fetch = fetchMock as typeof fetch;
    const originalBaseUrl = process.env['JIRA_BASE_URL'];
    const originalToken = process.env['JIRA_API_TOKEN'];
    const originalCredentialRefToken = process.env['VIEWPORT_CREDENTIAL_JIRA_TOKEN'];
    const originalEmail = process.env['JIRA_EMAIL'];
    process.env['JIRA_BASE_URL'] = 'https://acme.atlassian.net';
    delete process.env['JIRA_API_TOKEN'];
    process.env['VIEWPORT_CREDENTIAL_JIRA_TOKEN'] = 'jira-token';
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
      credential_ref: jira/token
  transition:
    type: action
    adapter: jira
    action: issue.transition
    idempotencyKey: jira-transition:PAY-1842
    needs: [comment]
    with:
      issue_key: PAY-1842
      transition_id: "31"
      credential_ref: jira/token
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
        providerReconciliation: {
          status: 'verified',
          method: 'read_after_write',
          providerReference: '10042',
          providerUrl: 'https://acme.atlassian.net/rest/api/3/issue/PAY-1842/comment/10042',
        },
      });
      expect(completed?.nodes.transition?.metadata?.action).toMatchObject({
        adapter: 'jira',
        action: 'issue.transition',
        idempotencyKey: 'jira-transition:PAY-1842',
        status: 'executed',
        providerReconciliation: {
          status: 'not_checked',
          method: 'not_supported',
          checkedBy: 'vpd.provider_adapter',
        },
      });
    } finally {
      if (originalBaseUrl === undefined) delete process.env['JIRA_BASE_URL'];
      else process.env['JIRA_BASE_URL'] = originalBaseUrl;
      if (originalToken === undefined) delete process.env['JIRA_API_TOKEN'];
      else process.env['JIRA_API_TOKEN'] = originalToken;
      if (originalCredentialRefToken === undefined)
        delete process.env['VIEWPORT_CREDENTIAL_JIRA_TOKEN'];
      else process.env['VIEWPORT_CREDENTIAL_JIRA_TOKEN'] = originalCredentialRefToken;
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
        new Response(
          JSON.stringify({
            ok: true,
            permalink: 'https://acme.slack.com/archives/C123/p1770000001',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }),
      );
    global.fetch = fetchMock as typeof fetch;
    const originalToken = process.env['SLACK_BOT_TOKEN'];
    const originalCredentialRefToken = process.env['VIEWPORT_CREDENTIAL_SLACK_BOT_TOKEN'];
    delete process.env['SLACK_BOT_TOKEN'];
    process.env['VIEWPORT_CREDENTIAL_SLACK_BOT_TOKEN'] = 'slack-token';

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
      credential_ref: slack/bot-token
  fail_slack:
    type: action
    adapter: slack
    action: post_message
    needs: [announce]
    idempotencyKey: slack-fail:PAY-1842
    retry:
      maxAttempts: 2
      transient: [channel_not_found]
    with:
      channel: missing
      text: "This should fail."
      credential_ref: slack/bot-token
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
        providerReconciliation: {
          status: 'verified',
          method: 'read_after_write',
          providerReference: 'C123:177000.0001',
          providerUrl: 'https://acme.slack.com/archives/C123/p1770000001',
        },
      });
      expect(failed?.nodes.fail_slack?.metadata?.action).toMatchObject({
        adapter: 'slack',
        action: 'post_message',
        idempotencyKey: 'slack-fail:PAY-1842',
        status: 'failed',
        response: { error: 'channel_not_found' },
        recovery: {
          state: 'dead_letter',
          attempts: 2,
          retryableByRerun: true,
          idempotencyKey: 'slack-fail:PAY-1842',
        },
      });
      expect(failed?.events).toContainEqual(
        expect.objectContaining({
          type: 'action-dead-letter',
          nodeId: 'fail_slack',
        }),
      );
    } finally {
      if (originalToken === undefined) delete process.env['SLACK_BOT_TOKEN'];
      else process.env['SLACK_BOT_TOKEN'] = originalToken;
      if (originalCredentialRefToken === undefined)
        delete process.env['VIEWPORT_CREDENTIAL_SLACK_BOT_TOKEN'];
      else process.env['VIEWPORT_CREDENTIAL_SLACK_BOT_TOKEN'] = originalCredentialRefToken;
    }
  });

  it('executes Slack messages to the source thread when channel is omitted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, channel: 'C123', ts: '177000.0002' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            permalink: 'https://acme.slack.com/archives/C123/p1770000002',
          }),
          { status: 200 },
        ),
      );
    global.fetch = fetchMock as typeof fetch;
    const originalCredentialRefToken = process.env['VIEWPORT_CREDENTIAL_SLACK_NOTIFIER'];
    process.env['VIEWPORT_CREDENTIAL_SLACK_NOTIFIER'] = 'slack-token';

    try {
      const daemon = await setup();
      const workflowPath = path.join(projectDir, 'workflow.yaml');
      await fs.writeFile(
        workflowPath,
        `
schema: viewport.workflow/v1
name: slack-source-thread-proof
nodes:
  announce:
    type: action
    adapter: slack
    action: post_message
    idempotencyKey: slack-source-thread:PAY-1842
    with:
      text: "Viewport finished the approved support run."
      credential_ref: slack/notifier
`,
        'utf-8',
      );

      const run = await daemon.workflowRunner.startRun({
        workflowPath,
        directoryId: DirectoryManager.idFromPath(projectDir),
        inputs: {
          integration_event: {
            payload: {
              event: {
                channel: 'C123',
                ts: '177000.0001',
              },
            },
          },
        },
        initiation: 'cli',
      });

      await waitForTerminalRun(daemon, run.id);
      const completed = await daemon.workflowRunner.getRun(run.id);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://slack.com/api/chat.postMessage',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer slack-token',
            'Idempotency-Key': 'slack-source-thread:PAY-1842',
          }),
        }),
      );
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        channel: 'C123',
        thread_ts: '177000.0001',
        client_msg_id: 'slack-source-thread:PAY-1842',
        text: 'Viewport finished the approved support run.',
      });
      expect(completed?.status).toBe('completed');
      expect(completed?.nodes.announce?.metadata?.action).toMatchObject({
        adapter: 'slack',
        action: 'post_message',
        idempotencyKey: 'slack-source-thread:PAY-1842',
        status: 'executed',
        response: { channel: 'C123', ts: '177000.0002' },
      });
    } finally {
      if (originalCredentialRefToken === undefined)
        delete process.env['VIEWPORT_CREDENTIAL_SLACK_NOTIFIER'];
      else process.env['VIEWPORT_CREDENTIAL_SLACK_NOTIFIER'] = originalCredentialRefToken;
    }
  });
});
