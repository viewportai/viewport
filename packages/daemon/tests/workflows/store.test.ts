import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkflowRunStore } from '../../src/workflows/store.js';
import type { WorkflowRunEvent, WorkflowRunRecord } from '../../src/workflows/types.js';

describe('workflow run store', () => {
  it('persists, lists, reads, and appends workflow events', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-run-store-'));
    try {
      const store = new WorkflowRunStore(rootDir);
      const older = makeRun({ id: 'older', createdAt: 1 });
      const newer = makeRun({ id: 'newer', createdAt: 2 });

      expect(await store.get('missing')).toBeNull();
      expect(await store.list()).toEqual([]);

      await store.save(older);
      await store.save(newer);

      expect((await store.list()).map((run) => run.id)).toEqual(['newer', 'older']);
      expect((await store.list(1)).map((run) => run.id)).toEqual(['newer']);
      expect(await store.get('older')).toEqual(older);

      const event: WorkflowRunEvent = {
        id: 'event-1',
        runId: 'older',
        timestamp: 3,
        type: 'node-completed',
        nodeId: 'proof',
        message: 'Node proof completed',
      };

      const updated = await store.appendEvent('older', event);
      expect(updated.updatedAt).toBe(3);
      expect(updated.events).toContainEqual(event);
      await expect(store.appendEvent('missing', event)).rejects.toThrow(/not found/);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('preserves out-of-band events when a later save uses an older event snapshot', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-run-store-'));
    try {
      const store = new WorkflowRunStore(rootDir);
      const run = makeRun({ id: 'run-1', createdAt: 1 });
      await store.save(run);

      const hookEvent: WorkflowRunEvent = {
        id: 'event-hook',
        runId: run.id,
        timestamp: 2,
        type: 'hook-fired',
        nodeId: 'proof',
        message: 'Workflow hook fired',
      };
      await store.appendEvent(run.id, hookEvent);

      const staleRunnerSnapshot = {
        ...run,
        status: 'completed' as const,
        updatedAt: 3,
        completedAt: 3,
        events: run.events,
      };
      await store.save(staleRunnerSnapshot);

      const saved = await store.get(run.id);
      expect(saved?.events).toContainEqual(hookEvent);
      expect(saved?.updatedAt).toBe(3);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('preserves terminal node state when a later save uses a stale node snapshot', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-run-store-'));
    try {
      const store = new WorkflowRunStore(rootDir);
      const run = makeRun({ id: 'run-1', createdAt: 1 });
      await store.save({
        ...run,
        status: 'running',
        completedAt: undefined,
        nodes: {
          proof: {
            id: 'proof',
            type: 'shell',
            status: 'running',
            startedAt: 1,
          },
        },
      });
      await store.save({
        ...run,
        status: 'completed',
        updatedAt: 2,
        completedAt: 2,
        nodes: {
          proof: {
            id: 'proof',
            type: 'shell',
            status: 'completed',
            startedAt: 1,
            completedAt: 2,
            output: 'done',
            exitCode: 0,
          },
        },
      });
      await store.save({
        ...run,
        status: 'running',
        updatedAt: 3,
        completedAt: undefined,
        nodes: {
          proof: {
            id: 'proof',
            type: 'shell',
            status: 'running',
            startedAt: 1,
          },
        },
      });

      const saved = await store.get(run.id);
      expect(saved?.status).toBe('completed');
      expect(saved?.completedAt).toBe(2);
      expect(saved?.nodes.proof).toMatchObject({
        status: 'completed',
        output: 'done',
        exitCode: 0,
        completedAt: 2,
      });
      expect(saved?.updatedAt).toBe(3);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

function makeRun(overrides: { id: string; createdAt: number }): WorkflowRunRecord {
  return {
    id: overrides.id,
    workflowName: 'proof',
    sourceType: 'local_file',
    sourcePath: '/tmp/workflow.yaml',
    digest: 'abc',
    schema: 'viewport.workflow/v1',
    yamlSnapshot: 'schema: viewport.workflow/v1',
    directoryId: 'dir-1',
    directoryPath: '/tmp/project',
    machineId: 'machine-1',
    initiation: 'cli',
    status: 'completed',
    inputs: {},
    preflight: { ok: true, issues: [] },
    nodes: {
      proof: {
        id: 'proof',
        type: 'shell',
        status: 'completed',
      },
    },
    events: [],
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
    completedAt: overrides.createdAt,
  };
}
