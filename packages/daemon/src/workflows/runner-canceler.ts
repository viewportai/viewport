import type { Daemon } from '../core/daemon.js';
import { addEvent } from './runtime-helpers.js';
import type { RunnerOps } from './runner-shared.js';
import type { WorkflowShellAbortRegistry } from './shell-abort-registry.js';
import type {
  WorkflowApprovalActor,
  WorkflowInlineAgentRunState,
  WorkflowLoopIterationRecord,
  WorkflowNodeRunState,
  WorkflowRunRecord,
} from './types.js';

export interface WorkflowCancelOptions {
  message?: string;
  actor?: WorkflowApprovalActor;
}

/**
 * Owns explicit user/system cancellation so the main runner can stay focused
 * on scheduling. Cancellation is authoritative: once persisted, later stale
 * executor saves must not resurrect the run as failed/completed.
 */
export class WorkflowRunCanceler {
  constructor(
    private readonly daemon: Daemon,
    private readonly activeRunIds: Set<string>,
    private readonly shellAbortRegistry: WorkflowShellAbortRegistry,
    private readonly ops: RunnerOps,
  ) {}

  async cancelRun(runId: string, options: WorkflowCancelOptions = {}): Promise<WorkflowRunRecord> {
    const run = await this.ops.requireRun(runId);
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'canceled') {
      return run;
    }

    const now = Date.now();
    const message = options.message ?? 'Workflow run canceled';
    this.activeRunIds.delete(run.id);
    this.shellAbortRegistry.cancelRun(run.id);

    const sessionIds = collectWorkflowSessionIds(run);
    await Promise.all(
      [...sessionIds].map((sessionId) => this.daemon.killSession(sessionId).catch(() => undefined)),
    );

    for (const node of Object.values(run.nodes)) {
      cancelNode(node, message, now);
    }

    run.status = 'canceled';
    run.error = message;
    run.completedAt = now;
    run.updatedAt = now;
    addEvent(run, 'run-canceled', message, {
      killedSessionIds: [...sessionIds],
      ...(options.actor ? { actor: options.actor } : {}),
    });
    await this.ops.saveAndEmit(run);
    return run;
  }
}

function collectWorkflowSessionIds(run: WorkflowRunRecord): Set<string> {
  const sessionIds = new Set<string>();
  for (const node of Object.values(run.nodes)) {
    if (node.sessionId) sessionIds.add(node.sessionId);
    for (const iteration of node.iterations ?? []) {
      if (iteration.sessionId) sessionIds.add(iteration.sessionId);
    }
    for (const inlineAgent of Object.values(node.inlineAgents ?? {})) {
      if (inlineAgent.sessionId) sessionIds.add(inlineAgent.sessionId);
    }
  }
  return sessionIds;
}

function cancelNode(node: WorkflowNodeRunState, message: string, timestamp: number): void {
  if (node.status === 'queued' || node.status === 'running' || node.status === 'blocked') {
    node.status = 'canceled';
    node.error = message;
    node.completedAt = timestamp;
  }

  for (const iteration of node.iterations ?? []) {
    cancelIteration(iteration, message, timestamp);
  }

  for (const inlineAgent of Object.values(node.inlineAgents ?? {})) {
    cancelInlineAgent(inlineAgent, message, timestamp);
  }
}

function cancelIteration(
  iteration: WorkflowLoopIterationRecord,
  message: string,
  timestamp: number,
): void {
  if (
    iteration.status === 'failed' ||
    iteration.status === 'completed' ||
    iteration.status === 'skipped'
  ) {
    return;
  }
  iteration.status = 'failed';
  iteration.error = message;
  iteration.completedAt = timestamp;
}

function cancelInlineAgent(
  inlineAgent: WorkflowInlineAgentRunState,
  message: string,
  timestamp: number,
): void {
  if (inlineAgent.status === 'queued' || inlineAgent.status === 'running') {
    inlineAgent.status = 'failed';
    inlineAgent.error = message;
    inlineAgent.completedAt = timestamp;
  }
}
