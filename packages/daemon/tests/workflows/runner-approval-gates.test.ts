import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import {
  MockAdapter,
  waitForAdapterSessionCount,
  waitForCompletedRun,
  waitForRunState,
  waitForSessionWithPrompt,
  waitForTerminalRun,
} from './support/workflow-runner-support.js';

let tempHome: string;
let projectDir: string;
let originalHome: string | undefined;
let originalCodexHome: string | undefined;
let daemonUnderTest: Daemon | undefined;

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
  daemonUnderTest = daemon;
  return daemon;
}

async function cleanup(): Promise<void> {
  await daemonUnderTest?.shutdown();
  daemonUnderTest = undefined;
  if (originalHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = originalHome;
  if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
  else process.env['CODEX_HOME'] = originalCodexHome;
  await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  await fs.rm(projectDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

describe('workflow runner approval nodes', () => {
  beforeEach(async () => {});
  afterEach(cleanup);

  it('pauses at approval gates and resumes after approval', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: approval-proof
nodes:
  inspect:
    type: shell
    command: printf "ready"
  gate:
    type: approval
    needs: [inspect]
    prompt: Approve {{ nodes.inspect.output }}
    captureResponse: true
  after:
    type: shell
    needs: [gate]
    command: printf "{{ nodes.gate.output }} after"
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
        candidate.status === 'blocked' &&
        candidate.nodes.inspect?.status === 'completed' &&
        candidate.nodes.gate?.status === 'blocked',
    );

    expect(blocked?.status).toBe('blocked');
    expect(blocked?.nodes.inspect?.status).toBe('completed');
    expect(blocked?.nodes.gate?.status).toBe('blocked');
    expect(blocked?.nodes.gate?.approval?.prompt).toBe('Approve ready');
    expect(blocked?.nodes.after?.status).toBe('queued');

    await daemon.workflowRunner.decideApproval(run.id, 'gate', {
      approved: true,
      message: 'Approved by test',
      actor: {
        id: '42',
        name: 'Test User',
        email: 'test@example.test',
        source: 'unit-test',
      },
    });
    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.gate?.output).toBe('Approved by test');
    expect(completed?.nodes.gate?.approval?.actor).toEqual({
      id: '42',
      name: 'Test User',
      email: 'test@example.test',
      source: 'unit-test',
    });
    expect(completed?.nodes.after?.output).toBe('Approved by test after');
    expect(completed?.events.map((event) => event.type)).toContain('approval-requested');
    expect(completed?.events.map((event) => event.type)).toContain('approval-resolved');
  });

  it('runs the approval onReject command on denial and exposes the rejection message', async () => {
    const daemon = await setup();
    const markerFile = path.join(projectDir, 'rejection-marker.txt');
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: approval-on-reject-proof
nodes:
  inspect:
    type: shell
    command: printf "ready"
  gate:
    type: approval
    needs: [inspect]
    prompt: Approve the deploy.
    onReject:
      command: 'printf "{{ nodes.inspect.output }}:%s" "$VIEWPORT_REJECT_MESSAGE" > ${markerFile}'
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
      (candidate) => candidate.nodes.gate?.status === 'blocked',
    );

    await daemon.workflowRunner.decideApproval(run.id, 'gate', {
      approved: false,
      message: 'Reverted: shipped without integration test',
    });

    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('canceled');
    // The follow-up shell rendered upstream workflow data and wrote the
    // rejection message into the marker file.
    expect(await fs.readFile(markerFile, 'utf-8')).toBe(
      'ready:Reverted: shipped without integration test',
    );
    const rejectLogs = (completed?.events ?? []).filter(
      (event) => event.type === 'node-log' && event.message.toLowerCase().includes('onreject'),
    );
    expect(rejectLogs.length).toBeGreaterThan(0);
  });

  it('runs the approval onReject prompt on denial and records the follow-up session', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: approval-on-reject-prompt-proof
nodes:
  gate:
    type: approval
    prompt: Ship?
    onReject:
      prompt: 'Write a rejection summary for: {{ nodes.gate.approval.message }}'
      agent: claude
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
      (candidate) => candidate.nodes.gate?.status === 'blocked',
    );

    const decision = daemon.workflowRunner.decideApproval(run.id, 'gate', {
      approved: false,
      message: 'missing tests',
    });
    const followUp = await waitForAdapterSessionCount(adapter, 1);
    expect(followUp.sendPrompt).toHaveBeenCalledWith(
      'Write a rejection summary for: missing tests',
    );
    followUp.emitAgentMessage('Rejected because tests are missing.');
    followUp.simulateIdle();
    await decision;

    const canceled = await daemon.workflowRunner.getRun(run.id);
    expect(canceled?.status).toBe('canceled');
    expect(canceled?.nodes.gate?.status).toBe('failed');
    expect(canceled?.nodes.gate?.sessionId).toBeTruthy();
    expect(canceled?.nodes.gate?.output).toBe('Rejected because tests are missing.');
    expect(canceled?.events).toContainEqual(
      expect.objectContaining({
        type: 'node-output',
        nodeId: 'gate',
        data: { output: 'Rejected because tests are missing.' },
      }),
    );
  });

  it('cancels approval-gated workflows when approval is denied', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: approval-deny-proof
nodes:
  gate:
    type: approval
    prompt: Approve
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    await waitForTerminalRun(daemon, run.id);
    await daemon.workflowRunner.decideApproval(run.id, 'gate', {
      approved: false,
      message: 'No',
    });
    const canceled = await daemon.workflowRunner.getRun(run.id);

    expect(canceled?.status).toBe('canceled');
    expect(canceled?.nodes.gate?.status).toBe('failed');
    expect(canceled?.error).toBe('No');
  });

  it('keeps the approver message off the node output unless captureResponse is set', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: approval-default-output
nodes:
  gate:
    type: approval
    prompt: Approve this run.
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
      (candidate) => candidate.nodes.gate?.status === 'blocked',
    );

    await daemon.workflowRunner.decideApproval(run.id, 'gate', {
      approved: true,
      message: 'Confidential reviewer note — should not leak into output',
    });
    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    // Default behavior: output is the constant 'Approved' string. The message
    // is preserved on the audit record so reviewers can still inspect it.
    expect(completed?.nodes.gate?.output).toBe('Approved');
    expect(completed?.nodes.gate?.approval?.message).toContain('Confidential');
  });

  it('passes typed output through prompt, approval, and downstream shell nodes', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: typed-dataflow-proof
nodes:
  collect:
    type: shell
    command: 'printf ''{"repo":"viewport","verdict":"needs-tests"}'''
    outputs:
      repo:
        type: string
        extract: json.repo
      verdict:
        type: string
        extract: json.verdict
  review:
    type: prompt
    needs: [collect]
    agent: claude
    prompt: 'Review {{ nodes.collect.outputs.repo }} with verdict {{ nodes.collect.outputs.verdict }}'
    outputs:
      summary:
        type: string
  gate:
    type: approval
    needs: [review]
    prompt: 'Approve agent summary: {{ nodes.review.outputs.summary }}'
    captureResponse: true
  notify:
    type: shell
    needs: [gate]
    command: 'printf "final={{ nodes.gate.output }}"'
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    const review = await waitForSessionWithPrompt(
      adapter,
      'Review viewport with verdict needs-tests',
    );
    review.emitAgentMessage('looks good after adding tests');
    review.simulateIdle();

    const blocked = await waitForRunState(
      daemon,
      run.id,
      (candidate) =>
        candidate.status === 'blocked' &&
        candidate.nodes.gate?.approval?.prompt ===
          'Approve agent summary: looks good after adding tests',
    );

    expect(blocked.nodes.collect?.outputs).toEqual({
      repo: 'viewport',
      verdict: 'needs-tests',
    });
    expect(blocked.nodes.review?.outputs).toEqual({
      summary: 'looks good after adding tests',
    });

    await daemon.workflowRunner.decideApproval(run.id, 'gate', {
      approved: true,
      message: 'ship it',
      actor: {
        id: '42',
        name: 'Test User',
        email: 'test@example.test',
        source: 'unit-test',
      },
    });

    await waitForCompletedRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.gate?.output).toBe('ship it');
    expect(completed?.nodes.notify?.output).toBe('final=ship it');
  });
});
