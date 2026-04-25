import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FullstackCliHarness } from './support/fullstack-cli-harness.js';

interface CommandResult {
  logs: string[];
  errors: string[];
}

function parseJsonLog(logs: string[]): Record<string, unknown> {
  for (const entry of logs) {
    try {
      return JSON.parse(entry) as Record<string, unknown>;
    } catch {
      // continue
    }
  }
  throw new Error(`Expected JSON output, got: ${logs.join('\n')}`);
}

async function runCliCommand(
  args: string[],
  modulePath: string,
  exportName: string,
): Promise<CommandResult> {
  vi.resetModules();
  process.argv = ['node', 'vpd', ...args];
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
    logs.push(parts.map((part) => String(part)).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    errors.push(parts.map((part) => String(part)).join(' '));
  });
  try {
    const mod = (await import(modulePath)) as Record<string, () => Promise<void>>;
    const command = mod[exportName];
    if (typeof command !== 'function') {
      throw new Error(`Missing export ${exportName} in ${modulePath}`);
    }
    await command();
    return { logs, errors };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() >= deadline) {
      throw new Error('Timeout waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('fullstack CLI workflow commands', () => {
  let harness: FullstackCliHarness | null = null;
  const originalArgv = process.argv.slice();

  afterEach(async () => {
    process.argv = originalArgv;
    if (harness) {
      await harness.close();
      harness = null;
    }
  });

  it('runs, lists, and shows a workflow against a registered repository directory', async () => {
    harness = await FullstackCliHarness.start();
    const projectPath = await harness.createGitProject();
    const workflowPath = path.join(projectPath, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: fullstack-workflow-proof
title: Fullstack workflow proof
nodes:
  inspect:
    type: shell
    title: Inspect repository
    command: "pwd && git status --short"
  review:
    type: prompt
    title: Review repository state
    agent: fake
    needs:
      - inspect
    prompt: "Summarize this repository state: {{ nodes.inspect.output }}"
`,
      'utf-8',
    );

    const workflowRunResult = await runCliCommand(
      ['workflow', 'run', workflowPath, '--directory', projectPath, '--detach', '--json'],
      '../../src/cli/workflow-commands.js',
      'workflow',
    );
    const workflowRunPayload = parseJsonLog(workflowRunResult.logs) as {
      run?: { id?: string; status?: string };
    };
    expect(['queued', 'running']).toContain(workflowRunPayload.run?.status);
    expect(workflowRunPayload.run?.id).toBeTruthy();
    const workflowRunId = String(workflowRunPayload.run!.id);

    const workflowSession = await waitFor(async () => {
      const run = await harness!.daemonInstance.workflowRunner.getRun(workflowRunId);
      if (!run?.nodes.review?.sessionId) return null;
      const session = harness!.fakeAdapter.getLatestSession();
      return session?.id ? session : null;
    });
    workflowSession.emitMessage({
      type: 'agent_message',
      text: 'workflow review complete',
      messageId: 'workflow-agent-message',
      timestamp: Date.now(),
    });
    workflowSession.state = 'idle';
    workflowSession.emit('state-change', 'idle');

    const completed = await waitFor(async () => {
      const run = await harness!.daemonInstance.workflowRunner.getRun(workflowRunId);
      return run?.status === 'completed' ? run : null;
    });
    expect(completed.directoryPath).toBe(projectPath);
    expect(completed.nodes.inspect?.output).toContain(projectPath);
    expect(completed.nodes.review?.sessionId).toBeTruthy();
    expect(completed.nodes.review?.output).toContain('workflow review complete');

    const workflowShowResult = await runCliCommand(
      ['workflow', 'show', workflowRunId, '--json'],
      '../../src/cli/workflow-commands.js',
      'workflow',
    );
    const workflowShowPayload = parseJsonLog(workflowShowResult.logs) as {
      run?: { id?: string; status?: string; directoryPath?: string };
    };
    expect(workflowShowPayload.run?.id).toBe(workflowRunId);
    expect(workflowShowPayload.run?.status).toBe('completed');
    expect(workflowShowPayload.run?.directoryPath).toBe(projectPath);

    const workflowRunsResult = await runCliCommand(
      ['workflow', 'runs', '--json'],
      '../../src/cli/workflow-commands.js',
      'workflow',
    );
    const workflowRunsPayload = parseJsonLog(workflowRunsResult.logs) as {
      runs?: Array<{ id?: string; status?: string }>;
    };
    expect(workflowRunsPayload.runs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: workflowRunId, status: 'completed' })]),
    );
  });

  it('accepts the full v1 schema (outputs, artifacts, retry, timeout, env, policy) end-to-end', async () => {
    // Regression coverage: a stale daemon dist used to drop these fields from the
    // node base schema, so any template shipping with structured outputs failed
    // at parse time with "Unrecognized key: outputs". Run the richest legal
    // shape we ship through the full CLI pipeline so a future schema regression
    // breaks here, not in production.
    harness = await FullstackCliHarness.start();
    const projectPath = await harness.createGitProject();
    const workflowPath = path.join(projectPath, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: rich-schema-proof
title: Rich schema proof
inputs:
  brief:
    type: string
    default: ship the change
nodes:
  inspect:
    type: shell
    title: Inspect repository state
    command: "echo {{ inputs.brief }}"
    timeoutSeconds: 60
    retry:
      maxAttempts: 2
      backoffSeconds: 1
    env:
      EXTRA_NOTE:
        value: workflow-fixture
    outputs:
      summary:
        type: string
        description: Captured stdout of the inspect step.
    artifacts:
      report:
        path: artifacts/inspect-report.md
        type: report
        description: Stub artifact path reserved by the schema.
    policy:
      onFailure: halt
  review:
    type: prompt
    title: Review the inspected state
    needs:
      - inspect
    agent: fake
    prompt: "Review this state: {{ nodes.inspect.outputs.summary }}"
    policy:
      approvalRequired: false
`,
      'utf-8',
    );

    const runResult = await runCliCommand(
      ['workflow', 'run', workflowPath, '--directory', projectPath, '--detach', '--json'],
      '../../src/cli/workflow-commands.js',
      'workflow',
    );
    const runPayload = parseJsonLog(runResult.logs) as { run?: { id?: string; status?: string } };
    expect(runResult.errors).toEqual([]);
    expect(['queued', 'running']).toContain(runPayload.run?.status);
    const runId = String(runPayload.run!.id);

    const session = await waitFor(async () => {
      const run = await harness!.daemonInstance.workflowRunner.getRun(runId);
      if (!run?.nodes.review?.sessionId) return null;
      return harness!.fakeAdapter.getLatestSession();
    });
    session.emitMessage({
      type: 'agent_message',
      text: 'review acknowledged',
      messageId: 'rich-schema-review',
      timestamp: Date.now(),
    });
    session.state = 'idle';
    session.emit('state-change', 'idle');

    const completed = await waitFor(async () => {
      const run = await harness!.daemonInstance.workflowRunner.getRun(runId);
      return run?.status === 'completed' ? run : null;
    });
    expect(completed.nodes.inspect?.status).toBe('completed');
    expect(completed.nodes.inspect?.output).toContain('ship the change');
    expect(completed.nodes.review?.output).toContain('review acknowledged');
  });
});
