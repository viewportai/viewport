import { parseWorkflow } from './parser.js';
import { addEvent } from './runtime-helpers.js';
import type { WorkflowRunStore } from './store.js';
import type { ParsedWorkflow, WorkflowRunRecord } from './types.js';

export type ExecuteRunFn = (
  runId: string,
  parsed: ParsedWorkflow,
  options?: { resumed?: boolean },
) => Promise<void>;

export type FailRunFn = (runId: string, message: string) => Promise<void>;
export type ReconcileRunFn = (run: WorkflowRunRecord) => Promise<WorkflowRunRecord>;

/**
 * Resumes runs that were `running` or `queued` when the daemon last shut
 * down. Each candidate's partially-executed nodes are reset to `queued` so
 * the next scheduling pass picks them up. Runs in `blocked` state are left
 * alone — they're waiting on an external event (approval / schedule gate)
 * and resume themselves when that fires.
 */
export class WorkflowRunResumer {
  constructor(
    private readonly store: WorkflowRunStore,
    private readonly executeRun: ExecuteRunFn,
    private readonly failRun: FailRunFn,
    private readonly reconcileRun: ReconcileRunFn,
  ) {}

  /**
   * Called at daemon boot from `Daemon.initialize()`. Failures are surfaced
   * on the run record itself; this method never throws because a single
   * unrecoverable run shouldn't block the daemon from starting.
   */
  async resumePendingRuns(): Promise<{ resumed: number; failed: number }> {
    let resumed = 0;
    let failed = 0;
    const candidates = await this.store.list(500);
    for (const candidate of candidates) {
      if (candidate.status !== 'running' && candidate.status !== 'queued') continue;
      try {
        await this.resumeOneRun(candidate);
        resumed += 1;
      } catch (error) {
        failed += 1;
        await this.failRun(
          candidate.id,
          `resume failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { resumed, failed };
  }

  private async resumeOneRun(run: WorkflowRunRecord): Promise<void> {
    run = await this.reconcileRun(run);
    if (run.status !== 'running' && run.status !== 'queued') {
      return;
    }

    if (this.hasInFlightPromptSession(run)) {
      addEvent(
        run,
        'run-resume-paused',
        'Workflow run resume paused for an in-flight prompt session',
      );
      await this.store.save(run);
      return;
    }

    // Reset non-prompt work that was running when we crashed back to queued.
    // Prompt nodes with an existing session are never relaunched here; the
    // reconciler recovers completed prompt sessions and leaves active ones
    // attached to the original agent session.
    let dirty = false;
    for (const node of Object.values(run.nodes)) {
      if (node.status === 'running') {
        node.status = 'queued';
        delete node.startedAt;
        delete node.output;
        delete node.exitCode;
        dirty = true;
      }
    }
    if (dirty) {
      addEvent(run, 'run-started', `Workflow run resumed after restart`);
      await this.store.save(run);
    }
    const parsed = parseWorkflow(run.yamlSnapshot, run.sourcePath ?? `viewport://runs/${run.id}`);
    void this.executeRun(run.id, parsed, { resumed: true }).catch(async (error) => {
      await this.failRun(run.id, error instanceof Error ? error.message : String(error));
    });
  }

  private hasInFlightPromptSession(run: WorkflowRunRecord): boolean {
    return Object.values(run.nodes).some(
      (node) => node.status === 'running' && node.type === 'prompt' && Boolean(node.sessionId),
    );
  }
}
