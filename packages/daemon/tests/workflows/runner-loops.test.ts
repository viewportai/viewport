import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import {
  MockAdapter,
  waitForAdapterSessionCount,
  waitForRunState,
  waitForSessionWithPrompt,
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

describe('workflow runner loops', () => {
  beforeEach(async () => {});
  afterEach(cleanup);
  it('iterates a foreach loop over an upstream JSON array and aggregates per-iteration output', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: loop-foreach-proof
nodes:
  list:
    type: shell
    command: echo '["alpha","beta","gamma"]'
    outputs:
      items:
        type: json
  process:
    type: loop
    needs: [list]
    foreach: nodes.list.outputs.items
    maxIterations: 5
    body:
      type: shell
      command: 'printf %s {{ loop.item }}'
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
    const node = completed?.nodes.process;
    expect(node?.status).toBe('completed');
    expect(node?.iterations).toHaveLength(3);
    expect(node?.iterations?.map((iter) => iter.output)).toEqual(['alpha', 'beta', 'gamma']);
    expect(node?.iterations?.map((iter) => iter.item)).toEqual(['alpha', 'beta', 'gamma']);
    const events = completed?.events ?? [];
    expect(events.filter((event) => event.type === 'loop-iteration-started')).toHaveLength(3);
    expect(events.filter((event) => event.type === 'loop-iteration-completed')).toHaveLength(3);
  });

  it('iterates a foreach loop with prompt bodies and records per-iteration sessions', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: loop-prompt-proof
nodes:
  list:
    type: shell
    command: echo '["alpha","beta"]'
    outputs:
      items:
        type: json
  process:
    type: loop
    needs: [list]
    foreach: nodes.list.outputs.items
    maxIterations: 5
    body:
      type: prompt
      agent: claude
      prompt: 'Review {{ loop.item }} at index {{ loop.index }}'
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    const first = await waitForAdapterSessionCount(adapter, 1);
    const firstPrompt = String(first.sendPrompt.mock.calls.at(-1)?.[0] ?? '');
    expect(firstPrompt).toContain('<runtime_constraints>');
    expect(firstPrompt).toContain('No agent tools are available for this workflow node.');
    expect(firstPrompt).toContain('Review alpha at index 0');
    first.emitAgentMessage('alpha done');
    first.simulateIdle();

    const second = await waitForAdapterSessionCount(adapter, 2);
    const secondPrompt = String(second.sendPrompt.mock.calls.at(-1)?.[0] ?? '');
    expect(secondPrompt).toContain('<runtime_constraints>');
    expect(secondPrompt).toContain('No agent tools are available for this workflow node.');
    expect(secondPrompt).toContain('Review beta at index 1');
    second.emitAgentMessage('beta done');
    second.simulateIdle();

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);
    const node = completed?.nodes.process;

    expect(completed?.status).toBe('completed');
    expect(node?.iterations?.map((iter) => iter.output)).toEqual(['alpha done', 'beta done']);
    expect(node?.iterations?.every((iter) => Boolean(iter.sessionId))).toBe(true);
    expect(node?.output).toBe(JSON.stringify(['alpha done', 'beta done']));
  });

  it('cancels a running loop prompt iteration and preserves canceled iteration state', async () => {
    const daemon = await setup();
    const adapter = new MockAdapter();
    daemon.registerAdapter(adapter);
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: loop-prompt-cancel-proof
nodes:
  list:
    type: shell
    command: echo '["alpha","beta"]'
    outputs:
      items:
        type: json
  process:
    type: loop
    needs: [list]
    foreach: nodes.list.outputs.items
    maxIterations: 5
    body:
      type: prompt
      agent: claude
      prompt: 'Review {{ loop.item }} at index {{ loop.index }}'
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
    });

    const first = await waitForSessionWithPrompt(adapter, 'Review alpha at index 0');
    await waitForRunState(daemon, run.id, (state) =>
      Boolean(state.nodes.process?.iterations?.[0]?.sessionId),
    );

    const canceled = await daemon.workflowRunner.cancelRun(run.id, {
      message: 'User stopped loop prompt',
    });

    expect(first.kill).toHaveBeenCalled();
    expect(canceled.status).toBe('canceled');
    expect(canceled.nodes.process?.status).toBe('canceled');
    expect(canceled.nodes.process?.iterations?.[0]).toMatchObject({
      status: 'canceled',
      error: 'User stopped loop prompt',
    });

    first.simulateIdle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const saved = await daemon.workflowRunner.getRun(run.id);
    expect(saved?.status).toBe('canceled');
    expect(saved?.nodes.process?.status).toBe('canceled');
    expect(saved?.nodes.process?.iterations?.[0]?.status).toBe('canceled');
  }, 10_000);

  it('runs a while loop until its condition turns falsy and respects maxIterations', async () => {
    const daemon = await setup();
    const counterFile = path.join(projectDir, 'counter.txt');
    await fs.writeFile(counterFile, '0', 'utf-8');
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: loop-while-proof
nodes:
  bump:
    type: loop
    while: 'loop.index < 4'
    maxIterations: 10
    body:
      type: shell
      command: 'printf %s {{ loop.index }}'
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
    expect(completed?.nodes.bump?.iterations?.map((iter) => iter.output)).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
  });

  it('evaluates loop until conditions against the completed iteration', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: loop-until-proof
nodes:
  bump:
    type: loop
    until: 'loop.last.output = "2"'
    maxIterations: 10
    body:
      type: shell
      command: 'printf %s {{ loop.index }}'
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
    expect(completed?.nodes.bump?.iterations?.map((iter) => iter.output)).toEqual(['0', '1', '2']);
  });
});
