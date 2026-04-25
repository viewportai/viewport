import type { Daemon } from '../core/daemon.js';
import { readPromptNodeOutput, readPromptNodeTranscriptExcerpt } from './prompt-output.js';
import { addEvent } from './runtime-helpers.js';
import { getSessionState, readReplaySessionState } from './session-completion.js';
import type { WorkflowRunRecord } from './types.js';

export type SaveAndEmitFn = (run: WorkflowRunRecord) => Promise<void>;

/**
 * Reconciles persisted run records with live runtime state. Used on every
 * read path so that `getRun` / `listRuns` reflect session completions that
 * happened while the daemon was offline (e.g. a prompt session ended idle
 * during a crash window).
 */
export class WorkflowRunReconciler {
  constructor(
    private readonly daemon: Daemon,
    private readonly activeRunIds: Set<string>,
    private readonly saveAndEmit: SaveAndEmitFn,
  ) {}

  async reconcile(run: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    if (!['queued', 'running'].includes(run.status)) {
      return this.backfillPromptOutputs(run);
    }
    if (this.activeRunIds.has(run.id)) return run;

    let changed = false;
    for (const node of Object.values(run.nodes)) {
      if (node.status !== 'running' || node.type !== 'prompt' || !node.sessionId) continue;

      const state =
        getSessionState(this.daemon, node.sessionId) ??
        (await readReplaySessionState(node.sessionId));
      if (state === 'idle' || state === 'completed') {
        node.output = node.output || (await readPromptNodeOutput(run, node));
        node.status = 'completed';
        node.completedAt = node.completedAt ?? Date.now();
        run.updatedAt = node.completedAt;
        addEvent(
          run,
          state === 'idle' ? 'session-idle' : 'session-ended',
          `Node ${node.id} session ${node.sessionId} ${state === 'idle' ? 'became idle' : 'ended'}`,
          { sessionId: node.sessionId, reason: state },
          node.id,
        );
        addEvent(run, 'node-completed', `Node ${node.id} completed`, undefined, node.id);
        changed = true;
      } else if (state === 'errored') {
        node.status = 'failed';
        node.error = `Session ${node.sessionId} errored`;
        node.completedAt = Date.now();
        run.status = 'failed';
        run.error = node.error;
        run.completedAt = node.completedAt;
        run.updatedAt = node.completedAt;
        addEvent(run, 'node-failed', `Node ${node.id} failed: ${node.error}`, undefined, node.id);
        addEvent(run, 'run-failed', `Workflow run failed: ${node.error}`);
        changed = true;
      }
    }

    if (changed && Object.values(run.nodes).every((node) => node.status === 'completed')) {
      run.status = 'completed';
      run.completedAt = run.completedAt ?? Date.now();
      run.updatedAt = run.completedAt;
      addEvent(run, 'run-completed', 'Workflow run completed');
    }

    if (changed) {
      await this.saveAndEmit(run);
    }

    return run;
  }

  private async backfillPromptOutputs(run: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    let changed = false;
    for (const node of Object.values(run.nodes)) {
      if (node.type !== 'prompt' || node.output || !node.sessionId) continue;
      const output = await readPromptNodeOutput(run, node);
      if (!output) continue;
      node.output = output;
      run.updatedAt = Date.now();
      const transcriptExcerpt = await readPromptNodeTranscriptExcerpt(run, node);
      addEvent(
        run,
        'node-output',
        `Node ${node.id} recovered prompt output`,
        {
          output,
          ...(transcriptExcerpt.length > 0 ? { transcriptExcerpt } : {}),
        },
        node.id,
      );
      changed = true;
    }

    if (changed) {
      await this.saveAndEmit(run);
    }

    return run;
  }
}
