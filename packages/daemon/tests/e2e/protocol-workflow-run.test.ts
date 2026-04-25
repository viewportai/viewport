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
});
