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

// This e2e boots a real HTTP+WS server and drives full workflow runs against a
// registered repo, spawning git subprocesses. Under the parallel fork pool on
// slower/loaded CI runners it approaches the default 15s ceiling, causing
// intermittent timeout flakes. 60s matches the sibling fullstack e2e budget.
describe('fullstack CLI workflow commands', { timeout: 60_000 }, () => {
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
    const workflowPath = path.join(projectPath, '.viewport', 'workflows', 'fullstack.yaml');
    await fs.mkdir(path.dirname(workflowPath), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, '.viewport', 'config.yaml'),
      ['version: 1', 'workflows:', '  fullstack: .viewport/workflows/fullstack.yaml', ''].join(
        '\n',
      ),
      'utf-8',
    );
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

    const validateResult = await runCliCommand(
      ['workflow', 'validate', workflowPath, '--json'],
      '../../src/cli/workflow-commands.js',
      'workflow',
    );
    const validatePayload = parseJsonLog(validateResult.logs) as {
      workflow?: { name?: string; nodeCount?: number };
    };
    expect(validateResult.errors).toEqual([]);
    expect(validatePayload.workflow?.name).toBe('fullstack-workflow-proof');
    expect(validatePayload.workflow?.nodeCount).toBe(2);

    const workflowRunResult = await runCliCommand(
      ['workflow', 'run', 'fullstack', '--path', projectPath, '--detach', '--json'],
      '../../src/cli/workflow-commands.js',
      'workflow',
    );
    const workflowRunPayload = parseJsonLog(workflowRunResult.logs) as {
      run?: { id?: string; status?: string };
      workflow_contract?: { id?: string; status?: string; digest_status?: string };
      manifest_digest?: string;
      resource_manifest?: { config_files?: string[] };
    };
    expect(['queued', 'running']).toContain(workflowRunPayload.run?.status);
    expect(workflowRunPayload.run?.id).toBeTruthy();
    expect(workflowRunPayload.workflow_contract).toMatchObject({
      id: 'fullstack',
      status: 'verified',
      digest_status: 'unpinned',
    });
    expect(workflowRunPayload.manifest_digest).toMatch(/^sha256:/);
    expect(workflowRunPayload.resource_manifest?.config_files).toContain(
      path.join(projectPath, '.viewport', 'config.yaml'),
    );
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
  }, 20_000);

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
  }, 20_000);

  it('runs a workflow with structured json input from the local CLI', async () => {
    harness = await FullstackCliHarness.start();
    const projectPath = await harness.createGitProject();
    const workflowPath = path.join(projectPath, 'json-input-workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: cli-json-input-proof
title: CLI JSON input proof
inputs:
  integration_event:
    type: json
    required: true
nodes:
  summarize:
    type: shell
    title: Summarize integration event
    command: "printf '{{ inputs.integration_event.provider }}:{{ inputs.integration_event.payload.issue }}:{{ inputs.integration_event.payload.count }}'"
`,
      'utf-8',
    );

    const jsonInput = JSON.stringify({
      provider: 'linear',
      payload: {
        issue: 'ENG-42',
        count: 3,
      },
    });
    const runResult = await runCliCommand(
      [
        'workflow',
        'run',
        workflowPath,
        '--directory',
        projectPath,
        '--input-json',
        `integration_event=${jsonInput}`,
        '--json',
      ],
      '../../src/cli/workflow-commands.js',
      'workflow',
    );
    const runPayload = parseJsonLog(runResult.logs) as { run?: { id?: string; status?: string } };
    expect(runResult.errors).toEqual([]);
    expect(runPayload.run?.status).toBe('completed');

    const completed = await harness.daemonInstance.workflowRunner.getRun(
      String(runPayload.run!.id),
    );
    expect(completed?.inputs.integration_event).toEqual({
      provider: 'linear',
      payload: {
        issue: 'ENG-42',
        count: 3,
      },
    });
    expect(completed?.nodes.summarize?.output).toBe('linear:ENG-42:3');
  }, 20_000);

  it('reruns a completed local workflow from its immutable run snapshot', async () => {
    harness = await FullstackCliHarness.start();
    const projectPath = await harness.createGitProject();
    const workflowPath = path.join(projectPath, 'rerun-workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: rerun-proof
title: Rerun proof
nodes:
  inspect:
    type: shell
    command: "printf rerunnable"
`,
      'utf-8',
    );

    const firstRunResult = await runCliCommand(
      ['workflow', 'run', workflowPath, '--directory', projectPath, '--json'],
      '../../src/cli/workflow-commands.js',
      'workflow',
    );
    const firstRunPayload = parseJsonLog(firstRunResult.logs) as {
      run?: { id?: string; status?: string };
    };
    expect(firstRunPayload.run?.status).toBe('completed');
    const firstRunId = String(firstRunPayload.run!.id);

    const rerunResult = await runCliCommand(
      ['workflow', 'rerun', firstRunId, '--json'],
      '../../src/cli/workflow-commands.js',
      'workflow',
    );
    const rerunPayload = parseJsonLog(rerunResult.logs) as {
      run?: { id?: string; status?: string };
    };
    expect(rerunPayload.run?.status).toBe('completed');
    const rerunId = String(rerunPayload.run!.id);
    expect(rerunId).not.toBe(firstRunId);

    const rerun = await harness.daemonInstance.workflowRunner.getRun(rerunId);
    expect(rerun?.rerunOfWorkflowRunId).toBe(firstRunId);
    expect(rerun?.directoryPath).toBe(projectPath);
    expect(rerun?.yamlSnapshot).toContain('name: rerun-proof');
    expect(rerun?.nodes.inspect?.output).toBe('rerunnable');
    expect(rerun?.events.some((event) => event.type === 'run-rerun-requested')).toBe(true);
  }, 20_000);

  it('cancels a running workflow from the local CLI', async () => {
    harness = await FullstackCliHarness.start();
    const projectPath = await harness.createGitProject();
    const workflowPath = path.join(projectPath, 'cancel-workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: cancel-proof
title: Cancel proof
nodes:
  review:
    type: prompt
    title: Long running review
    agent: fake
    prompt: "Wait for cancellation"
`,
      'utf-8',
    );

    const runResult = await runCliCommand(
      ['workflow', 'run', workflowPath, '--directory', projectPath, '--detach', '--json'],
      '../../src/cli/workflow-commands.js',
      'workflow',
    );
    const runId = String((parseJsonLog(runResult.logs) as { run?: { id?: string } }).run?.id);

    await waitFor(async () => {
      const run = await harness!.daemonInstance.workflowRunner.getRun(runId);
      return run?.nodes.review?.sessionId ? run : null;
    });

    const cancelResult = await runCliCommand(
      ['workflow', 'cancel', runId, '--message', 'Stopped from CLI', '--json'],
      '../../src/cli/workflow-commands.js',
      'workflow',
    );
    const cancelPayload = parseJsonLog(cancelResult.logs) as {
      run?: {
        id?: string;
        status?: string;
        error?: string;
        nodes?: Record<string, { status?: string; error?: string }>;
      };
    };

    expect(cancelPayload.run?.id).toBe(runId);
    expect(cancelPayload.run?.status).toBe('canceled');
    expect(cancelPayload.run?.error).toBe('Stopped from CLI');
    expect(cancelPayload.run?.nodes?.review?.status).toBe('canceled');
    expect(cancelPayload.run?.nodes?.review?.error).toBe('Stopped from CLI');
  }, 20_000);

  it('routes a branch via when expressions and skips the unselected leg', async () => {
    // Proves the v2 wedge: structured outputs feed JSONata `when:` expressions,
    // matching nodes run, the unmatched branch is `skipped`, and a downstream
    // node with triggerRule=one_success consumes whichever branch fired.
    harness = await FullstackCliHarness.start();
    const projectPath = await harness.createGitProject();
    const workflowPath = path.join(projectPath, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: branching-proof
title: Branching proof
nodes:
  classify:
    type: shell
    command: 'printf %s ''{"type":"BUG","priority":"P0"}'''
    outputs:
      payload:
        type: json
        description: Structured classification.
  bug_branch:
    type: shell
    needs: [classify]
    when: 'nodes.classify.outputs.payload.type = "BUG"'
    command: 'echo handled-bug'
  feature_branch:
    type: shell
    needs: [classify]
    when: 'nodes.classify.outputs.payload.type = "FEATURE"'
    command: 'echo handled-feature'
  notify:
    type: shell
    needs: [bug_branch, feature_branch]
    triggerRule: one_success
    command: 'echo notify-from-{{ nodes.bug_branch.status }}-{{ nodes.feature_branch.status }}'
`,
      'utf-8',
    );

    const runResult = await runCliCommand(
      ['workflow', 'run', workflowPath, '--directory', projectPath, '--detach', '--json'],
      '../../src/cli/workflow-commands.js',
      'workflow',
    );
    expect(runResult.errors).toEqual([]);
    const runId = String((parseJsonLog(runResult.logs) as { run?: { id?: string } }).run?.id);

    const completed = await waitFor(async () => {
      const run = await harness!.daemonInstance.workflowRunner.getRun(runId);
      return run?.status === 'completed' ? run : null;
    });

    expect(completed.nodes.classify?.status).toBe('completed');
    expect(completed.nodes.classify?.outputs).toEqual({
      payload: { type: 'BUG', priority: 'P0' },
    });
    expect(completed.nodes.bug_branch?.status).toBe('completed');
    expect(completed.nodes.bug_branch?.output).toContain('handled-bug');
    expect(completed.nodes.feature_branch?.status).toBe('skipped');
    expect(completed.nodes.feature_branch?.skipReason).toContain('when:');
    expect(completed.nodes.notify?.status).toBe('completed');
    expect(completed.nodes.notify?.output).toContain('completed');
    expect(completed.nodes.notify?.output).toContain('skipped');
  });
});
