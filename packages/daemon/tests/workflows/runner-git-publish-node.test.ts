import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitForTerminalRun } from './support/workflow-runner-support.js';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';

describe('workflow runner git publish node', () => {
  let root: string;
  let tempHome: string;
  let projectDir: string;
  let remoteDir: string;
  let originalHome: string | undefined;
  let originalCodexHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env['HOME'];
    originalCodexHome = process.env['CODEX_HOME'];
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-publish-home-'));
    process.env['HOME'] = tempHome;
    process.env['CODEX_HOME'] = path.join(tempHome, '.codex');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-publish-node-'));
    projectDir = path.join(root, 'project');
    remoteDir = path.join(root, 'remote.git');
    await fs.mkdir(projectDir, { recursive: true });
    await createBareRemote(remoteDir, path.join(root, 'seed'));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = originalCodexHome;
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  it('commits and pushes an authorized branch from a governed checkout', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: git-publish-proof
inputs:
  repo:
    type: string
    default: acme/payments
nodes:
  repo:
    type: checkout
    repository: "{{ inputs.repo }}"
    remote: ${JSON.stringify(remoteDir)}
  edit:
    type: shell
    needs: [repo]
    cwd: "{{ nodes.repo.outputs.path }}"
    command: "printf '\\nproof change\\n' >> README.md"
  publish:
    type: git_publish
    needs: [edit]
    repository: "{{ inputs.repo }}"
    cwd: "{{ nodes.repo.outputs.path }}"
    branch: viewport/proof
    message: Publish proof update
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
    const completed = await daemon.workflowRunner.getRun(run.id);
    const pushedCommit = await runGit(
      ['--git-dir', remoteDir, 'rev-parse', 'refs/heads/viewport/proof'],
      root,
    );

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.publish?.outputs).toMatchObject({
      repository: 'acme/payments',
      branch: 'viewport/proof',
      pushed: true,
      changed: true,
    });
    expect(completed?.nodes.publish?.metadata?.git_publish).toMatchObject({
      schema: 'viewport.git_publish_receipt/v1',
      repository: 'acme/payments',
      branch: 'viewport/proof',
      pushed: true,
      credentialMode: 'runner_local',
    });
    expect(completed?.nodes.publish?.outputs?.commit).toBe(pushedCommit.trim());
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'git-publish-completed',
        nodeId: 'publish',
        data: expect.objectContaining({ repository: 'acme/payments', branch: 'viewport/proof' }),
      }),
    );
  });

  it('blocks branch publish before commit or push when the repository is outside authority', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: git-publish-denial-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
  publish:
    type: git_publish
    needs: [repo]
    repository: acme/forbidden
    cwd: "{{ nodes.repo.outputs.path }}"
    branch: viewport/proof
    message: Publish proof update
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
    expect(failed?.events).toContainEqual(
      expect.objectContaining({
        type: 'git-publish-blocked',
        nodeId: 'publish',
        data: expect.objectContaining({
          workflow_authority_denial: expect.objectContaining({
            reason: 'repository_not_allowed',
            repository: 'acme/forbidden',
          }),
        }),
      }),
    );
  });

  it('fails closed when run-scoped grant delivery is requested but unavailable', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: git-publish-run-scoped-grant-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
  publish:
    type: git_publish
    needs: [repo]
    repository: acme/payments
    cwd: "{{ nodes.repo.outputs.path }}"
    branch: viewport/proof
    message: Publish proof update
    credentialMode: run_scoped_grant
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
    expect(failed?.events).toContainEqual(
      expect.objectContaining({
        type: 'git-publish-blocked',
        nodeId: 'publish',
        data: expect.objectContaining({
          workflow_authority_denial: expect.objectContaining({
            reason: 'git_publish_run_scoped_grant_unavailable',
          }),
        }),
      }),
    );
  });

  it('fails closed when run-scoped git publish credential material is missing', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: git-publish-missing-material-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
  edit:
    type: shell
    needs: [repo]
    cwd: "{{ nodes.repo.outputs.path }}"
    command: "printf '\\nproof change\\n' >> README.md"
  publish:
    type: git_publish
    needs: [edit]
    repository: acme/payments
    cwd: "{{ nodes.repo.outputs.path }}"
    branch: viewport/proof
    message: Publish proof update
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
    expect(failed?.nodes.publish?.error).toContain(
      'Run-scoped git publish grant repo/github/payments-api was not materialized',
    );
    expect(JSON.stringify(failed)).not.toContain('ghs_run_scoped_push');
  });

  it('uses materialized run-scoped git publish credential without persisting the secret', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: git-publish-materialized-grant-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
  edit:
    type: shell
    needs: [repo]
    cwd: "{{ nodes.repo.outputs.path }}"
    command: "printf '\\nproof change\\n' >> README.md"
  publish:
    type: git_publish
    needs: [edit]
    repository: acme/payments
    cwd: "{{ nodes.repo.outputs.path }}"
    branch: viewport/proof
    message: Publish proof update
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
        VIEWPORT_CREDENTIAL_REPO_GITHUB_PAYMENTS_API: 'ghs_run_scoped_push',
      },
      workflowAuthorityContract: {
        schema_version: 'viewport.workflow_execution_authority/v1',
        digest: 'sha256:authority',
        repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);
    const pushedCommit = await runGit(
      ['--git-dir', remoteDir, 'rev-parse', 'refs/heads/viewport/proof'],
      root,
    );

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.publish?.metadata?.git_publish).toMatchObject({
      schema: 'viewport.git_publish_receipt/v1',
      repository: 'acme/payments',
      branch: 'viewport/proof',
      credentialMode: 'run_scoped_grant',
      credentialRef: 'repo/github/payments-api',
    });
    expect(completed?.nodes.publish?.outputs?.commit).toBe(pushedCommit.trim());
    expect(JSON.stringify(completed)).not.toContain('ghs_run_scoped_push');
  });
});

async function setup(projectDir: string) {
  const daemon = new Daemon();
  await daemon.initialize();
  await daemon.directoryManager.register(projectDir);
  return daemon;
}

async function createBareRemote(remote: string, seed: string): Promise<void> {
  await fs.mkdir(seed, { recursive: true });
  await fs.writeFile(path.join(seed, 'README.md'), 'publish proof\n', 'utf8');
  await runGit(['init'], seed);
  await runGit(['config', 'user.email', 'proof@example.test'], seed);
  await runGit(['config', 'user.name', 'Viewport Proof'], seed);
  await runGit(['add', 'README.md'], seed);
  await runGit(['commit', '-m', 'proof'], seed);
  await runGit(['init', '--bare', remote], path.dirname(remote));
  await runGit(['remote', 'add', 'origin', remote], seed);
  await runGit(['push', 'origin', 'HEAD:main'], seed);
}

async function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else
        reject(
          new Error(
            Buffer.concat(stderr).toString('utf8') || `git ${args.join(' ')} failed with ${code}`,
          ),
        );
    });
  });
}
