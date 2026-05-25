import { describe, expect, it, vi } from 'vitest';
import { NODE_EXECUTORS } from '../../src/workflows/node-registry.js';
import type { WorkflowNode, WorkflowRunRecord } from '../../src/workflows/types.js';

function makeRun(worktreePath?: string): WorkflowRunRecord {
  return {
    id: 'run_123',
    workflowId: 'workflow_123',
    status: 'running',
    directoryPath: '/tmp/run-root',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    inputs: {},
    nodes: {
      implement: {
        status: 'running',
        ...(worktreePath ? { worktreePath } : {}),
      },
    },
    events: [],
    artifacts: [],
  } as unknown as WorkflowRunRecord;
}

describe('NODE_EXECUTORS', () => {
  it('collects prompt artifacts from the prompt worktree when one was assigned', async () => {
    const executor = NODE_EXECUTORS.get('prompt');
    expect(executor).toBeDefined();

    const run = makeRun('/tmp/viewport-worktree');
    const node = { type: 'prompt', prompt: 'write an artifact' } as Extract<
      WorkflowNode,
      { type: 'prompt' }
    >;

    const outcome = await executor!({} as never, run, 'implement', node, {
      executePromptNode: vi.fn(async () => undefined),
      executeGateNode: vi.fn(async () => 'completed'),
      blockForApproval: vi.fn(async () => undefined),
    });

    expect(outcome).toEqual({
      result: 'completed',
      artifactCwd: '/tmp/viewport-worktree',
    });
  });

  it('collects agent artifacts from the underlying prompt worktree when one was assigned', async () => {
    const executor = NODE_EXECUTORS.get('agent');
    expect(executor).toBeDefined();

    const run = makeRun('/tmp/viewport-agent-worktree');
    const node = { type: 'agent', prompt: 'write an artifact' } as Extract<
      WorkflowNode,
      { type: 'agent' }
    >;

    const outcome = await executor!({} as never, run, 'implement', node, {
      executePromptNode: vi.fn(async () => undefined),
      executeGateNode: vi.fn(async () => 'completed'),
      blockForApproval: vi.fn(async () => undefined),
    });

    expect(outcome).toEqual({
      result: 'completed',
      artifactCwd: '/tmp/viewport-agent-worktree',
    });
  });
});
