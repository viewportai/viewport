import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitForTerminalRun } from './support/workflow-runner-support.js';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import { envNameForCredentialRef } from '../../src/workflows/action-provider-utils.js';

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
  }, 30_000);

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = originalCodexHome;
    await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
        shell: { policy: 'constrained', allow_legacy_command: true },
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
  }, 60_000);

  it('skips dynamic pre-publish review when observable diff facts do not match', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: git-publish-dynamic-review-skip-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
  edit:
    type: shell
    needs: [repo]
    cwd: "{{ nodes.repo.outputs.path }}"
    command: "printf '\\nsmall docs change\\n' >> README.md"
  publish:
    type: git_publish
    needs: [edit]
    repository: acme/payments
    cwd: "{{ nodes.repo.outputs.path }}"
    branch: viewport/proof
    message: Publish proof update
    prePublishReview:
      rules:
        - name: sensitive-path
          when:
            changed_paths_any: ["src/payments/**"]
          require: human(tech-lead)
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
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.publish?.metadata?.pre_publish_review).toMatchObject({
      schema: 'viewport.pre_publish_review/v1',
      required: false,
      facts: expect.objectContaining({
        changedPaths: ['README.md'],
      }),
      matched_rules: [],
    });
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'pre-publish-review-skipped',
        nodeId: 'publish',
      }),
    );
  }, 60_000);

  it('blocks dynamic pre-publish review from observable diff facts, then resumes after approval', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: git-publish-dynamic-review-block-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
  edit:
    type: shell
    needs: [repo]
    cwd: "{{ nodes.repo.outputs.path }}"
    command: "mkdir -p src/payments && printf 'export const payment = true;\\n' > src/payments/new-rule.ts && printf 'agent says this is trivial\\n' > agent-self-report.txt"
  publish:
    type: git_publish
    needs: [edit]
    repository: acme/payments
    cwd: "{{ nodes.repo.outputs.path }}"
    branch: viewport/proof
    message: Publish proof update
    prePublishReview:
      rules:
        - name: sensitive-path
          when:
            changed_paths_any: ["src/payments/**"]
          require: human(tech-lead)
          timeout: 4h
          on_timeout: escalate
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
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const blocked = await daemon.workflowRunner.getRun(run.id);

    expect(blocked?.status, blocked?.error).toBe('blocked');
    expect(blocked?.nodes.publish?.status).toBe('blocked');
    expect(blocked?.nodes.publish?.metadata?.pre_publish_review).toMatchObject({
      schema: 'viewport.pre_publish_review/v1',
      required: true,
      facts: expect.objectContaining({
        changedPaths: expect.arrayContaining(['src/payments/new-rule.ts']),
      }),
      matched_rules: [
        expect.objectContaining({
          name: 'sensitive-path',
          reason: 'changed_paths_any',
          reviewerTags: ['tech-lead'],
        }),
      ],
    });
    await expect(
      runGit(['--git-dir', remoteDir, 'rev-parse', 'refs/heads/viewport/proof'], root),
    ).rejects.toThrow();

    await daemon.workflowRunner.decideApproval(run.id, 'publish', {
      approved: true,
      actor: { id: 'user-1', name: 'Tech Lead' },
      message: 'Approved from dynamic review test',
    });
    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);
    const pushedCommit = await runGit(
      ['--git-dir', remoteDir, 'rev-parse', 'refs/heads/viewport/proof'],
      root,
    );

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.publish?.outputs?.commit).toBe(pushedCommit.trim());
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'approval-resolved',
        nodeId: 'publish',
      }),
    );
  }, 60_000);

  it('re-blocks dynamic pre-publish review when the diff changes after approval', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: git-publish-dynamic-review-toctou-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
  edit:
    type: shell
    needs: [repo]
    cwd: "{{ nodes.repo.outputs.path }}"
    command: "mkdir -p src/payments && printf 'export const payment = true;\\n' > src/payments/new-rule.ts"
  publish:
    type: git_publish
    needs: [edit]
    repository: acme/payments
    cwd: "{{ nodes.repo.outputs.path }}"
    branch: viewport/proof
    message: Publish proof update
    prePublishReview:
      rules:
        - name: sensitive-path
          when:
            changed_paths_any: ["src/payments/**"]
          require: human(tech-lead)
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
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const blocked = await daemon.workflowRunner.getRun(run.id);
    const repoPath = blocked?.nodes.repo?.outputs?.path;
    const originalDiffDigest = prePublishReviewDiffDigest(blocked?.nodes.publish?.metadata);

    expect(blocked?.status).toBe('blocked');
    expect(typeof repoPath).toBe('string');
    expect(originalDiffDigest).toMatch(/^sha256:/);
    await fs.mkdir(path.join(repoPath as string, 'docs'), { recursive: true });
    await fs.writeFile(
      path.join(repoPath as string, 'docs', 'late-mutation.md'),
      'changed after approval request\n',
      'utf8',
    );

    const originalApprovalCommand = {
      runtime_commands: [
        {
          id: 'approval-command-original-diff',
          type: 'workflow.approval_decision',
          workflow_run_id: run.id,
          workflow_node_id: 'publish',
          approved: true,
          decision: 'approve',
          message: 'Approve the original diff',
          expected_action_digest: originalDiffDigest,
          actor: { id: 'user-1', name: 'Tech Lead', source: 'platform' },
        },
      ],
    };

    expect(await daemon.workflowRunner.applyRuntimeCommandBody(run.id, originalApprovalCommand)).toBe(
      1,
    );

    await waitForTerminalRun(daemon, run.id);
    const reblocked = await daemon.workflowRunner.getRun(run.id);

    expect(reblocked?.status, reblocked?.error).toBe('blocked');
    expect(reblocked?.nodes.publish?.status).toBe('blocked');
    expect(reblocked?.nodes.publish?.metadata?.pre_publish_review).toMatchObject({
      required: true,
      invalidated_approval: expect.objectContaining({
        reason: 'diff_changed_after_approval',
      }),
    });
    const changedDiffDigest = prePublishReviewDiffDigest(reblocked?.nodes.publish?.metadata);
    expect(changedDiffDigest).toMatch(/^sha256:/);
    expect(changedDiffDigest).not.toBe(originalDiffDigest);
    expect(reblocked?.events).toContainEqual(
      expect.objectContaining({
        type: 'pre-publish-review-invalidated',
        nodeId: 'publish',
      }),
    );
    await expect(
      runGit(['--git-dir', remoteDir, 'rev-parse', 'refs/heads/viewport/proof'], root),
    ).rejects.toThrow();

    expect(await daemon.workflowRunner.applyRuntimeCommandBody(run.id, originalApprovalCommand)).toBe(
      1,
    );
    await waitForTerminalRun(daemon, run.id);
    const stillReblocked = await daemon.workflowRunner.getRun(run.id);

    expect(stillReblocked?.status, stillReblocked?.error).toBe('blocked');
    expect(stillReblocked?.nodes.publish?.status).toBe('blocked');
    await expect(
      runGit(['--git-dir', remoteDir, 'rev-parse', 'refs/heads/viewport/proof'], root),
    ).rejects.toThrow();

    expect(
      await daemon.workflowRunner.applyRuntimeCommandBody(run.id, {
        runtime_commands: [
          {
            id: 'approval-command-changed-diff',
            type: 'workflow.approval_decision',
            workflow_run_id: run.id,
            workflow_node_id: 'publish',
            approved: true,
            decision: 'approve',
            message: 'Approve the changed diff',
            expected_action_digest: changedDiffDigest,
            actor: { id: 'user-1', name: 'Tech Lead', source: 'platform' },
          },
        ],
      }),
    ).toBe(1);

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);
    const pushedCommit = await runGit(
      ['--git-dir', remoteDir, 'rev-parse', 'refs/heads/viewport/proof'],
      root,
    );

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.publish?.outputs?.commit).toBe(pushedCommit.trim());
  }, 60_000);

  it('blocks dynamic pre-publish review from diff size even when paths are otherwise allowed', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: git-publish-dynamic-review-large-diff-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
  edit:
    type: shell
    needs: [repo]
    cwd: "{{ nodes.repo.outputs.path }}"
    command: "mkdir -p docs && for i in $(seq 1 201); do echo line-$i; done > docs/large.md"
  publish:
    type: git_publish
    needs: [edit]
    repository: acme/payments
    cwd: "{{ nodes.repo.outputs.path }}"
    branch: viewport/proof
    message: Publish proof update
    prePublishReview:
      rules:
        - name: large-diff
          when:
            diff_lines_gt: 200
          require: human(tech-lead)
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
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const blocked = await daemon.workflowRunner.getRun(run.id);

    expect(blocked?.status, blocked?.error).toBe('blocked');
    expect(blocked?.nodes.publish?.metadata?.pre_publish_review).toMatchObject({
      required: true,
      facts: expect.objectContaining({ diffLines: 201 }),
      matched_rules: [
        expect.objectContaining({
          name: 'large-diff',
          reason: 'diff_lines_gt',
        }),
      ],
    });
  }, 60_000);

  it('keeps restricted branch fences hard even when dynamic review would otherwise allow publish', async () => {
    const daemon = await setup(projectDir);
    const initialMain = await runGit(
      ['--git-dir', remoteDir, 'rev-parse', 'refs/heads/main'],
      root,
    );
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: git-publish-restricted-branch-fence-proof
nodes:
  repo:
    type: checkout
    repository: acme/payments
    remote: ${JSON.stringify(remoteDir)}
  edit:
    type: shell
    needs: [repo]
    cwd: "{{ nodes.repo.outputs.path }}"
    command: "printf '\\nfenced change\\n' >> README.md"
  publish:
    type: git_publish
    needs: [edit]
    repository: acme/payments
    cwd: "{{ nodes.repo.outputs.path }}"
    branch: main
    message: Publish proof update
    restrictedBranches: [main]
    prePublishReview:
      rules:
        - name: sensitive-path
          when:
            changed_paths_any: ["src/payments/**"]
          require: human(tech-lead)
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
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);
    const afterMain = await runGit(['--git-dir', remoteDir, 'rev-parse', 'refs/heads/main'], root);

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.publish?.error).toContain("Branch 'main' is restricted by policy");
    expect(failed?.nodes.publish?.metadata?.pre_publish_review).toMatchObject({
      required: false,
      matched_rules: [],
    });
    expect(afterMain.trim()).toBe(initialMain.trim());
  }, 60_000);

  it('fails clearly when a branch publish has no changes and empty commits are not allowed', async () => {
    const daemon = await setup(projectDir);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: git-publish-no-change-proof
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
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.publish?.status).toBe('failed');
    expect(failed?.nodes.publish?.error).toContain('no changes to publish');
    expect(failed?.events).toContainEqual(
      expect.objectContaining({
        type: 'node-failed',
        nodeId: 'publish',
        message: expect.stringContaining('no changes to publish'),
      }),
    );
  }, 60_000);

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
        shell: { policy: 'constrained', allow_legacy_command: true },
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
  }, 60_000);

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
        shell: { policy: 'constrained', allow_legacy_command: true },
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
  }, 60_000);

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
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);

    expect(failed?.status).toBe('failed');
    expect(failed?.events).toContainEqual(
      expect.objectContaining({
        type: 'node-failed',
        nodeId: 'publish',
        message: expect.stringContaining(
          'Run-scoped git publish grant repo/github/payments-api was not materialized',
        ),
      }),
    );
    expect(JSON.stringify(failed)).not.toContain('ghs_run_scoped_push');
  }, 60_000);

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
        [envNameForCredentialRef('repo/github/payments-api')]: 'ghs_run_scoped_push',
      },
      workflowAuthorityContract: {
        schema_version: 'viewport.workflow_execution_authority/v1',
        digest: 'sha256:authority',
        repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
        shell: { policy: 'constrained', allow_legacy_command: true },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');

    const pushedCommit = await runGit(
      ['--git-dir', remoteDir, 'rev-parse', 'refs/heads/viewport/proof'],
      root,
    );

    expect(completed?.nodes.publish?.metadata?.git_publish).toMatchObject({
      schema: 'viewport.git_publish_receipt/v1',
      repository: 'acme/payments',
      branch: 'viewport/proof',
      credentialMode: 'run_scoped_grant',
      credentialRef: 'repo/github/payments-api',
    });
    expect(completed?.nodes.publish?.outputs?.commit).toBe(pushedCommit.trim());
    expect(JSON.stringify(completed)).not.toContain('ghs_run_scoped_push');
  }, 60_000);
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
  await runGit(
    ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'],
    path.dirname(remote),
  );
}

function prePublishReviewDiffDigest(metadata: Record<string, unknown> | undefined): string | null {
  const review = metadata?.['pre_publish_review'];
  if (!isRecord(review)) return null;
  const facts = review['facts'];
  if (!isRecord(facts)) return null;
  return typeof facts['diffDigest'] === 'string' ? facts['diffDigest'] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
