import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import {
  MockAdapter,
  waitForNodeSession,
  waitForCompletedRun,
  waitForRunState,
  waitForTerminalRun,
} from './support/workflow-runner-support.js';

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

describe('workflow runner gates', () => {
  beforeEach(async () => {});
  afterEach(cleanup);

  it('runs deterministic check, policy, and elapsed schedule gates', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: deterministic-gates-proof
nodes:
  check_context:
    type: gate
    gate:
      type: check
      expression: "true"
  policy_gate:
    type: gate
    needs: [check_context]
    gate:
      type: policy
      expression: "pass"
  timed_gate:
    type: gate
    needs: [policy_gate]
    gate:
      type: schedule
      waitUntil: "2000-01-01T00:00:00.000Z"
  after:
    type: shell
    needs: [timed_gate]
    command: printf "{{ nodes.check_context.output }} / {{ nodes.policy_gate.output }}"
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.check_context?.output).toBe('true');
    expect(completed?.nodes.policy_gate?.output).toBe('pass');
    expect(completed?.nodes.timed_gate?.output).toContain('Schedule reached');
    expect(completed?.nodes.after?.output).toBe('true / pass');
    expect(completed?.events.map((event) => event.type)).toContain('gate-passed');
  });

  it('fails deterministic gates when the expression is false', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: failed-gate-proof
nodes:
  check_context:
    type: gate
    gate:
      type: check
      expression: "false"
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
    expect(failed?.nodes.check_context?.status).toBe('failed');
    expect(failed?.error).toMatch(/check gate check_context failed/);
  });

  it('pauses at human review gates and resumes after approval', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: human-review-gate-proof
nodes:
  gate:
    type: gate
    gate:
      type: human_review
      prompt: Approve the rollout.
  after:
    type: shell
    needs: [gate]
    command: printf "{{ nodes.gate.output }}"
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
      (candidate) => candidate.status === 'blocked' && candidate.nodes.gate?.status === 'blocked',
    );

    expect(blocked.nodes.gate?.approval?.prompt).toBe('Approve the rollout.');
    expect(blocked.events.map((event) => event.type)).toContain('gate-blocked');

    await daemon.workflowRunner.decideApproval(run.id, 'gate', {
      approved: true,
      message: 'Human reviewed',
    });
    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.gate?.output).toBe('Human reviewed');
    expect(completed?.nodes.after?.output).toBe('Human reviewed');
  });

  it('creates a plan proposal node and waits for approval before continuing', async () => {
    const daemon = await setup();
    const proposals: Array<{
      title?: string;
      body: string;
      source?: string;
      metadata?: Record<string, unknown>;
    }> = [];
    daemon.on('hook:plan-proposed', (event) => {
      proposals.push({
        title: event.title,
        body: event.body,
        source: event.source,
        metadata: event.metadata,
      });
    });
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: plan-node-proof
nodes:
  propose:
    type: plan
    title: "Refactor billing boundaries"
    summary: "Move billing orchestration behind a service."
    body: |
      ## Plan
      1. Add BillingService.
      2. Move controller orchestration.
      3. Add tests.
  after:
    type: shell
    needs: [propose]
    command: printf "{{ nodes.propose.output }}"
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
        candidate.status === 'blocked' && candidate.nodes.propose?.status === 'blocked',
    );

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      title: 'Refactor billing boundaries',
      source: 'workflow',
      metadata: {
        workflowRunId: run.id,
        workflowNodeId: 'propose',
      },
    });
    expect(proposals[0]?.metadata).not.toHaveProperty('projectId');
    expect(proposals[0]?.body).toContain('Add BillingService');
    expect(blocked.nodes.propose?.approval?.prompt).toBe(
      'Approve plan: Refactor billing boundaries',
    );
    expect(blocked.nodes.propose?.metadata?.plan).toMatchObject({
      title: 'Refactor billing boundaries',
      source: 'workflow',
    });

    await daemon.workflowRunner.decideApproval(run.id, 'propose', {
      approved: true,
      message: 'Approved by reviewer',
      feedback: {
        plan_body: '## Revised Plan\n1. Add BillingService.\n2. Keep controller behavior stable.',
      },
    });
    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.propose?.output).toContain('Keep controller behavior stable');
    expect(completed?.nodes.after?.output).toContain('Keep controller behavior stable');
    expect(completed?.events.map((event) => event.type)).toContain('plan-proposed');
  });

  it('keeps plan approvals blocked when reviewers request changes', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: plan-revision-loop-proof
nodes:
  propose:
    type: plan
    title: "Support implementation plan"
    summary: "Draft the support fix before implementation."
    recipients:
      - role: pm
        label: PMs
    revision:
      onRequestChanges: revise_with_agent
      agent: claude
      model: opus
      prompt: "Revise the plan with the PM comments."
    body: |
      ## Plan
      1. Change the retry path.
  after:
    type: shell
    needs: [propose]
    command: printf "{{ nodes.propose.output }}"
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForRunState(
      daemon,
      run.id,
      (candidate) =>
        candidate.status === 'blocked' && candidate.nodes.propose?.status === 'blocked',
    );

    const decision = daemon.workflowRunner.decideApproval(run.id, 'propose', {
      approved: false,
      decision: 'request_changes',
      message: 'Narrow the plan to idempotency evidence first.',
    });
    await waitForNodeSession(daemon, run.id, 'propose');
    adapter.lastSession?.emitAgentMessage(
      '## Revised plan\n1. First gather idempotency evidence, then change the retry path.',
    );
    adapter.lastSession?.simulateIdle();
    await decision;

    const blocked = await daemon.workflowRunner.getRun(run.id);

    expect(blocked?.status).toBe('blocked');
    expect(blocked?.error).toBeUndefined();
    expect(blocked?.nodes.propose?.status).toBe('blocked');
    expect(blocked?.nodes.propose?.output).toContain('Revised plan');
    expect(blocked?.nodes.after?.status).toBe('queued');
    expect(blocked?.nodes.propose?.approval).toMatchObject({
      feedback: {
        previousDecision: 'request_changes',
        message: 'Narrow the plan to idempotency evidence first.',
      },
    });
    expect(blocked?.nodes.propose?.metadata?.plan).toMatchObject({
      body: expect.stringContaining('Revised plan'),
      revisionCount: 1,
      recipients: [{ role: 'pm', label: 'PMs' }],
      revision: {
        onRequestChanges: 'revise_with_agent',
        agent: 'claude',
        model: 'opus',
      },
    });
    expect(blocked?.events.map((event) => event.type)).toContain('plan-changes-requested');
    expect(blocked?.events.map((event) => event.type)).toContain('plan-revised');
  });

  it('prepares context update proposals without persisting raw patch text', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: context-update-proof
nodes:
  update_docs:
    type: context_update
    targetRef: context://git/support-runbook
    title: "Add duplicate delivery learning"
    summary: "Capture the support workflow lesson after the run."
    idempotencyKey: "{{ run.id }}:support-runbook"
    patch:
      mode: append
      files:
        - path: docs/context/payment-risk-rules.md
          operation: modify
      text: "PRIVATE_EDGE_PATCH: check duplicate delivery before changing retry backoff."
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);
    const serialized = JSON.stringify({
      node: completed?.nodes.update_docs,
      events: completed?.events,
    });

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.update_docs?.metadata?.context_update).toMatchObject({
      target_ref: 'context://git/support-runbook',
      title: 'Add duplicate delivery learning',
      status: 'prepared',
      plaintext_patch_persisted: false,
      patch: expect.objectContaining({
        files: [
          expect.objectContaining({
            path: 'docs/context/payment-risk-rules.md',
            operation: 'modify',
            patch_digest: expect.stringMatching(/^sha256:/),
          }),
        ],
      }),
    });
    expect(
      String(
        (completed?.nodes.update_docs?.metadata?.context_update as Record<string, unknown>)
          ?.patch_digest,
      ),
    ).toMatch(/^sha256:/);
    expect(completed?.events.map((event) => event.type)).toContain('context-update-proposed');
    expect(serialized).not.toContain('PRIVATE_EDGE_PATCH');
  });

  it('builds run preparation without turning prepared context into ambient node access', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: run-preparation-proof
inputs:
  repo:
    type: string
    default: viewportai/vp-example-repo
nodes:
  checkout_repo:
    type: checkout
    when: "false"
    repository: "{{ inputs.repo }}"
    credentialMode: runner_local
  draft_plan:
    type: shell
    command: "printf plan"
    context:
      include:
        - git://viewportai/vp-example-docs/docs/runbooks/
  implement_patch:
    type: shell
    command: "printf implement"
    context:
      include:
        - git://viewportai/vp-example-docs/docs/repo-context/
      exclude:
        - git://viewportai/vp-example-docs/docs/runbooks/
  update_docs:
    type: context_update
    targetRef: git://viewportai/vp-example-docs/docs/context/
    title: "Capture support learning"
    context:
      write_targets:
        - ref: git://viewportai/vp-example-docs/docs/context/
          kind: repo_pr
          name: Support docs context
          approval: required
    patch:
      mode: append
      files:
        - path: docs/context/payment-risk-rules.md
          operation: modify
      text: "PRIVATE_EDGE_PATCH: durable learning"
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.runPreparation).toMatchObject({
      schema: 'viewport.run_preparation/v1',
      operating_repos: [expect.objectContaining({ repository: 'viewportai/vp-example-repo' })],
      update_targets: expect.arrayContaining([
        expect.objectContaining({
          ref: 'git://viewportai/vp-example-docs/docs/context/',
          repository: 'viewportai/vp-example-docs',
          path: 'docs/context/',
          scope: 'directory',
          apply_mode: 'pull_request',
        }),
      ]),
    });
    expect(completed?.events.map((event) => event.type)).toContain('run-preparation-completed');
    expect(completed?.events.map((event) => event.type)).toContain('context-source-prepared');
    expect(completed?.events.map((event) => event.type)).toContain(
      'context-update-target-prepared',
    );
    expect(completed?.events.map((event) => event.type)).not.toContain('node-context-selected');
    expect(JSON.stringify(completed?.runPreparation)).not.toContain('PRIVATE_EDGE_PATCH');
  });
});
