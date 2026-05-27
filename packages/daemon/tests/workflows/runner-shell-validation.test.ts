import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import { waitForTerminalRun } from './support/workflow-runner-support.js';

let tempHome: string;
let projectDir: string;
let originalHome: string | undefined;
let originalCodexHome: string | undefined;

async function setup(): Promise<Daemon> {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-home-'));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-project-'));
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
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
  else process.env['CODEX_HOME'] = originalCodexHome;
  await fs.rm(tempHome, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
}

describe('workflow runner shell execution', () => {
  beforeEach(async () => {});
  afterEach(cleanup);
  it('marks shell node failures on the run record', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: failure-proof
nodes:
  fail:
    type: shell
    command: exit 7
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

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.fail?.status).toBe('failed');
    expect(failed?.nodes.fail?.exitCode).toBe(7);
    expect(failed?.error).toMatch(/code 7/);
  });

  it('blocks git workflows before shell execution when the target directory is not a git worktree', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: git-proof
requires:
  tools:
    - git
nodes:
  inspect:
    type: shell
    command: git status --short
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForTerminalRun(daemon, run.id);
    const blocked = await daemon.workflowRunner.getRun(run.id);

    expect(blocked?.status).toBe('blocked');
    expect(blocked?.nodes.inspect?.status).toBe('queued');
    expect(blocked?.preflight.issues[0]?.message).toMatch(/not a git repository/);
  });

  it('requires explicit constrained shell policy when authority contract is present', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-policy-required-proof
nodes:
  inspect:
    type: shell
    command: printf no-policy
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
        repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
        side_effects: { allowed: [] },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.inspect?.error).toContain('requires an explicit constrained shell policy');
    expect(failed?.events).toContainEqual(
      expect.objectContaining({
        type: 'shell-blocked',
        nodeId: 'inspect',
        data: expect.objectContaining({
          workflow_authority_denial: expect.objectContaining({
            reason: 'shell_policy_required',
          }),
        }),
      }),
    );
  });

  it('blocks shell commands that reference repositories outside the workflow authority contract', async () => {
    const daemon = await setup();
    await fs.writeFile(path.join(projectDir, 'README.md'), 'proof\n', 'utf8');
    await runGit(['init'], projectDir);
    await runGit(['config', 'user.email', 'proof@example.test'], projectDir);
    await runGit(['config', 'user.name', 'Viewport Proof'], projectDir);
    await runGit(['add', 'README.md'], projectDir);
    await runGit(['commit', '-m', 'proof'], projectDir);

    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-authority-repo-proof
nodes:
  clone:
    type: shell
    command: git clone git@github.com:acme/forbidden.git forbidden
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
        repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
        side_effects: { allowed: [] },
        shell: { policy: 'constrained' },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.clone?.error).toContain('repository acme/forbidden');
    expect(failed?.events).toContainEqual(
      expect.objectContaining({
        type: 'shell-blocked',
        nodeId: 'clone',
        data: expect.objectContaining({
          workflow_authority_denial: expect.objectContaining({
            reason: 'shell_repository_not_allowed',
            repository: 'acme/forbidden',
            allowed: ['acme/payments'],
          }),
        }),
      }),
    );
  });

  it('blocks shell side-effect commands not allowed by workflow authority', async () => {
    const daemon = await setup();
    await fs.writeFile(path.join(projectDir, 'README.md'), 'proof\n', 'utf8');
    await runGit(['init'], projectDir);
    await runGit(['config', 'user.email', 'proof@example.test'], projectDir);
    await runGit(['config', 'user.name', 'Viewport Proof'], projectDir);
    await runGit(['add', 'README.md'], projectDir);
    await runGit(['commit', '-m', 'proof'], projectDir);

    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-authority-side-effect-proof
nodes:
  push:
    type: shell
    command: git push git@github.com:acme/payments.git HEAD:viewport/proof
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
        repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
        side_effects: { allowed: [{ provider: 'github', actions: ['create_pr'] }] },
        shell: { policy: 'constrained' },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.push?.error).toContain('github.push-branch');
    expect(failed?.events).toContainEqual(
      expect.objectContaining({
        type: 'shell-blocked',
        nodeId: 'push',
        data: expect.objectContaining({
          workflow_authority_denial: expect.objectContaining({
            reason: 'shell_provider_side_effect_not_allowed',
            provider: 'github',
            action: 'push-branch',
          }),
        }),
      }),
    );
  });

  it('blocks shell cwd outside the run worktree when workflow authority is present', async () => {
    const daemon = await setup();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-outside-worktree-'));
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-authority-cwd-proof
nodes:
  inspect:
    type: shell
    cwd: ${JSON.stringify(outside)}
    command: printf outside
`,
      'utf-8',
    );

    try {
      const run = await daemon.workflowRunner.startRun({
        workflowPath,
        directoryId: DirectoryManager.idFromPath(projectDir),
        initiation: 'cli',
        workflowAuthorityContract: {
          schema_version: 'viewport.workflow_execution_authority/v1',
          digest: 'sha256:authority',
          repos: { allowed: ['acme/payments'], runner_pool_owns_repo_scope: false },
          side_effects: { allowed: [] },
          shell: { policy: 'constrained' },
        },
      });

      await waitForTerminalRun(daemon, run.id);
      const failed = await daemon.workflowRunner.getRun(run.id);

      expect(failed?.status).toBe('failed');
      expect(failed?.nodes.inspect?.error).toContain('outside the run worktree');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects required inputs before queuing a run', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: input-proof
inputs:
  ticket:
    type: string
    required: true
nodes:
  proof:
    type: shell
    command: echo ok
`,
      'utf-8',
    );

    await expect(
      daemon.workflowRunner.startRun({
        workflowPath,
        directoryId: DirectoryManager.idFromPath(projectDir),
        initiation: 'cli',
      }),
    ).rejects.toThrow(/Missing required workflow input/);
  });

  it('resolves declared json input defaults into templates', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: json-input-proof
inputs:
  integration_event:
    type: json
    default:
      provider: github
      payload:
        number: 42
nodes:
  proof:
    type: shell
    command: printf '%s:%s' '{{ inputs.integration_event.provider }}' '{{ inputs.integration_event.payload.number }}'
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

    expect(completed?.status).toBe('completed');
    expect(completed?.inputs.integration_event).toMatchObject({
      provider: 'github',
      payload: { number: 42 },
    });
    expect(completed?.nodes.proof?.output).toBe('github:42');
  });

  it('shell-quotes templated input values before invoking sh -lc', async () => {
    const daemon = await setup();
    const marker = path.join(projectDir, 'pwned');
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-template-quote-proof
inputs:
  label:
    type: string
    required: true
nodes:
  proof:
    type: shell
    command: printf %s {{ inputs.label }}
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      inputs: {
        label: `safe; touch ${marker}`,
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.proof?.output).toBe(`safe; touch ${marker}`);
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it('escapes templated shell values inside double quotes', async () => {
    const daemon = await setup();
    const marker = path.join(projectDir, 'double-quoted-pwned');
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-template-double-quote-proof
inputs:
  label:
    type: string
    required: true
nodes:
  proof:
    type: shell
    command: printf "{{ inputs.label }}"
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      inputs: {
        label: `safe$(touch ${marker})`,
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.proof?.output).toBe(`safe$(touch ${marker})`);
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it('runs sibling shell nodes concurrently in the same DAG layer', async () => {
    // Two siblings each sleep before writing a marker. The assertion below
    // proves their execution windows overlap, which is stronger and less
    // load-sensitive than a wall-clock threshold.
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: parallel-proof
nodes:
  left:
    type: shell
    command: 'sleep 0.25 && printf left'
    outputs:
      mark:
        type: string
  right:
    type: shell
    command: 'sleep 0.25 && printf right'
    outputs:
      mark:
        type: string
  join:
    type: shell
    needs: [left, right]
    command: 'printf {{ nodes.left.outputs.mark }}-{{ nodes.right.outputs.mark }}'
`,
      'utf-8',
    );

    const directoryId = DirectoryManager.idFromPath(projectDir);
    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId,
      initiation: 'cli',
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.left?.status).toBe('completed');
    expect(completed?.nodes.right?.status).toBe('completed');
    expect(completed?.nodes.join?.output).toBe('left-right');
    const left = completed?.nodes.left;
    const right = completed?.nodes.right;
    expect(left?.startedAt).toBeTypeOf('number');
    expect(left?.completedAt).toBeTypeOf('number');
    expect(right?.startedAt).toBeTypeOf('number');
    expect(right?.completedAt).toBeTypeOf('number');
    expect(left!.startedAt!).toBeLessThan(right!.completedAt!);
    expect(right!.startedAt!).toBeLessThan(left!.completedAt!);
  });
});

async function runGit(args: string[], cwd: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} failed with ${code}`));
    });
  });
}
