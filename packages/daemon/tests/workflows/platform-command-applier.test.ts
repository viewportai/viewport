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
      decision: 'approve',
      message: 'Approved.',
      expected_action_digest: 'sha256:reviewed',
      execution_grant: {
        schema: 'viewport.execution_grant/v1',
        digest: 'sha256:grant',
        proposal_key: 'action:review',
        approval_decision_key: 'approve-review',
      },
      actor: { id: 123, name: 'Reviewer', source: 'platform', ignored: { nested: true } },
      feedback: { annotations: [{ body: 'Ship it.' }] },
    });

    expect(decisions).toEqual([
      {
        runId: run.id,
        nodeId: 'review',
        decision: {
          approved: true,
          decision: 'approve',
          message: 'Approved.',
          expectedActionDigest: 'sha256:reviewed',
          executionGrant: {
            schema: 'viewport.execution_grant/v1',
            digest: 'sha256:grant',
            proposal_key: 'action:review',
            approval_decision_key: 'approve-review',
          },
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

  it('uses the targeted run id instead of a bounded recent-run scan', async () => {
    const run = blockedRun('older-target-run');
    const decisions: Array<{ runId: string; nodeId: string }> = [];
    const applier = new WorkflowRuntimeCommandApplier(
      {
        get: async (runId: string) => (runId === run.id ? run : null),
        list: async () => {
          throw new Error('approval commands must not scan recent runs');
        },
      } as WorkflowRunStore,
      async (runId, nodeId) => {
        decisions.push({ runId, nodeId });
        return run;
      },
    );

    const applied = await applier.apply({
      id: 'plan-review:old-target',
      type: 'workflow.approval_decision',
      workflow_run_id: run.id,
      workflow_node_id: 'review',
      approved: true,
    });

    expect(applied).toBe(true);
    expect(decisions).toEqual([{ runId: run.id, nodeId: 'review' }]);
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

  it('marks stale commands for already-resolved nodes as processed', async () => {
    const run = blockedRun();
    run.nodes.notify = {
      id: 'notify',
      type: 'action',
      title: 'Notify Slack',
      status: 'completed',
      output: 'slack.post_message',
    };
    const decider = vi.fn(async () => run);
    const applier = new WorkflowRuntimeCommandApplier(storeWith([run]), decider);

    const applied = await applier.apply({
      id: 'slack:already-approved',
      type: 'workflow.approval_decision',
      workflow_run_id: run.id,
      workflow_node_id: 'notify',
      approved: true,
    });

    expect(applied).toBe(true);
    expect(decider).not.toHaveBeenCalled();
  });

  it('marks broker-completed action commands as local node completions without approval replay', async () => {
    const run = blockedRun();
    run.nodes.review = {
      id: 'review',
      type: 'action',
      title: 'Open PR',
      status: 'blocked',
      metadata: {
        action: {
          adapter: 'github',
          action: 'pull_request.create',
          status: 'awaiting_approval',
        },
      },
    };
    const saved: WorkflowRunRecord[] = [];
    const decider = vi.fn(async () => run);
    const applier = new WorkflowRuntimeCommandApplier(storeWith([run]), decider, async (value) => {
      saved.push(JSON.parse(JSON.stringify(value)) as WorkflowRunRecord);
    });

    const applied = await applier.apply({
      id: 'action-completed:receipt-1',
      type: 'workflow.action_completed',
      workflow_run_id: run.id,
      workflow_node_id: 'review',
      proposal_key: 'action:review',
      receipt_key: 'broker:proposal-1',
      receipt_digest: 'sha256:receipt',
      provider_reference: '28',
      provider_url: 'https://github.com/viewportai/vp-example-repo/pull/28',
      adapter: 'github',
      action: 'pull_request.create',
      status: 'succeeded',
      executed_at: '2026-05-29T02:00:00.000Z',
      message: 'Broker completed the PR.',
    });

    expect(applied).toBe(true);
    expect(decider).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.status).toBe('completed');
    expect(saved[0]?.nodes.review.status).toBe('completed');
    expect(saved[0]?.nodes.review.output).toBe('github.pull_request.create');
    expect(saved[0]?.nodes.review.metadata?.['action']).toMatchObject({
      adapter: 'github',
      action: 'pull_request.create',
      status: 'executed',
      receiptKey: 'broker:proposal-1',
      providerReference: '28',
      completedBy: 'viewport_broker',
    });
    expect(saved[0]?.events).toEqual([
      expect.objectContaining({
        type: 'node-completed',
        nodeId: 'review',
        data: expect.objectContaining({
          source: 'viewport_broker',
          receipt_key: 'broker:proposal-1',
          provider_reference: '28',
        }),
      }),
    ]);
  });

  it('accepts same-digest pre-publish approval commands after repeated reblock churn', async () => {
    const run = blockedRun();
    run.nodes.publish = {
      id: 'publish',
      type: 'git_publish',
      title: 'Publish',
      status: 'blocked',
      approval: {
        prompt: 'Review the current diff again.',
        requestedAt: Date.parse('2026-05-31T18:52:17.000Z'),
      },
      metadata: {
        pre_publish_review: {
          schema: 'viewport.pre_publish_review/v1',
          facts: {
            diffDigest: 'sha256:current-diff',
          },
          invalidated_approval: {
            previous_diff_digest: 'sha256:old-diff',
            current_diff_digest: 'sha256:current-diff',
          },
        },
      },
    };
    delete run.nodes.review;

    const decisions: WorkflowApprovalDecision[] = [];
    const applier = new WorkflowRuntimeCommandApplier(storeWith([run]), async (_runId, _nodeId, decision) => {
      decisions.push(decision);
      return run;
    });

    const applied = await applier.apply({
      id: 'approval-decision:same-digest-after-reblock',
      type: 'workflow.approval_decision',
      workflow_run_id: run.id,
      workflow_node_id: 'publish',
      approved: true,
      decision: 'approve',
      expected_action_digest: 'sha256:current-diff',
      approval_requested_at: '1780253537000',
      decided_at: '2026-05-31T18:52:16.000Z',
    });

    expect(applied).toBe(true);
    expect(decisions).toEqual([
      expect.objectContaining({
        approved: true,
        expectedActionDigest: 'sha256:current-diff',
      }),
    ]);
  });

  it('ignores approval commands bound to a previous approval request', async () => {
    const run = blockedRun();
    run.nodes.publish = {
      id: 'publish',
      type: 'git_publish',
      title: 'Publish',
      status: 'blocked',
      approval: {
        prompt: 'Review the mutated diff.',
        requestedAt: 1_780_254_464_488,
      },
      metadata: {
        pre_publish_review: {
          schema: 'viewport.pre_publish_review/v1',
          facts: {
            diffDigest: 'sha256:mutated-diff',
          },
          invalidated_approval: {
            previous_diff_digest: 'sha256:old-diff',
            current_diff_digest: 'sha256:mutated-diff',
          },
        },
      },
    };
    delete run.nodes.review;

    const decisions: WorkflowApprovalDecision[] = [];
    const saved: WorkflowRunRecord[] = [];
    const applier = new WorkflowRuntimeCommandApplier(
      storeWith([run]),
      async (_runId, _nodeId, decision) => {
        decisions.push(decision);
        return run;
      },
      async (value) => {
        saved.push(JSON.parse(JSON.stringify(value)) as WorkflowRunRecord);
      },
    );

    const applied = await applier.apply({
      id: 'approval-decision:old-request',
      type: 'workflow.approval_decision',
      workflow_run_id: run.id,
      workflow_node_id: 'publish',
      approved: true,
      decision: 'approve',
      expected_action_digest: 'sha256:mutated-diff',
      approval_requested_at: '1780254464068',
      decided_at: '2026-05-31T19:07:42.000Z',
    });

    expect(applied).toBe(true);
    expect(decisions).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.nodes.publish.status).toBe('blocked');
    expect(saved[0]?.nodes.publish.metadata?.['runtime_commands']).toMatchObject({
      consumed: [
        expect.objectContaining({
          id: 'approval-decision:old-request',
          ignored: true,
          reason: 'stale_approval_request_binding',
        }),
      ],
    });
  });

  it('deduplicates concurrent approval command delivery in process', async () => {
    const run = blockedRun();
    let resolveDecision: ((run: WorkflowRunRecord) => void) | null = null;
    let markDecisionStarted: (() => void) | null = null;
    const decisionStarted = new Promise<void>((resolve) => {
      markDecisionStarted = resolve;
    });
    const decisions: WorkflowApprovalDecision[] = [];
    const applier = new WorkflowRuntimeCommandApplier(storeWith([run]), async (_runId, _nodeId, decision) => {
      decisions.push(decision);
      markDecisionStarted?.();
      await new Promise<WorkflowRunRecord>((resolve) => {
        resolveDecision = resolve;
      });
      return run;
    });

    const command = {
      id: 'approval-decision:concurrent',
      type: 'workflow.approval_decision' as const,
      workflow_run_id: run.id,
      workflow_node_id: 'review',
      approved: true,
      decision: 'approve' as const,
    };

    const first = applier.apply(command);
    await decisionStarted;

    expect(decisions).toHaveLength(1);
    const second = applier.apply(command);
    resolveDecision?.(run);

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(decisions).toHaveLength(1);
  });
});

function storeWith(runs: WorkflowRunRecord[]): WorkflowRunStore {
  return {
    get: async (runId: string) => runs.find((run) => run.id === runId) ?? null,
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
    resourceId: 'project-1',
    runtimeTargetId: 'binding-1',
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
