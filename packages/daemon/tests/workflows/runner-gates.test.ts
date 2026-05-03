import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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
});
