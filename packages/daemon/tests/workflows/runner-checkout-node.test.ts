import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitForTerminalRun } from './support/workflow-runner-support.js';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';

describe('workflow runner checkout node', () => {
  let root: string;
  let tempHome: string;
  let projectDir: string;
  let remoteDir: string;
  let originalHome: string | undefined;
  let originalCodexHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env['HOME'];
    originalCodexHome = process.env['CODEX_HOME'];
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-checkout-home-'));
    process.env['HOME'] = tempHome;
    process.env['CODEX_HOME'] = path.join(tempHome, '.codex');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-checkout-node-'));
    projectDir = path.join(root, 'project');
    remoteDir = path.join(root, 'remote');
    await fs.mkdir(projectDir, { recursive: true });
    await createGitRepository(remoteDir);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = originalCodexHome;
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  it('checks out an authorized repository into a governed run worktree path with built-in outputs', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: checkout-authorized-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
    branch: viewport/proof
  inspect:
    type: shell
    needs: [repo]
    cwd: "{{ nodes.repo.outputs.path }}"
    command: "test -f README.md && printf checked-out"
`,
      'utf8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      workflowAuthorityContract: {
        schema_version: 'viewport.workflow_execution_authority/v1',
        digest: 'sha256:authority',
        repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
        side_effects: { allowed: [] },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.repo?.worktreePath).toContain(path.join('.viewport', 'checkouts'));
    expect(completed?.nodes.repo?.outputs).toMatchObject({
      repository: 'acme/payments',
      branch: 'viewport/proof',
    });
    expect(completed?.nodes.repo?.metadata?.checkout).toMatchObject({
      schema: 'viewport.checkout_receipt/v1',
      repository: 'acme/payments',
      branch: 'viewport/proof',
    });
    expect(completed?.nodes.inspect?.output).toContain('checked-out');
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'checkout-completed',
        nodeId: 'repo',
        data: expect.objectContaining({
          repository: 'acme/payments',
          branch: 'viewport/proof',
        }),
      }),
    );
  });

  it('blocks checkout before git when the remote repo does not match the declared repository', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: checkout-remote-mismatch-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: https://github.com/acme/forbidden.git
`,
      'utf8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      workflowAuthorityContract: {
        schema_version: 'viewport.workflow_execution_authority/v1',
        digest: 'sha256:authority',
        repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.repo?.error).toContain('remote references repository acme/forbidden');
    expect(failed?.events).toContainEqual(
      expect.objectContaining({
        type: 'checkout-blocked',
        nodeId: 'repo',
        data: expect.objectContaining({
          workflow_authority_denial: expect.objectContaining({
            reason: 'repository_not_allowed',
            repository: 'acme/forbidden',
            allowed: ['acme/payments'],
          }),
        }),
      }),
    );
  });

  it('blocks checkout before git when the destination path escapes the run worktree', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: checkout-path-escape-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
    path: ../outside
`,
      'utf8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      workflowAuthorityContract: {
        schema_version: 'viewport.workflow_execution_authority/v1',
        digest: 'sha256:authority',
        repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.repo?.error).toContain('outside the run worktree');
    expect(failed?.events).toContainEqual(
      expect.objectContaining({
        type: 'checkout-blocked',
        nodeId: 'repo',
        data: expect.objectContaining({
          workflow_authority_denial: expect.objectContaining({
            reason: 'checkout_path_outside_run_worktree',
            repository: 'acme/payments',
          }),
        }),
      }),
    );
  });

  it('fails closed when run-scoped checkout credential material is missing', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: checkout-missing-grant-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
    credentialMode: run_scoped_grant
    credentialRef: repo/github/payments-api
`,
      'utf8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      workflowAuthorityContract: {
        schema_version: 'viewport.workflow_execution_authority/v1',
        digest: 'sha256:authority',
        repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.repo?.error).toContain('Run-scoped checkout grant repo/github/payments-api was not materialized');
    expect(JSON.stringify(failed)).not.toContain('ghs_run_scoped_checkout');
  });

  it('uses materialized run-scoped checkout credential without persisting the secret', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: checkout-run-scoped-grant-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
    credentialMode: run_scoped_grant
    credentialRef: repo/github/payments-api
`,
      'utf8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      runtimeSecretEnv: {
        VIEWPORT_CREDENTIAL_REPO_GITHUB_PAYMENTS_API: 'ghs_run_scoped_checkout',
      },
      workflowAuthorityContract: {
        schema_version: 'viewport.workflow_execution_authority/v1',
        digest: 'sha256:authority',
        repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.repo?.metadata?.checkout).toMatchObject({
      schema: 'viewport.checkout_receipt/v1',
      repository: 'acme/payments',
      credentialMode: 'run_scoped_grant',
      credentialRef: 'repo/github/payments-api',
    });
    expect(JSON.stringify(completed)).not.toContain('ghs_run_scoped_checkout');
  });

  it('blocks checkout before git when the repository is outside workflow authority', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: checkout-denial-proof
nodes:
  repo:
    type: checkout
    repository: acme/forbidden
    remote: ${JSON.stringify(remoteDir)}
`,
      'utf8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      workflowAuthorityContract: {
        schema_version: 'viewport.workflow_execution_authority/v1',
        digest: 'sha256:authority',
        repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
        side_effects: { allowed: [] },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.repo?.error).toContain('repository acme/forbidden');
    expect(failed?.events).toContainEqual(
      expect.objectContaining({
        type: 'checkout-blocked',
        nodeId: 'repo',
        data: expect.objectContaining({
          workflow_authority_denial: expect.objectContaining({
            reason: 'repository_not_allowed',
            repository: 'acme/forbidden',
            allowed: ['acme/payments'],
          }),
        }),
      }),
    );
  });
});

async function setup(projectDir: string) {
  const daemon = new Daemon();
  await daemon.initialize();
  await daemon.directoryManager.register(projectDir);
  return daemon;
}

async function createGitRepository(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'README.md'), 'checkout proof\n', 'utf8');
  await runGit(['init'], dir);
  await runGit(['config', 'user.email', 'proof@example.test'], dir);
  await runGit(['config', 'user.name', 'Viewport Proof'], dir);
  await runGit(['add', 'README.md'], dir);
  await runGit(['commit', '-m', 'proof'], dir);
}

async function runGit(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} failed with ${code}`));
    });
  });
}
