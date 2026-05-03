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

describe('workflow runner retry and resume', () => {
  beforeEach(async () => {});
  afterEach(cleanup);
  it('retries a transient shell failure and succeeds on a later attempt', async () => {
    const daemon = await setup();
    const counterFile = path.join(projectDir, 'attempts.txt');
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    // Body: increment counter, fail with "rate limit" while the counter is
    // below 3, then printf "ok". Combined with retry.transient=['rate limit']
    // and maxAttempts=5 the runner should hit success on the third try.
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: retry-transient-proof
nodes:
  flaky:
    type: shell
    command: |
      attempts=$(cat ${counterFile} 2>/dev/null || echo 0)
      attempts=$((attempts+1))
      printf %s "$attempts" > ${counterFile}
      if [ "$attempts" -lt 3 ]; then
        echo "rate limit reached" >&2
        exit 1
      fi
      printf ok
    retry:
      maxAttempts: 5
      transient:
        - rate limit
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
    expect(completed?.nodes.flaky?.status).toBe('completed');
    expect(completed?.nodes.flaky?.output).toBe('ok');
    const retries = (completed?.events ?? []).filter((event) => event.type === 'node-retry');
    expect(retries).toHaveLength(2);
    expect(await fs.readFile(counterFile, 'utf-8')).toBe('3');
  });

  it('fails fast on a fatal classifier match without burning the retry budget', async () => {
    const daemon = await setup();
    const counterFile = path.join(projectDir, 'fatal-attempts.txt');
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: retry-fatal-proof
nodes:
  busted:
    type: shell
    command: |
      attempts=$(cat ${counterFile} 2>/dev/null || echo 0)
      attempts=$((attempts+1))
      printf %s "$attempts" > ${counterFile}
      echo "permission denied" >&2
      exit 1
    retry:
      maxAttempts: 5
      fatal:
        - permission denied
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

    expect(completed?.status).toBe('failed');
    expect(completed?.nodes.busted?.status).toBe('failed');
    expect(completed?.nodes.busted?.attempts).toBe(1);
    const retries = (completed?.events ?? []).filter((event) => event.type === 'node-retry');
    expect(retries).toHaveLength(0);
    expect(await fs.readFile(counterFile, 'utf-8')).toBe('1');
  });

  it('resumes a workflow run that was mid-flight when the daemon restarted', async () => {
    // Simulates a crash by hand-writing a run record that looks mid-flight
    // (status running, node 'one' status running) then calling
    // resumePendingRuns. We bypass startRun() so there's no in-flight
    // executor racing with the resume — that mirrors the real boot path
    // where the daemon process just started and nothing else is running.
    const daemon = await setup();
    const yaml = `
schema: viewport.workflow/v1
name: resume-proof
nodes:
  one:
    type: shell
    command: 'printf one'
  two:
    type: shell
    needs: [one]
    command: 'printf two'
`;
    const runId = crypto.randomUUID();
    const directoryId = DirectoryManager.idFromPath(projectDir);
    const runsDir = path.join(tempHome, '.viewport', 'runs', 'workflows');
    await fs.mkdir(runsDir, { recursive: true });
    const now = Date.now();
    const record = {
      id: runId,
      workflowName: 'resume-proof',
      sourceType: 'viewport_snapshot',
      sourcePath: 'viewport://test-resume',
      digest: 'test-digest',
      schema: 'viewport.workflow/v1',
      yamlSnapshot: yaml,
      directoryId,
      directoryPath: projectDir,
      machineId: daemon.configManager.getMachineId(),
      initiation: 'cli',
      status: 'running',
      inputs: {},
      preflight: { ok: true, issues: [] },
      nodes: {
        one: { id: 'one', type: 'shell', status: 'running' },
        two: { id: 'two', type: 'shell', status: 'queued' },
      },
      artifacts: [],
      events: [],
      createdAt: now - 10_000,
      updatedAt: now - 5_000,
    };
    await fs.writeFile(path.join(runsDir, `${runId}.json`), JSON.stringify(record), 'utf-8');

    const result = await daemon.workflowRunner.resumePendingRuns();
    expect(result.resumed).toBeGreaterThan(0);

    await waitForTerminalRun(daemon, runId);
    const completed = await daemon.workflowRunner.getRun(runId);
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.one?.output).toBe('one');
    expect(completed?.nodes.two?.output).toBe('two');
    const events = completed?.events.map((event) => event.message) ?? [];
    expect(events.some((message) => message.includes('resumed'))).toBe(true);
  });

  it('falls through a failed sibling when a downstream node uses triggerRule one_success', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: trigger-rule-proof
nodes:
  unstable:
    type: shell
    command: 'exit 7'
    policy:
      onFailure: continue
  reliable:
    type: shell
    command: 'printf reliable'
    outputs:
      mark:
        type: string
  notify:
    type: shell
    needs: [unstable, reliable]
    triggerRule: one_success
    command: 'printf notify-{{ nodes.reliable.outputs.mark }}'
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
    expect(completed?.nodes.unstable?.status).toBe('failed');
    expect(completed?.nodes.reliable?.status).toBe('completed');
    expect(completed?.nodes.notify?.status).toBe('completed');
    expect(completed?.nodes.notify?.output).toBe('notify-reliable');
  });
});
