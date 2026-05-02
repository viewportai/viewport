import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProtocolHarness, type WsMessage } from './support/protocol-harness.js';

function workflowRunFrom(message: WsMessage): Record<string, unknown> | null {
  const run = message['run'];
  return run && typeof run === 'object' ? (run as Record<string, unknown>) : null;
}

describe('protocol e2e: workflow execution', () => {
  let harness: ProtocolHarness | null = null;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = null;
  });

  it('runs a browser-provided workflow snapshot against an explicit project machine directory target', async () => {
    harness = await ProtocolHarness.start();
    const projectPath = await harness.createProject();
    const directory = await harness.registerDirectory(projectPath);
    const client = await harness.connectClient();
    await client.waitForType('hello');

    client.send({
      type: 'workflow-run',
      requestId: 'workflow-run-1',
      directoryId: directory.id,
      projectId: 'project-1',
      projectMachineBindingId: 'binding-1',
      platformRunId: 'platform-run-1',
      executionPolicy: { mode: 'current_tree' },
      workflowSourceRef: 'viewport://tests/protocol-workflow-run',
      workflowYaml: `
schema: viewport.workflow/v1
name: protocol-target-proof
title: Protocol target proof
nodes:
  inspect:
    type: shell
    title: Inspect selected directory
    command: "pwd && printf protocol-proof > workflow-proof.txt"
`,
    });

    const started = await client.waitForType('workflow-run-started');
    const startedRun = workflowRunFrom(started);
    expect(startedRun?.['projectId']).toBe('project-1');
    expect(startedRun?.['projectMachineBindingId']).toBe('binding-1');
    expect(startedRun?.['platformRunId']).toBe('platform-run-1');
    expect(startedRun?.['directoryId']).toBe(directory.id);
    expect(startedRun?.['directoryPath']).toBe(projectPath);

    const ack = await client.waitForAck('workflow-run-1');
    expect(ack['status']).toBe('ok');
    expect(typeof ack['runId']).toBe('string');
    const runId = String(ack['runId']);

    const completed = await client.waitFor((message) => {
      if (message['type'] !== 'workflow-run-updated') return false;
      const run = workflowRunFrom(message);
      return run?.['id'] === runId && run?.['status'] === 'completed';
    });
    const completedRun = workflowRunFrom(completed);
    expect(completedRun?.['projectMachineBindingId']).toBe('binding-1');

    const nodes = completedRun?.['nodes'] as Record<string, Record<string, unknown>>;
    expect(nodes.inspect?.status).toBe('completed');
    expect(String(nodes.inspect?.output)).toContain(projectPath);
    await expect(fs.readFile(path.join(projectPath, 'workflow-proof.txt'), 'utf8')).resolves.toBe(
      'protocol-proof',
    );

    client.send({ type: 'workflow-show-run', requestId: 'workflow-show-1', runId });
    const detail = await client.waitForType('workflow-run-detail');
    const detailRun = workflowRunFrom(detail);
    expect(detailRun?.['id']).toBe(runId);
    expect(detailRun?.['projectId']).toBe('project-1');
    expect(detailRun?.['directoryId']).toBe(directory.id);
    expect(detailRun?.['projectMachineBindingId']).toBe('binding-1');
    expect(detailRun?.['platformRunId']).toBe('platform-run-1');
    await client.waitForAck('workflow-show-1');

    client.close();
  });

  it('accepts a browser-provided snapshot using the full v1 schema (outputs, retry, env, policy)', async () => {
    // Mirrors the CLI proof: a stale daemon dist used to drop these fields,
    // breaking every browser-triggered run that referenced structured outputs.
    harness = await ProtocolHarness.start();
    const projectPath = await harness.createProject();
    const directory = await harness.registerDirectory(projectPath);
    const client = await harness.connectClient();
    await client.waitForType('hello');

    client.send({
      type: 'workflow-run',
      requestId: 'workflow-run-rich',
      directoryId: directory.id,
      projectId: 'project-1',
      projectMachineBindingId: 'binding-1',
      platformRunId: 'platform-run-rich',
      executionPolicy: { mode: 'current_tree' },
      workflowSourceRef: 'viewport://tests/protocol-workflow-rich',
      workflowYaml: `
schema: viewport.workflow/v1
name: protocol-rich-schema
title: Protocol rich schema proof
inputs:
  brief:
    type: string
    default: shipping change
nodes:
  inspect:
    type: shell
    title: Inspect selected directory
    command: "echo {{ inputs.brief }}"
    timeoutSeconds: 60
    retry:
      maxAttempts: 1
    env:
      EXTRA_NOTE:
        value: protocol-fixture
    outputs:
      summary:
        type: string
        description: Captured stdout of the inspect step.
    policy:
      onFailure: halt
`,
    });

    const ack = await client.waitForAck('workflow-run-rich');
    expect(ack['status']).toBe('ok');
    const runId = String(ack['runId']);

    const completed = await client.waitFor((message) => {
      if (message['type'] !== 'workflow-run-updated') return false;
      const run = workflowRunFrom(message);
      return run?.['id'] === runId && run?.['status'] === 'completed';
    });
    const completedRun = workflowRunFrom(completed);
    const nodes = completedRun?.['nodes'] as Record<string, Record<string, unknown>>;
    expect(nodes.inspect?.status).toBe('completed');
    expect(String(nodes.inspect?.output)).toContain('shipping change');

    client.close();
  });

  it('pauses a browser-provided workflow at an approval gate and resumes through the protocol', async () => {
    harness = await ProtocolHarness.start();
    const projectPath = await harness.createProject();
    const directory = await harness.registerDirectory(projectPath);
    const client = await harness.connectClient();
    await client.waitForType('hello');

    client.send({
      type: 'workflow-run',
      requestId: 'workflow-run-approval',
      directoryId: directory.id,
      projectId: 'project-approval',
      projectMachineBindingId: 'binding-approval',
      platformRunId: 'platform-run-approval',
      executionPolicy: { mode: 'current_tree' },
      workflowSourceRef: 'viewport://tests/protocol-workflow-approval',
      workflowYaml: `
schema: viewport.workflow/v1
name: protocol-approval-proof
title: Protocol approval proof
nodes:
  prepare:
    type: shell
    title: Prepare release note
    command: "printf ready > approval-before.txt"
  gate:
    type: approval
    title: Human release gate
    needs: [prepare]
    prompt: "Approve the release?"
  ship:
    type: shell
    title: Continue after approval
    needs: [gate]
    command: "printf approved > approval-after.txt"
`,
    });

    const ack = await client.waitForAck('workflow-run-approval');
    expect(ack['status']).toBe('ok');
    const runId = String(ack['runId']);

    const blocked = await client.waitFor((message) => {
      if (message['type'] !== 'workflow-run-updated') return false;
      const run = workflowRunFrom(message);
      return run?.['id'] === runId && run?.['status'] === 'blocked';
    });
    const blockedRun = workflowRunFrom(blocked);
    const blockedNodes = blockedRun?.['nodes'] as Record<string, Record<string, unknown>>;
    expect(blockedRun?.['projectMachineBindingId']).toBe('binding-approval');
    expect(blockedNodes.prepare?.status).toBe('completed');
    expect(blockedNodes.gate?.status).toBe('blocked');
    expect(blockedNodes.ship?.status).toBe('queued');
    expect((blockedNodes.gate?.approval as Record<string, unknown>)?.['prompt']).toBe(
      'Approve the release?',
    );
    await expect(fs.readFile(path.join(projectPath, 'approval-before.txt'), 'utf8')).resolves.toBe(
      'ready',
    );
    await expect(
      fs.readFile(path.join(projectPath, 'approval-after.txt'), 'utf8'),
    ).rejects.toThrow();

    client.send({
      type: 'workflow-approve',
      requestId: 'workflow-approve-approval',
      runId,
      nodeId: 'gate',
      approved: true,
      message: 'Approved from protocol e2e',
      actor: {
        id: 'user-1',
        name: 'Viewport Reviewer',
        email: 'reviewer@example.test',
        source: 'viewport-web',
      },
    });

    const approvalAck = await client.waitForAck('workflow-approve-approval');
    expect(approvalAck['status']).toBe('ok');

    const completed = await client.waitFor((message) => {
      if (message['type'] !== 'workflow-run-updated') return false;
      const run = workflowRunFrom(message);
      return run?.['id'] === runId && run?.['status'] === 'completed';
    });
    const completedRun = workflowRunFrom(completed);
    const completedNodes = completedRun?.['nodes'] as Record<string, Record<string, unknown>>;
    expect(completedNodes.gate?.status).toBe('completed');
    expect((completedNodes.gate?.approval as Record<string, unknown>)?.['approved']).toBe(true);
    expect(completedNodes.ship?.status).toBe('completed');
    await expect(fs.readFile(path.join(projectPath, 'approval-after.txt'), 'utf8')).resolves.toBe(
      'approved',
    );

    client.close();
  });
});
