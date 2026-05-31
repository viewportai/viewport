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
    expect(failed?.nodes.fail?.metadata?.['shell_execution']).toMatchObject({
      schema: 'viewport.shell_execution_receipt/v1',
      node_id: 'fail',
      status: 'failed',
      executor: {
        kind: 'shell',
        command: 'sh',
        args: ['-lc'],
      },
      command_digest: expect.stringMatching(/^sha256:/),
      command_persisted: false,
      cwd: projectDir,
      env_keys: [],
      env_values_persisted: false,
      timeout_seconds: 600,
      exit_code: 7,
      denial: null,
    });
  });

  it('applies and receipts the hard default shell timeout', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-default-timeout-proof
nodes:
  proof:
    type: shell
    argv:
      - printf
      - ok
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
    expect(completed?.nodes.proof?.metadata?.['shell_execution']).toMatchObject({
      schema: 'viewport.shell_execution_receipt/v1',
      node_id: 'proof',
      status: 'completed',
      timeout_seconds: 600,
    });
  });

  it('kills shell nodes when their explicit timeout is reached', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-timeout-proof
nodes:
  proof:
    type: shell
    timeoutSeconds: 1
    argv:
      - ${JSON.stringify(process.execPath)}
      - -e
      - setTimeout(() => {}, 5000)
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
    expect(failed?.nodes.proof?.status).toBe('failed');
    expect(failed?.nodes.proof?.error).toContain('timed out after 1s');
    expect(failed?.nodes.proof?.metadata?.['shell_execution']).toMatchObject({
      schema: 'viewport.shell_execution_receipt/v1',
      node_id: 'proof',
      status: 'failed',
      timeout_seconds: 1,
      exit_code: null,
    });
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
    expect(failed?.nodes.inspect?.metadata?.['shell_execution']).toMatchObject({
      schema: 'viewport.shell_execution_receipt/v1',
      node_id: 'inspect',
      status: 'denied',
      command_persisted: false,
      env_values_persisted: false,
      authority: expect.objectContaining({
        source: 'workflow_authority_contract',
        shell_policy: null,
        authority_contract_present: true,
        authority_contract_digest: 'sha256:authority',
      }),
      denial: {
        reason: 'shell_policy_required',
        detail: expect.stringContaining('explicit constrained shell policy'),
      },
    });
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

  it('requires explicit legacy command opt-in when authority contract is present', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-legacy-opt-in-proof
nodes:
  inspect:
    type: shell
    command: printf legacy
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
    expect(failed?.nodes.inspect?.error).toContain('shell.allow_legacy_command');
    expect(failed?.nodes.inspect?.output).not.toBe('legacy');
    expect(failed?.nodes.inspect?.metadata?.['shell_execution']).toMatchObject({
      schema: 'viewport.shell_execution_receipt/v1',
      node_id: 'inspect',
      status: 'denied',
      executor: expect.objectContaining({ kind: 'shell' }),
      authority: expect.objectContaining({
        source: 'workflow_authority_contract',
        shell_policy: 'constrained',
        legacy_command_allowed: false,
      }),
      denial: {
        reason: 'shell_legacy_command_not_allowed',
        detail: expect.stringContaining('shell.allow_legacy_command'),
      },
    });
  });

  it('allows authority-bound argv shell nodes without legacy command opt-in', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-argv-authority-proof
nodes:
  inspect:
    type: shell
    argv:
      - printf
      - argv-ok
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
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.inspect?.output).toBe('argv-ok');
    expect(completed?.nodes.inspect?.metadata?.['shell_execution']).toMatchObject({
      schema: 'viewport.shell_execution_receipt/v1',
      node_id: 'inspect',
      status: 'completed',
      executor: expect.objectContaining({ kind: 'argv' }),
      authority: expect.objectContaining({
        source: 'workflow_authority_contract',
        shell_policy: 'constrained',
        legacy_command_allowed: false,
      }),
    });
  });

  it('blocks argv shell commands denied by the workflow authority contract', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-policy-deny-proof
nodes:
  dangerous:
    type: shell
    argv:
      - rm
      - -rf
      - /tmp/viewport-proof
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
        shell: {
          policy: 'constrained',
          denied: ['rm -rf *'],
        },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.dangerous?.metadata?.['shell_execution']).toMatchObject({
      status: 'denied',
      denial: expect.objectContaining({
        reason: 'shell_command_not_allowed',
        detail: expect.stringContaining('denied pattern'),
      }),
    });
    expect(failed?.events.some((event) => event.type === 'shell-blocked')).toBe(true);
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
        shell: { policy: 'constrained', allow_legacy_command: true },
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
        shell: { policy: 'constrained', allow_legacy_command: true },
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

  it('blocks argv side-effect commands outside first-class authority', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-argv-side-effect-proof
nodes:
  push:
    type: shell
    argv:
      - git
      - push
      - git@github.com:acme/payments.git
      - HEAD:viewport/proof
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
    expect(failed?.nodes.push?.metadata?.['shell_execution']).toMatchObject({
      schema: 'viewport.shell_execution_receipt/v1',
      status: 'denied',
      executor: expect.objectContaining({ kind: 'argv' }),
      denial: {
        reason: 'shell_provider_side_effect_not_allowed',
        detail: expect.stringContaining('github.push-branch'),
      },
    });
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

  it('blocks generic external API shell calls unless the authority contract allows them', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-external-api-side-effect-proof
nodes:
  call_external:
    type: shell
    argv:
      - curl
      - https://example.com/api/side-effect
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
        repos: { allowed: [], runner_pool_owns_repo_scope: false },
        side_effects: { allowed: [{ provider: 'github', actions: ['pull-request.create'] }] },
        shell: { policy: 'constrained' },
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const failed = await daemon.workflowRunner.getRun(run.id);

    expect(failed?.status).toBe('failed');
    expect(failed?.nodes.call_external?.error).toContain('external-api.request');
    expect(failed?.nodes.call_external?.metadata?.['shell_execution']).toMatchObject({
      schema: 'viewport.shell_execution_receipt/v1',
      status: 'denied',
      executor: expect.objectContaining({ kind: 'argv' }),
      denial: {
        reason: 'shell_provider_side_effect_not_allowed',
        provider: 'external-api',
        action: 'request',
      },
    });
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
          shell: { policy: 'constrained', allow_legacy_command: true },
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

  it('blocks shell cwd outside the run worktree without relying on authority contracts', async () => {
    const daemon = await setup();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-outside-worktree-'));
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-cwd-proof
nodes:
  inspect:
    type: shell
    cwd: ${JSON.stringify(outside)}
    argv:
      - printf
      - outside
`,
      'utf-8',
    );

    try {
      const run = await daemon.workflowRunner.startRun({
        workflowPath,
        directoryId: DirectoryManager.idFromPath(projectDir),
        initiation: 'cli',
      });

      await waitForTerminalRun(daemon, run.id);
      const failed = await daemon.workflowRunner.getRun(run.id);

      expect(failed?.status).toBe('failed');
      expect(failed?.nodes.inspect?.error).toContain('outside the run worktree');
      expect(failed?.nodes.inspect?.metadata?.['shell_execution']).toMatchObject({
        schema: 'viewport.shell_execution_receipt/v1',
        status: 'denied',
        executor: expect.objectContaining({ kind: 'argv' }),
        denial: {
          reason: 'shell_cwd_outside_run_workspace',
          detail: expect.stringContaining('outside the run worktree'),
        },
      });
      expect(failed?.events).toContainEqual(
        expect.objectContaining({
          type: 'shell-blocked',
          nodeId: 'inspect',
          data: expect.objectContaining({
            workflow_authority_denial: expect.objectContaining({
              reason: 'shell_cwd_outside_run_workspace',
            }),
          }),
        }),
      );
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
