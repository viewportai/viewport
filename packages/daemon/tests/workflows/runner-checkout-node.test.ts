import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MockAdapter,
  waitForNodeSession,
  waitForTerminalRun,
} from './support/workflow-runner-support.js';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import { envNameForCredentialRef } from '../../src/workflows/action-provider-utils.js';
import { executeCheckoutNode } from '../../src/workflows/checkout-node.js';
import type { WorkflowRunRecord } from '../../src/workflows/types.js';

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
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.repo?.worktreePath).toContain(
      path.join('.viewport', 'workspace', 'runs', run.id, 'repos', 'operating'),
    );
    expect(completed?.nodes.repo?.outputs).toMatchObject({
      repository: 'acme/payments',
      branch: 'viewport/proof',
      sourceCategory: 'operating_repo',
      readWriteMode: 'read_write',
    });
    expect(completed?.nodes.repo?.metadata?.checkout).toMatchObject({
      schema: 'viewport.checkout_receipt/v1',
      repository: 'acme/payments',
      path: completed?.nodes.repo?.worktreePath,
      source_category: 'operating_repo',
      read_write_mode: 'read_write',
      requested_ref: null,
      requested_branch: 'viewport/proof',
      branch: 'viewport/proof',
      exact_commit: expect.stringMatching(/^[0-9a-f]{40}$/),
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

  it('reuses an existing run-scoped checkout worktree when a worker retries the same run', async () => {
    const run = checkoutRunRecord(projectDir, 'retry-run-1');
    const node = {
      id: 'repo',
      type: 'checkout' as const,
      title: 'Checkout',
      repository: 'acme/payments',
      remote: remoteDir,
      branch: 'viewport/retry-proof',
    };

    const first = await executeCheckoutNode(run, node);
    const second = await executeCheckoutNode(run, node);

    expect(second.path).toBe(first.path);
    expect(second.commit).toBe(first.commit);
    await expect(fs.access(path.join(second.path, 'README.md'))).resolves.toBeUndefined();
  });

  it('uses a run-scoped default checkout path so repeated runs do not collide', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: checkout-run-scoped-path-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
  inspect:
    type: shell
    needs: [repo]
    cwd: "{{ nodes.repo.outputs.path }}"
    command: "test -f README.md && printf checked-out"
`,
      'utf8',
    );

    const first = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      workflowAuthorityContract: {
        schema_version: 'viewport.workflow_execution_authority/v1',
        digest: 'sha256:authority',
        repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
        side_effects: { allowed: [] },
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });
    const second = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      workflowAuthorityContract: {
        schema_version: 'viewport.workflow_execution_authority/v1',
        digest: 'sha256:authority',
        repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
        side_effects: { allowed: [] },
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForTerminalRun(daemon, first.id);
    await waitForTerminalRun(daemon, second.id);
    const completedFirst = await daemon.workflowRunner.getRun(first.id);
    const completedSecond = await daemon.workflowRunner.getRun(second.id);

    expect(completedFirst?.status).toBe('completed');
    expect(completedSecond?.status).toBe('completed');
    expect(completedFirst?.nodes.repo?.outputs?.['path']).toContain(first.id);
    expect(completedSecond?.nodes.repo?.outputs?.['path']).toContain(second.id);
    expect(completedFirst?.nodes.repo?.outputs?.['path']).not.toEqual(
      completedSecond?.nodes.repo?.outputs?.['path'],
    );
  });

  it('renders checkout repository and branch expressions before authority checks and git clone', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: checkout-rendered-proof
inputs:
  repo:
    type: string
    default: acme/payments
  branch:
    type: string
    default: viewport/rendered
nodes:
  repo:
    type: checkout
    repository: "{{ inputs.repo }}"
    remote: ${JSON.stringify(remoteDir)}
    branch: "{{ inputs.branch }}"
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
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.repo?.outputs).toMatchObject({
      repository: 'acme/payments',
      branch: 'viewport/rendered',
    });
    expect(completed?.nodes.repo?.error).toBeUndefined();
  });

  it('keeps checkout pinned to an exact commit when the source branch moves', async () => {
    const firstCommit = await gitOutput(['rev-parse', 'HEAD'], remoteDir);
    await fs.writeFile(path.join(remoteDir, 'README.md'), 'checkout proof advanced\n', 'utf8');
    await runGit(['add', 'README.md'], remoteDir);
    await runGit(['commit', '-m', 'advance branch'], remoteDir);
    const latestCommit = await gitOutput(['rev-parse', 'HEAD'], remoteDir);
    expect(latestCommit).not.toBe(firstCommit);

    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: checkout-pinned-commit-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
    ref: ${firstCommit}
    branch: viewport/proof
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
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.repo?.outputs).toMatchObject({
      ref: firstCommit,
      branch: 'viewport/proof',
      commit: firstCommit,
    });
    expect(completed?.nodes.repo?.metadata?.checkout).toMatchObject({
      schema: 'viewport.checkout_receipt/v1',
      requested_ref: firstCommit,
      requested_branch: 'viewport/proof',
      exact_commit: firstCommit,
      commit: firstCommit,
    });
    expect(completed?.nodes.repo?.metadata?.checkout).not.toMatchObject({
      exact_commit: latestCommit,
    });
  });

  it('runs prompt implementation nodes inside the governed checkout cwd when configured', async () => {
    const daemon = await setup(projectDir);
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: checkout-prompt-cwd-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
    branch: viewport/proof
  implement:
    type: prompt
    needs: [repo]
    cwd: "{{ nodes.repo.outputs.path }}"
    prompt: "Create src/proof.ts in the governed checkout."
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
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForNodeSession(daemon, run.id, 'implement');
    expect(adapter.lastSession).not.toBeNull();
    const active = await daemon.workflowRunner.getRun(run.id);
    const checkoutPath = active?.nodes.repo?.outputs?.['path'];
    expect(checkoutPath).toEqual(expect.any(String));
    expect(adapter.cwdBySession.get(adapter.lastSession!)).toBe(checkoutPath);
    expect(adapter.lastOptions?.config).toMatchObject({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      trust: 'automated',
    });
    adapter.lastSession?.emitAgentMessage('done');
    adapter.lastSession?.simulateIdle();
    await waitForTerminalRun(daemon, run.id);
  });

  it('fails prompt implementation nodes that do not produce required files', async () => {
    const daemon = await setup(projectDir);
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: checkout-prompt-required-files-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
    branch: viewport/proof
  implement:
    type: prompt
    needs: [repo]
    cwd: "{{ nodes.repo.outputs.path }}"
    requiredFiles:
      - src/proof.ts
      - src/proof.test.ts
    prompt: "Create the required proof files."
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
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForNodeSession(daemon, run.id, 'implement');
    adapter.lastSession?.emitAgentMessage('I could not write the files.');
    adapter.lastSession?.simulateIdle();
    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.implement?.error).toContain(
      'missing required file(s): src/proof.ts, src/proof.test.ts',
    );
    expect(failed?.events).toContainEqual(
      expect.objectContaining({
        type: 'node-failed',
        nodeId: 'implement',
        data: expect.objectContaining({
          missing: ['src/proof.ts', 'src/proof.test.ts'],
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
    expect(failed?.nodes.repo?.error).toContain(
      'Run-scoped checkout grant repo/github/payments-api was not materialized',
    );
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
        [envNameForCredentialRef('repo/github/payments-api')]: 'ghs_run_scoped_checkout',
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
      source_category: 'operating_repo',
      read_write_mode: 'read_write',
      exact_commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      credentialMode: 'run_scoped_grant',
      credentialRef: 'repo/github/payments-api',
    });
    expect(JSON.stringify(completed)).not.toContain('ghs_run_scoped_checkout');
  });

  it('blocks publishing context update target files into the operating repo when the target is a different repo', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: checkout-context-target-wrong-repo-proof
context:
  update_targets:
    - ref: git://acme/payments-docs/docs/context/
      kind: repo_pr
      name: Payments support context
      approval: required
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
  accidental_context_write:
    type: shell
    needs: [repo]
    cwd: "{{ nodes.repo.outputs.path }}"
    command: "mkdir -p docs/context && printf wrong-repo > docs/context/payment-risk-rules.md"
  publish:
    type: git_publish
    needs: [accidental_context_write]
    repository: acme/payments
    cwd: "{{ nodes.repo.outputs.path }}"
    branch: viewport/proof
    message: "Attempt wrong repo context update"
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
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.publish?.error).toContain(
      'belongs to context update target acme/payments-docs/docs/context/',
    );
    expect(failed?.events).toContainEqual(
      expect.objectContaining({
        type: 'git-publish-blocked',
        nodeId: 'publish',
        data: expect.objectContaining({
          workflow_authority_denial: expect.objectContaining({
            reason: 'context_update_target_wrong_repository',
            repository: 'acme/payments',
          }),
        }),
      }),
    );
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
        shell: { policy: 'constrained', allow_legacy_command: true },
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

function checkoutRunRecord(projectDir: string, runId: string): WorkflowRunRecord {
  return {
    id: runId,
    workflowName: 'checkout-retry-proof',
    workflowTitle: 'Checkout retry proof',
    sourceType: 'viewport_snapshot',
    digest: 'sha256:run',
    schema: 'viewport.workflow/v1',
    yamlSnapshot: 'schema: viewport.workflow/v1\nname: checkout-retry-proof\nnodes: {}\n',
    directoryId: DirectoryManager.idFromPath(projectDir),
    directoryPath: projectDir,
    machineId: 'machine-1',
    initiation: 'cli',
    status: 'running',
    inputs: {},
    preflight: { ok: true, issues: [] },
    workflowAuthorityContract: {
      schema_version: 'viewport.workflow_execution_authority/v1',
      digest: 'sha256:authority',
      repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
    },
    nodes: {},
    artifacts: [],
    events: [],
    createdAt: 1_000,
    updatedAt: 1_000,
  };
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

async function gitOutput(args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8').trim());
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(detail || `git ${args.join(' ')} failed with ${code}`));
    });
  });
}
