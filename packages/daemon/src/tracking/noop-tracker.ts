/**
 * NoopTracker — a RunTracker that does nothing.
 *
 * Used when git tracking is disabled (config.gitTracker.enabled = false).
 * The agent runs in-place in the project directory with no worktree,
 * no commits, no rollback capability.
 */

import type { RunTracker } from '../core/interfaces.js';
import type { SessionMessage, Step } from '../core/types.js';

export class NoopTracker implements RunTracker {
  readonly steps: ReadonlyArray<Step> = [];

  async setup(_sessionId: string, projectPath: string): Promise<string> {
    // No worktree — run directly in the project directory
    return projectPath;
  }

  onMessage(_msg: SessionMessage): void {
    // No tracking
  }

  async flushPendingCommits(): Promise<void> {
    // Nothing to flush
  }

  async rollback(_toSha: string): Promise<void> {
    throw new Error('Rollback is not available without git tracking enabled.');
  }

  async branchRetry(_fromSha: string): Promise<string> {
    throw new Error('Branch-retry is not available without git tracking enabled.');
  }

  async squashMerge(_targetBranch: string, _commitMessage: string): Promise<void> {
    throw new Error('Squash-merge is not available without git tracking enabled.');
  }

  async teardown(): Promise<void> {
    // Nothing to clean up
  }

  async getDiff(_sha: string): Promise<string> {
    return '';
  }

  async getStepDiffs(): Promise<Array<{ step: number; sha: string; diff: string }>> {
    return [];
  }

  async getSummaryDiff(): Promise<string> {
    return '';
  }
}
