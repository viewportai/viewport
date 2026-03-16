/**
 * GitTracker — git-backed run tracking with worktree isolation.
 *
 * Creates a git worktree per session, micro-commits on configurable tool calls,
 * and supports rollback, branch-retry, and squash-merge operations.
 *
 * This is the most complex module in the daemon. It directly manages git state
 * via child_process — no git library dependency.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunTracker } from '../core/interfaces.js';
import type { SessionMessage, Step, GitTrackerConfig } from '../core/types.js';
import { metrics } from '../core/metrics.js';
import { logger } from '../core/logger.js';

const log = logger.child({ module: 'git-tracker' });

const execGit = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_COMMIT_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TEARDOWN_DRAIN_MS = 10_000;

export class GitTracker implements RunTracker {
  private worktreePath: string | null = null;
  private projectPath: string | null = null;
  private branch: string;
  private stepCounter = 0;
  private commitCount = 0;
  private _steps: Step[] = [];
  private commitQueue: Promise<void> = Promise.resolve();
  private tornDown = false;
  private retryWorktreePaths = new Set<string>();

  /** Callback fired after each successful commit. */
  onStepCommitted?: (step: Step) => void;

  private readonly _sessionId: string;

  constructor(
    private config: GitTrackerConfig,
    sessionId: string,
  ) {
    this._sessionId = sessionId;
    this.branch = `${config.branchPrefix}${sessionId}`;
  }

  get steps(): ReadonlyArray<Step> {
    return this._steps;
  }

  /** Await all pending commits. Useful for testing. */
  async flush(): Promise<void> {
    await this.commitQueue;
  }

  /** Flush any pending commits. Called before teardown on crash/end. */
  async flushPendingCommits(): Promise<void> {
    await this.commitQueue;
  }

  async setup(_sessionId: string, projectPath: string): Promise<string> {
    this.projectPath = projectPath;

    // Verify this is a git repo
    await this.git(['rev-parse', '--is-inside-work-tree'], projectPath);

    // Compute worktree path
    this.worktreePath = path.join(projectPath, this.config.worktreeRoot, this._sessionId);

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(this.worktreePath), { recursive: true });

    // Create worktree + branch
    await this.git(['worktree', 'add', this.worktreePath, '-b', this.branch], projectPath);

    return this.worktreePath;
  }

  onMessage(msg: SessionMessage): void {
    if (this.tornDown) return;

    this.stepCounter++;
    const step: Step = {
      step: this.stepCounter,
      sha: null,
      type: msg.type,
      toolName: 'toolName' in msg ? (msg.toolName as string) : undefined,
      description: this.describeStep(msg),
      timestamp: msg.timestamp,
    };
    this._steps.push(step);

    // Only commit on completed tool calls for configured tools
    if (msg.type === 'tool_call_update' && msg.status === 'completed' && msg.toolName) {
      if (this.shouldCommit(msg.toolName)) {
        this.enqueueCommit(step);
      }
    }
  }

  async rollback(toSha: string): Promise<void> {
    this.ensureWorktree();
    await this.git(['reset', '--hard', toSha], this.worktreePath!);
    metrics.increment('git.rollbacks');
  }

  async branchRetry(fromSha: string): Promise<string> {
    this.ensureWorktree();
    const retryBranch = `${this.branch}-retry-${Date.now()}`;
    const retryPath = `${this.worktreePath!}-retry-${Date.now()}`;

    await fs.mkdir(path.dirname(retryPath), { recursive: true });
    await this.git(['worktree', 'add', retryPath, '-b', retryBranch, fromSha], this.projectPath!);
    this.retryWorktreePaths.add(retryPath);

    return retryPath;
  }

  async squashMerge(targetBranch: string, commitMessage: string): Promise<void> {
    this.ensureWorktree();

    // Flush any pending commits first
    await this.commitQueue;

    if (targetBranch === this.branch) {
      throw new Error('Target branch must differ from session branch');
    }

    // Keep all merge operations inside the session worktree so we never mutate
    // the user's main working tree branch.
    const targetRef = `refs/heads/${targetBranch}`;
    const { stdout: targetShaRaw } = await this.git(
      ['rev-parse', '--verify', targetRef],
      this.projectPath!,
    );
    const targetSha = targetShaRaw.trim();

    try {
      await this.git(['checkout', '--detach', targetSha], this.worktreePath!);
      await this.git(['merge', '--squash', this.branch], this.worktreePath!);
      await this.git(
        ['commit', '-m', commitMessage, '--author', this.config.commitAuthor],
        this.worktreePath!,
      );
      const { stdout: mergedShaRaw } = await this.git(['rev-parse', 'HEAD'], this.worktreePath!);
      const mergedSha = mergedShaRaw.trim();
      await this.git(['update-ref', targetRef, mergedSha], this.projectPath!);
    } finally {
      // Restore worktree to the session branch even if merge failed.
      await this.git(['checkout', this.branch], this.worktreePath!).catch(() => {});
    }
  }

  async teardown(): Promise<void> {
    if (this.tornDown) return;

    // Flush pending commits before marking as torn down, but avoid hanging teardown forever.
    await this.awaitCommitQueueWithDeadline();
    this.tornDown = true;

    if (this.worktreePath && this.projectPath) {
      // Write step log to branch
      await this.writeStepLog();

      // Remove any retry worktrees created via branchRetry.
      for (const retryPath of this.retryWorktreePaths) {
        await this.removeWorktree(retryPath, this.projectPath);
      }
      this.retryWorktreePaths.clear();

      // Remove the primary session worktree.
      await this.removeWorktree(this.worktreePath, this.projectPath);
    }
  }

  async getDiff(sha: string): Promise<string> {
    this.ensureWorktree();
    try {
      const { stdout } = await this.git(['diff', `${sha}~1..${sha}`], this.worktreePath!);
      return stdout;
    } catch {
      // First commit in worktree has no parent — show all changes
      const { stdout } = await this.git(['show', '--format=', sha], this.worktreePath!);
      return stdout;
    }
  }

  async getStepDiffs(): Promise<Array<{ step: number; sha: string; diff: string }>> {
    const committed = this._steps.filter((step): step is Step & { sha: string } => !!step.sha);
    return Promise.all(
      committed.map(async (step) => ({
        step: step.step,
        sha: step.sha,
        diff: await this.getDiff(step.sha),
      })),
    );
  }

  async getSummaryDiff(): Promise<string> {
    this.ensureWorktree();
    const stepsWithSha = this._steps.filter((s) => s.sha);
    if (stepsWithSha.length === 0) return '';

    const firstSha = stepsWithSha[0]!.sha!;
    const lastSha = stepsWithSha[stepsWithSha.length - 1]!.sha!;

    if (firstSha === lastSha) {
      return this.getDiff(firstSha);
    }

    try {
      const { stdout } = await this.git(['diff', `${firstSha}~1..${lastSha}`], this.worktreePath!);
      return stdout;
    } catch {
      const { stdout } = await this.git(['diff', `${firstSha}..${lastSha}`], this.worktreePath!);
      return stdout;
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private shouldCommit(toolName: string): boolean {
    return this.config.commitOn.includes(toolName);
  }

  private enqueueCommit(step: Step): void {
    if (this.commitCount >= this.config.maxCommitsPerSession) return;

    this.commitQueue = this.commitQueue
      .then(() => this.doCommit(step))
      .catch((err) => {
        log.warn({ err, step: step.step, sessionId: this._sessionId }, 'Git commit failed');
      });
  }

  private async doCommit(step: Step): Promise<void> {
    if (this.tornDown || !this.worktreePath) return;

    // Check if there are any changes
    const { stdout: status } = await this.git(['status', '--porcelain'], this.worktreePath);
    if (!status.trim()) return; // Nothing to commit

    // Check we're still on our branch
    const { stdout: currentBranch } = await this.git(
      ['branch', '--show-current'],
      this.worktreePath,
    );
    if (currentBranch.trim() !== this.branch) return; // Agent switched branches

    // Stage all changes, respecting ignore patterns
    const addArgs = ['add', '-A'];
    for (const pattern of this.config.ignore) {
      addArgs.push(`:(exclude)${pattern}`);
    }
    await this.git(addArgs, this.worktreePath);

    // Check if staging resulted in any changes
    const { stdout: staged } = await this.git(
      ['diff', '--cached', '--name-only'],
      this.worktreePath,
    );
    if (!staged.trim()) return; // All changes were ignored

    const maxCommitSizeBytes = this.config.maxCommitSizeBytes ?? DEFAULT_MAX_COMMIT_SIZE_BYTES;
    if (maxCommitSizeBytes > 0) {
      const estimatedBytes = await this.estimateStagedBytes();
      if (estimatedBytes > maxCommitSizeBytes) {
        metrics.increment('git.commits.skipped_oversize');
        log.warn(
          {
            sessionId: this._sessionId,
            step: step.step,
            estimatedBytes,
            maxCommitSizeBytes,
          },
          'Skipping auto-commit because staged content exceeds maxCommitSizeBytes',
        );
        return;
      }
    }

    // Commit
    const message = `[viewport] Step ${step.step}: ${step.description}`;
    await this.git(
      ['commit', '-m', message, '--author', this.config.commitAuthor],
      this.worktreePath,
    );

    // Get the commit SHA
    const { stdout: sha } = await this.git(['rev-parse', 'HEAD'], this.worktreePath);
    step.sha = sha.trim();
    this.commitCount++;
    metrics.increment('git.commits');

    this.onStepCommitted?.(step);
  }

  private describeStep(msg: SessionMessage): string {
    switch (msg.type) {
      case 'tool_call':
        return `${msg.toolName}: ${msg.title}`;
      case 'tool_call_update':
        return `${msg.toolName ?? 'tool'} ${msg.status}${msg.title ? ': ' + msg.title : ''}`;
      case 'user_message':
        return `User: ${msg.text.slice(0, 80)}`;
      case 'agent_message':
        return `Agent: ${msg.text.slice(0, 80)}`;
      case 'token_usage':
        return `Token usage: ${msg.inputTokens + msg.outputTokens} tokens`;
      default:
        return msg.type;
    }
  }

  private async writeStepLog(): Promise<void> {
    if (!this.worktreePath) return;

    const logPath = path.join(this.worktreePath, '.viewport-session.jsonl');
    const lines = this._steps.map((s) => JSON.stringify(s)).join('\n') + '\n';

    try {
      await fs.writeFile(logPath, lines, 'utf-8');
      await this.git(['add', '.viewport-session.jsonl'], this.worktreePath);
      await this.git(
        [
          'commit',
          '-m',
          `[viewport] Session log: ${this._steps.length} steps`,
          '--author',
          this.config.commitAuthor,
        ],
        this.worktreePath,
      );
    } catch {
      // Non-fatal — session log is nice-to-have
    }
  }

  private ensureWorktree(): void {
    if (!this.worktreePath) {
      throw new Error('GitTracker not set up. Call setup() first.');
    }
  }

  private async estimateStagedBytes(): Promise<number> {
    if (!this.worktreePath) return 0;
    const { stdout } = await this.git(['diff', '--cached', '--name-only', '-z'], this.worktreePath);
    if (!stdout) return 0;
    const files = stdout.split('\0').filter((entry) => entry.length > 0);
    let total = 0;
    for (const file of files) {
      const absolute = path.resolve(this.worktreePath, file);
      try {
        const stat = await fs.stat(absolute);
        if (stat.isFile()) total += stat.size;
      } catch {
        // File may be deleted or moved in index; skip.
      }
    }
    return total;
  }

  private async awaitCommitQueueWithDeadline(): Promise<void> {
    const configured = this.config.teardownCommitDrainMs;
    const drainMs =
      typeof configured === 'number' && Number.isFinite(configured)
        ? Math.max(0, Math.floor(configured))
        : DEFAULT_TEARDOWN_DRAIN_MS;

    if (drainMs <= 0) {
      await this.commitQueue;
      return;
    }

    let timedOut = false;
    await Promise.race([
      this.commitQueue,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, drainMs),
      ),
    ]);

    if (timedOut) {
      metrics.increment('git.teardown_commit_drain_timeout');
      log.warn(
        { sessionId: this._sessionId, drainMs },
        'Timed out waiting for commit queue during teardown; forcing worktree cleanup',
      );
    }
  }

  private async removeWorktree(worktreePath: string, projectPath: string): Promise<void> {
    try {
      await this.git(['worktree', 'remove', worktreePath, '--force'], projectPath);
    } catch {
      // If worktree removal fails (e.g., already removed), just clean up.
      await fs.rm(worktreePath, { recursive: true, force: true });
      await this.git(['worktree', 'prune'], projectPath).catch(() => {});
    }
  }

  private async git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execGit('git', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    });
    return { stdout, stderr };
  }
}
