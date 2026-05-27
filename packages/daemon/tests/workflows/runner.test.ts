import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { DirectoryManager } from '../../src/directories/manager.js';
import { workflowRunToSyncPayload } from '../../src/workflows/platform-sync-payload.js';
import { waitForRunState, waitForTerminalRun } from './support/workflow-runner-support.js';

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
  it('runs a shell workflow and persists run history', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-proof
nodes:
  proof:
    type: shell
    command: printf "ok"
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
    const runs = await daemon.workflowRunner.listRuns();

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.proof?.output).toBe('ok');
    expect(completed?.nodes.proof?.exitCode).toBe(0);
    expect(completed?.nodes.proof?.metadata?.['shell_execution']).toMatchObject({
      schema: 'viewport.shell_execution_receipt/v1',
      node_id: 'proof',
      status: 'completed',
      executor: {
        kind: 'shell',
        command: 'sh',
        args: ['-lc'],
      },
      command_digest: expect.stringMatching(/^sha256:/),
      command_persisted: false,
      cwd: projectDir,
      cwd_digest: expect.stringMatching(/^sha256:/),
      env_keys: [],
      env_values_persisted: false,
      timeout_seconds: null,
      exit_code: 0,
      denial: null,
      authority: expect.objectContaining({
        source: 'legacy_local',
        authority_contract_present: false,
      }),
    });
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'node-log',
        nodeId: 'proof',
        data: expect.objectContaining({ source: 'stdout', chunk: 'ok' }),
      }),
    );
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'node-output',
        nodeId: 'proof',
        data: { output: 'ok', exitCode: 0 },
      }),
    );
    expect(runs.map((item) => item.id)).toContain(run.id);
  });

  it('records node authority acknowledgement before executing a node', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: node-authority-ack-proof
nodes:
  proof:
    type: shell
    command: printf "ack"
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
    const ack = completed?.nodes.proof?.metadata?.['node_contract_ack'];
    const ackEvent = completed?.events.find(
      (event) => event.type === 'node-contract-acknowledged' && event.nodeId === 'proof',
    );
    const startEvent = completed?.events.find(
      (event) => event.type === 'node-started' && event.nodeId === 'proof',
    );
    const payload = workflowRunToSyncPayload(completed!);
    const syncedNode = (payload.nodes as Array<{ metadata?: Record<string, unknown> }>).find(
      (node) => node.metadata?.['node_contract_ack'],
    );

    expect(completed?.status).toBe('completed');
    expect(ack).toMatchObject({
      schema: 'viewport.node_contract_acknowledgement/v1',
      status: 'acknowledged',
      source: 'daemon_pre_execute',
      node_id: 'proof',
      node_type: 'shell',
      enforcement: expect.objectContaining({
        context: 'enforced',
        repos: 'modeled',
        tools: 'modeled',
        budgets: 'modeled',
      }),
      modeled: ['repos', 'tools', 'budgets'],
    });
    expect(ackEvent).toBeTruthy();
    expect(startEvent).toBeTruthy();
    expect(completed!.events.indexOf(ackEvent!)).toBeLessThan(
      completed!.events.indexOf(startEvent!),
    );
    expect(syncedNode?.metadata?.['node_contract_ack']).toMatchObject({
      status: 'acknowledged',
      source: 'daemon_pre_execute',
    });
  });

  it('injects run-scoped shell env secrets without persisting them as inputs', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-secret-env-proof
nodes:
  proof:
    type: shell
    env:
      CHECKOUT_TOKEN:
        secret: repo/github/payments-api
    command: test "$CHECKOUT_TOKEN" = "ghs_run_scoped_checkout" && printf "ok"
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      runtimeSecretEnv: {
        VIEWPORT_CREDENTIAL_REPO_GITHUB_PAYMENTS_API: 'ghs_run_scoped_checkout',
      },
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);
    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.proof?.output).toBe('ok');
    expect(JSON.stringify(completed?.inputs)).not.toContain('ghs_run_scoped_checkout');
    expect(JSON.stringify(workflowRunToSyncPayload(completed!))).not.toContain(
      'ghs_run_scoped_checkout',
    );
  });

  it('fails closed when a workflow asks for unmaterialized shell env secrets', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-missing-secret-proof
nodes:
  proof:
    type: shell
    env:
      CHECKOUT_TOKEN:
        secret: repo/github/payments-api
    command: printf "should-not-run"
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
    expect(failed?.nodes.proof?.error).toContain('Secret binding repo/github/payments-api');
    expect(failed?.nodes.proof?.output).not.toBe('should-not-run');
  });

  it('cancels a running shell workflow and preserves canceled state', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: shell-cancel-proof
nodes:
  slow:
    type: shell
    command: sleep 10 && printf done
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
      (candidate) => candidate.nodes.slow?.status === 'running',
    );
    const canceled = await daemon.workflowRunner.cancelRun(run.id, {
      message: 'User stopped shell run',
    });
    expect(canceled.status).toBe('canceled');
    expect(canceled.nodes.slow?.status).toBe('canceled');

    await new Promise((resolve) => setTimeout(resolve, 100));
    const saved = await daemon.workflowRunner.getRun(run.id);
    expect(saved?.status).toBe('canceled');
    expect(saved?.nodes.slow?.status).toBe('canceled');
    expect(saved?.nodes.slow?.output).not.toBe('done');
  });

  it('collects declared shell artifacts inside the workflow directory', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: artifact-proof
nodes:
  report:
    type: shell
    command: mkdir -p artifacts && printf "ready" > artifacts/report.txt
    artifacts:
      report:
        path: artifacts/report.txt
        type: report
        description: Review report
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
    expect(completed?.artifacts).toContainEqual(
      expect.objectContaining({
        nodeId: 'report',
        name: 'report',
        kind: 'report',
        path: path.join(projectDir, 'artifacts/report.txt'),
        description: 'Review report',
        metadata: expect.objectContaining({
          declaredPath: 'artifacts/report.txt',
          digest: expect.stringMatching(/^sha256:/),
        }),
      }),
    );
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'artifact-collected',
        nodeId: 'report',
      }),
    );
  });

  it('runs a browser-provided workflow snapshot without requiring a local workflow file', async () => {
    const daemon = await setup();
    const directoryId = DirectoryManager.idFromPath(projectDir);

    const run = await daemon.workflowRunner.startRun({
      workflowYaml: `
schema: viewport.workflow/v1
name: viewport/snapshot-proof
title: Snapshot Proof
nodes:
  proof:
    type: shell
    command: printf "snapshot"
`,
      workflowSourceRef: 'viewport://templates/snapshot-proof',
      directoryId,
      executionPolicy: { mode: 'isolated_worktree' },
      initiation: 'browser',
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.sourceType).toBe('viewport_snapshot');
    expect(completed?.sourcePath).toBe('viewport://templates/snapshot-proof');
    expect(completed?.executionPolicy).toEqual({ mode: 'isolated_worktree' });
    expect(completed?.events.some((event) => event.type === 'execution-policy-selected')).toBe(
      true,
    );
    expect(completed?.nodes.proof?.output).toBe('snapshot');
  });

  it('passes shell output into downstream templates', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: dataflow-proof
nodes:
  first:
    type: shell
    command: printf "upstream"
  second:
    type: shell
    needs: [first]
    command: printf "{{ nodes.first.output }}-downstream"
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
    expect(completed?.nodes.second?.output).toBe('upstream-downstream');
  });

  it('evaluates condition nodes and skips the non-selected branch', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: condition-branch-proof
inputs:
  kind:
    type: string
    required: true
nodes:
  choose:
    type: condition
    expression: inputs.kind = "bug"
    then: [fix_bug]
    else: [update_docs]
  fix_bug:
    type: shell
    needs: [choose]
    command: printf "bug-fixed"
  update_docs:
    type: shell
    needs: [choose]
    command: printf "docs-updated"
  summarize:
    type: shell
    needs: [fix_bug, update_docs]
    triggerRule: one_success
    command: printf "done"
`,
      'utf-8',
    );

    const run = await daemon.workflowRunner.startRun({
      workflowPath,
      directoryId: DirectoryManager.idFromPath(projectDir),
      initiation: 'cli',
      inputs: { kind: 'bug' },
    });

    await waitForTerminalRun(daemon, run.id);
    const completed = await daemon.workflowRunner.getRun(run.id);

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.choose?.output).toBe('true');
    expect(completed?.nodes.choose?.outputs).toMatchObject({
      result: true,
      branch: 'then',
      selected: ['fix_bug'],
      skipped: ['update_docs'],
    });
    expect(completed?.nodes.fix_bug?.status).toBe('completed');
    expect(completed?.nodes.fix_bug?.output).toBe('bug-fixed');
    expect(completed?.nodes.update_docs?.status).toBe('skipped');
    expect(completed?.nodes.update_docs?.skipReason).toBe('condition:choose:then');
    expect(completed?.nodes.summarize?.status).toBe('completed');
    expect(completed?.events).toContainEqual(
      expect.objectContaining({
        type: 'condition-evaluated',
        nodeId: 'choose',
        data: expect.objectContaining({ branch: 'then', result: true }),
      }),
    );
  });

  it('resolves context nodes through configured repo providers', async () => {
    const daemon = await setup();
    await fs.mkdir(path.join(projectDir, '.viewport'), { recursive: true });
    await fs.mkdir(path.join(projectDir, 'docs'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'docs', 'workflow-context.md'),
      'Workflow context proof: attach PAY-1842 checkout runbook before agent execution.',
      'utf-8',
    );
    await fs.writeFile(
      path.join(projectDir, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: repo_docs',
        '      provider: repo-docs',
        '      paths:',
        '        - docs/**/*.md',
        '  resolution:',
        '    size_budget: 16kb',
        '',
      ].join('\n'),
      'utf-8',
    );
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: context-proof
nodes:
  attach_context:
    type: context
    refs:
      - ref: repo_docs
        as: runbook
        required: true
    query: checkout runbook
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
    const output = JSON.parse(completed?.nodes.attach_context?.output ?? '{}');
    const contextEvent = completed?.events.find(
      (event) => event.type === 'node-output' && event.nodeId === 'attach_context',
    );

    expect(completed?.status).toBe('completed');
    expect(completed?.nodes.attach_context?.outputs?.itemCount).toBe(1);
    expect(output.itemCount).toBe(1);
    expect(output.items[0]).toMatchObject({
      provider_id: 'repo_docs',
      provider: 'repo-docs',
      alias: 'runbook',
      title: 'docs/workflow-context.md',
      body: expect.stringContaining('PAY-1842 checkout runbook'),
    });
    expect(contextEvent?.message).toBe('Context node attach_context resolved 1 item');
    expect(contextEvent?.data?.items).toEqual([
      expect.objectContaining({
        provider_id: 'repo_docs',
        title: 'docs/workflow-context.md',
        alias: 'runbook',
        digest: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(completed?.contextReceipts).toEqual([
      expect.objectContaining({
        schema: 'viewport.context_receipt/v1',
        package: 'repo_docs',
        requested: 'repo_docs',
        provider: 'repo-docs',
        digest: expect.stringMatching(/^sha256:/),
        freshness: 'resolved_at_run',
        usedBy: expect.objectContaining({
          runId: run.id,
          nodeId: 'attach_context',
          providerId: 'repo_docs',
          alias: 'runbook',
        }),
        resolvedAt: expect.any(String),
      }),
    ]);
    expect(JSON.stringify(contextEvent?.data)).not.toContain('PAY-1842');
    expect(JSON.stringify(contextEvent?.data)).not.toContain(projectDir);
    expect(JSON.stringify(completed?.contextReceipts)).not.toContain('PAY-1842');
    expect(JSON.stringify(completed?.contextReceipts)).not.toContain('checkout runbook');
    expect(JSON.stringify(completed?.contextReceipts)).not.toContain(projectDir);
    const syncPayload = workflowRunToSyncPayload(completed!, {
      enforceDataCapturePolicy: true,
    });
    expect(syncPayload['context_receipts_snapshot']).toEqual(completed?.contextReceipts);
    expect(JSON.stringify(syncPayload)).not.toContain('PAY-1842');
    expect(JSON.stringify(syncPayload)).not.toContain('checkout runbook');
    expect(JSON.stringify(syncPayload)).not.toContain(projectDir);
    expect(syncPayload['evidence_packets']).toEqual([]);
    expect(syncPayload).toMatchObject({
      output_snapshot: {
        nodes: {
          attach_context: {
            output: 'Context node output redacted by workflow data capture policy.',
            outputs: {
              redacted: true,
              itemCount: 1,
            },
          },
        },
      },
      nodes: [
        expect.objectContaining({
          node_key: 'attach_context',
          output: 'Context node output redacted by workflow data capture policy.',
          output_snapshot: {
            redacted: true,
            itemCount: 1,
          },
        }),
      ],
    });
  });

  it('fails context nodes when a required provider is unavailable', async () => {
    const daemon = await setup();
    const workflowPath = path.join(projectDir, 'workflow.yaml');
    await fs.writeFile(
      workflowPath,
      `
schema: viewport.workflow/v1
name: missing-context-proof
nodes:
  attach_context:
    type: context
    refs:
      - ref: missing_docs
        required: true
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
    expect(failed?.nodes.attach_context?.status).toBe('failed');
    expect(failed?.nodes.attach_context?.error).toMatch(
      /missing required provider\(s\): missing_docs/,
    );
  });
});
