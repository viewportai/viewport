import { describe, expect, it, vi } from 'vitest';
import { WorkflowRuntimeCommandApplier } from '../../src/workflows/platform-command-applier.js';
import type { WorkflowRunStore } from '../../src/workflows/store.js';
import type { WorkflowApprovalDecision, WorkflowRunRecord } from '../../src/workflows/types.js';

describe('WorkflowRuntimeCommandApplier', () => {
  it('applies platform approval commands to matching blocked nodes', async () => {
    const run = blockedRun();
    const decisions: Array<{ runId: string; nodeId: string; decision: WorkflowApprovalDecision }> =
      [];
    const applier = new WorkflowRuntimeCommandApplier(
      storeWith([run]),
      async (runId, nodeId, decision) => {
        decisions.push({ runId, nodeId, decision });
        return run;
      },
    );

    await applier.apply({
      id: 'plan-review:1',
      type: 'workflow.approval_decision',
      workflow_run_id: run.id,
      workflow_node_id: 'review',
      approved: true,
      message: 'Approved.',
      actor: { id: 123, name: 'Reviewer', source: 'platform', ignored: { nested: true } },
      feedback: { annotations: [{ body: 'Ship it.' }] },
    });

    expect(decisions).toEqual([
      {
        runId: run.id,
        nodeId: 'review',
        decision: {
          approved: true,
          message: 'Approved.',
          actor: { id: '123', name: 'Reviewer', source: 'platform' },
          feedback: { annotations: [{ body: 'Ship it.' }] },
        },
      },
    ]);
  });

  it('scopes commands without runtime ids to the synced run only', async () => {
    const first = blockedRun('first-run');
    const second = blockedRun('second-run');
    const decisions: Array<{ runId: string; nodeId: string }> = [];
    const applier = new WorkflowRuntimeCommandApplier(
      storeWith([first, second]),
      async (runId, nodeId) => {
        decisions.push({ runId, nodeId });
        return runId === first.id ? first : second;
      },
    );

    const applied = await applier.apply(
      {
        id: 'plan-review:scoped',
        type: 'workflow.approval_decision',
        workflow_node_id: 'review',
        approved: true,
      },
      second.id,
    );

    expect(applied).toBe(true);
    expect(decisions).toEqual([{ runId: second.id, nodeId: 'review' }]);
  });

  it('ignores commands when the run or node is not blocked', async () => {
    const blocked = blockedRun();
    const running = { ...blockedRun('run-running'), status: 'running' as const };
    const decider = vi.fn(async (run: string) => ({ ...blocked, id: run }));
    const applier = new WorkflowRuntimeCommandApplier(storeWith([blocked, running]), decider);

    const missingRunApplied = await applier.apply({
      id: 'other-run',
      type: 'workflow.approval_decision',
      workflow_run_id: 'missing-run',
      workflow_node_id: 'review',
      approved: true,
    });
    const runningRunApplied = await applier.apply({
      id: 'running-run',
      type: 'workflow.approval_decision',
      workflow_run_id: running.id,
      workflow_node_id: 'review',
      approved: true,
    });

    expect(missingRunApplied).toBe(false);
    expect(runningRunApplied).toBe(false);
    expect(decider).not.toHaveBeenCalled();
  });
});

function storeWith(runs: WorkflowRunRecord[]): WorkflowRunStore {
  return {
    list: async () => runs,
  } as WorkflowRunStore;
}

function blockedRun(id = 'runtime-run-1'): WorkflowRunRecord {
  return {
    id,
    workflowName: 'team/pr-review',
    workflowTitle: 'Pull request review',
    sourceType: 'viewport_snapshot',
    digest: 'sha256:run',
    schema: 'viewport.workflow/v1',
    yamlSnapshot: 'schema: viewport.workflow/v1\nname: team/pr-review\nnodes: {}\n',
    directoryId: 'dir-1',
    directoryPath: '/repo',
    projectId: 'project-1',
    projectMachineBindingId: 'binding-1',
    platformRunId: 'platform-run-1',
    machineId: 'machine-1',
    initiation: 'browser',
    status: 'blocked',
    inputs: {},
    preflight: { ok: true, issues: [] },
    nodes: {
      review: {
        id: 'review',
        type: 'plan',
        title: 'Review plan',
        status: 'blocked',
      },
    },
    artifacts: [],
    events: [],
    createdAt: 1_000,
    startedAt: 1_500,
    updatedAt: 1_000,
  };
}
