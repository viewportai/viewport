import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Daemon } from '../../src/core/daemon.js';
import { waitForCondition } from './support/workflow-runner-support.js';

describe('workflow runner platform sync', () => {
  it('does not auto-apply platform approval commands for managed worker runs', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-home-'));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-project-'));
    const originalHome = process.env['HOME'];
    const originalCodexHome = process.env['CODEX_HOME'];
    const originalViewportHome = process.env['VIEWPORT_HOME'];
    const originalVpdHome = process.env['VPD_HOME'];
    const originalCwd = process.cwd();
    process.env['HOME'] = tempHome;
    process.env['CODEX_HOME'] = path.join(tempHome, '.codex');
    process.env['VIEWPORT_HOME'] = path.join(tempHome, '.viewport');
    delete process.env['VPD_HOME'];
    process.chdir(tempHome);

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { id: 'platform-run-approval' },
          runtime_commands: [
            {
              id: 'plan-review:auto-apply-proof',
              type: 'workflow.approval_decision',
              workflow_run_id: 'local-run-approval',
              workflow_node_id: 'review',
              approved: true,
              decision: 'approve',
              message: 'Approved by platform.',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;

    try {
      const viewportDir = path.join(tempHome, '.viewport');
      const runsDir = path.join(viewportDir, 'runs', 'workflows');
      await fs.mkdir(runsDir, { recursive: true });
      await fs.writeFile(
        path.join(viewportDir, 'config.json'),
        JSON.stringify({
          machineId: 'machine-1',
          daemon: {
            server: { url: 'http://127.0.0.1:7777' },
            relay: {
              serverUrl: 'http://127.0.0.1:7777',
              workspaceId: 'project-1',
              runtimeTargetId: 'binding-1',
              issueToken: 'issue-token',
            },
          },
        }),
        'utf-8',
      );

      await fs.writeFile(
        path.join(runsDir, 'local-run-approval.json'),
        JSON.stringify({
          id: 'local-run-approval',
          workflowName: 'managed-worker-approval-proof',
          sourceType: 'viewport_snapshot',
          sourcePath: 'viewport://test-managed-worker-approval-proof',
          digest: 'test-digest',
          schema: 'viewport.workflow/v1',
          yamlSnapshot:
            'schema: viewport.workflow/v1\nname: managed-worker-approval-proof\nnodes:\n  review:\n    type: plan\n    body: test\n',
          directoryId: 'dir-1',
          directoryPath: projectDir,
          resourceId: 'project-1',
          runtimeTargetId: 'binding-1',
          platformRunId: 'platform-run-approval',
          machineId: 'machine-1',
          initiation: 'cli',
          status: 'blocked',
          inputs: {},
          preflight: { ok: true, issues: [] },
          nodes: {
            review: {
              id: 'review',
              type: 'plan',
              status: 'blocked',
              output: 'test',
              approval: {
                prompt: 'Approve review?',
                requestedAt: 2_000,
              },
            },
          },
          artifacts: [],
          events: [],
          createdAt: 1_000,
          startedAt: 1_500,
          updatedAt: 2_000,
        }),
        'utf-8',
      );

      const daemon = new Daemon();
      await daemon.configManager.load();
      const result = await daemon.workflowRunner.resumePendingRuns();

      expect(result.platformSyncScheduled).toBe(1);
      await waitForCondition(() => fetchMock.mock.calls.length > 0);

      const run = await daemon.workflowRunner.getRun('local-run-approval');
      expect(run?.status).toBe('blocked');
      expect(run?.nodes.review?.status).toBe('blocked');
      expect(run?.nodes.review?.approval?.approved).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
      else process.env['CODEX_HOME'] = originalCodexHome;
      if (originalViewportHome === undefined) delete process.env['VIEWPORT_HOME'];
      else process.env['VIEWPORT_HOME'] = originalViewportHome;
      if (originalVpdHome === undefined) delete process.env['VPD_HOME'];
      else process.env['VPD_HOME'] = originalVpdHome;
      process.chdir(originalCwd);
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('resyncs platform-linked terminal runs when the daemon starts', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-home-'));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-workflow-project-'));
    const originalHome = process.env['HOME'];
    const originalCodexHome = process.env['CODEX_HOME'];
    const originalViewportHome = process.env['VIEWPORT_HOME'];
    const originalVpdHome = process.env['VPD_HOME'];
    const originalCwd = process.cwd();
    process.env['HOME'] = tempHome;
    process.env['CODEX_HOME'] = path.join(tempHome, '.codex');
    process.env['VIEWPORT_HOME'] = path.join(tempHome, '.viewport');
    delete process.env['VPD_HOME'];
    process.chdir(tempHome);

    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock;

    try {
      const viewportDir = path.join(tempHome, '.viewport');
      const runsDir = path.join(viewportDir, 'runs', 'workflows');
      await fs.mkdir(runsDir, { recursive: true });
      await fs.writeFile(
        path.join(viewportDir, 'config.json'),
        JSON.stringify({
          machineId: 'machine-1',
          daemon: {
            server: { url: 'http://127.0.0.1:7777' },
            relay: {
              serverUrl: 'http://127.0.0.1:7777',
              workspaceId: 'project-1',
              runtimeTargetId: 'binding-1',
              issueToken: 'issue-token',
            },
          },
        }),
        'utf-8',
      );

      const runId = crypto.randomUUID();
      await fs.writeFile(
        path.join(runsDir, `${runId}.json`),
        JSON.stringify({
          id: runId,
          workflowName: 'boot-sync-proof',
          sourceType: 'viewport_snapshot',
          sourcePath: 'viewport://test-boot-sync',
          digest: 'test-digest',
          schema: 'viewport.workflow/v1',
          yamlSnapshot: 'schema: viewport.workflow/v1\nname: boot-sync-proof\nnodes: {}\n',
          directoryId: 'dir-1',
          directoryPath: projectDir,
          resourceId: 'project-1',
          runtimeTargetId: 'binding-1',
          platformRunId: 'platform-run-1',
          machineId: 'machine-1',
          initiation: 'browser',
          status: 'completed',
          inputs: {},
          preflight: { ok: true, issues: [] },
          nodes: {
            done: {
              id: 'done',
              type: 'shell',
              status: 'completed',
              output: 'ok',
              completedAt: 2_000,
            },
          },
          artifacts: [],
          events: [
            {
              id: 'event-1',
              runId,
              timestamp: 2_000,
              type: 'run-completed',
              message: 'Workflow run completed',
            },
          ],
          createdAt: 1_000,
          startedAt: 1_500,
          updatedAt: 2_000,
          completedAt: 2_000,
        }),
        'utf-8',
      );

      const daemon = new Daemon();
      await daemon.configManager.load();
      const result = await daemon.workflowRunner.resumePendingRuns();

      expect(result.resumed).toBe(0);
      expect(result.platformSyncScheduled).toBe(1);
      await waitForCondition(() => fetchMock.mock.calls.length > 0);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        'http://127.0.0.1:7777/api/runtime/workspaces/project-1/workflow-runs/platform-run-1/sync',
      );
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({
        runtime_run_id: runId,
        status: 'completed',
        output_snapshot: { done: 'ok' },
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
      else process.env['CODEX_HOME'] = originalCodexHome;
      if (originalViewportHome === undefined) delete process.env['VIEWPORT_HOME'];
      else process.env['VIEWPORT_HOME'] = originalViewportHome;
      if (originalVpdHome === undefined) delete process.env['VPD_HOME'];
      else process.env['VPD_HOME'] = originalVpdHome;
      process.chdir(originalCwd);
      await fs.rm(tempHome, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});
