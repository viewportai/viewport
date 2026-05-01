import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GitTracker } from '../../src/tracking/git-tracker.js';
import type { GitTrackerConfig, SessionMessage, Step } from '../../src/core/types.js';

const exec = promisify(execFile);

const DEFAULT_CONFIG: GitTrackerConfig = {
  enabled: true,
  commitOn: ['Edit', 'Write', 'Bash'],
  ignore: ['.env', 'node_modules/**'],
  autoSquashOnComplete: false,
  branchPrefix: 'viewport/session-',
  commitAuthor: 'Viewport Test <noreply@example.test>',
  maxCommitsPerSession: 500,
  worktreeRoot: '.viewport/worktrees',
};

const GIT_TRACKER_TEST_TIMEOUT_MS = 15_000;

function toolCallUpdate(
  toolName: string,
  status: 'completed' | 'error' = 'completed',
): SessionMessage {
  return {
    type: 'tool_call_update',
    toolCallId: `tc-${Date.now()}`,
    toolName,
    status,
    title: `${toolName} something`,
    timestamp: Date.now(),
  };
}

describe('GitTracker', { timeout: GIT_TRACKER_TEST_TIMEOUT_MS }, () => {
  let projectDir: string;
  let baseBranch: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-git-test-'));
    await exec('git', ['init', projectDir]);
    await exec('git', ['-C', projectDir, 'config', 'user.email', 'noreply@example.test']);
    await exec('git', ['-C', projectDir, 'config', 'user.name', 'Viewport Test']);
    await fs.writeFile(path.join(projectDir, 'README.md'), '# Test Project\n');
    await exec('git', ['-C', projectDir, 'add', '.']);
    await exec('git', ['-C', projectDir, 'commit', '-m', 'initial']);
    const { stdout: currentBranch } = await exec('git', [
      '-C',
      projectDir,
      'branch',
      '--show-current',
    ]);
    baseBranch = currentBranch.trim();
  });

  afterEach(async () => {
    // Clean up worktrees before removing the directory
    try {
      await exec('git', ['-C', projectDir, 'worktree', 'prune']);
    } catch {
      // Ignore cleanup errors
    }
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // setup
  // ---------------------------------------------------------------------------

  it('creates worktree and branch on setup', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);

    // Worktree directory exists
    const stat = await fs.stat(worktreePath);
    expect(stat.isDirectory()).toBe(true);

    // Branch exists
    const { stdout } = await exec('git', ['-C', projectDir, 'branch']);
    expect(stdout).toContain('viewport/session-test-session');

    // Files are present in worktree
    const readmeContent = await fs.readFile(path.join(worktreePath, 'README.md'), 'utf-8');
    expect(readmeContent).toBe('# Test Project\n');

    await tracker.teardown();
  });

  it('fails setup on non-git directory', async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-nongit-'));
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test');

    await expect(tracker.setup('test', nonGitDir)).rejects.toThrow();

    await fs.rm(nonGitDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // onMessage + commits
  // ---------------------------------------------------------------------------

  it('creates a commit when a configured tool completes', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);

    // Simulate: agent edits a file
    await fs.writeFile(path.join(worktreePath, 'app.ts'), 'console.log("hello");\n');
    tracker.onMessage(toolCallUpdate('Edit'));

    // Wait for commit queue to flush
    await tracker.teardown();

    // Verify commit was made
    const { stdout } = await exec('git', [
      '-C',
      projectDir,
      'log',
      '--oneline',
      `viewport/session-test-session`,
    ]);
    expect(stdout).toContain('[viewport] Step');
  });

  it('does not bypass git hooks with --no-verify', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);
    const gitSpy = vi.spyOn(
      tracker as unknown as { git: (...args: unknown[]) => Promise<unknown> },
      'git',
    );

    await fs.writeFile(path.join(worktreePath, 'hook-check.ts'), 'console.log("hook");\n');
    tracker.onMessage(toolCallUpdate('Edit'));
    await tracker.teardown();

    const commitCalls = gitSpy.mock.calls.filter(
      (call) => Array.isArray(call[0]) && (call[0] as string[])[0] === 'commit',
    );
    expect(commitCalls.length).toBeGreaterThan(0);
    for (const call of commitCalls) {
      const args = call[0] as string[];
      expect(args).not.toContain('--no-verify');
    }
  });

  it('does not commit for non-configured tools', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);

    await fs.writeFile(path.join(worktreePath, 'data.txt'), 'some data\n');
    tracker.onMessage(toolCallUpdate('Read'));

    await tracker.teardown();

    // Should only have initial commit + session log on the branch
    const { stdout } = await exec('git', [
      '-C',
      projectDir,
      'log',
      '--oneline',
      `viewport/session-test-session`,
    ]);
    // No "[viewport] Step" commits since Read is not in commitOn
    const stepCommits = stdout.split('\n').filter((l: string) => l.includes('[viewport] Step'));
    expect(stepCommits).toHaveLength(0);
  });

  it('skips commit when no files changed', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    await tracker.setup('test-session', projectDir);

    // Don't modify any files, just report a tool completion
    tracker.onMessage(toolCallUpdate('Edit'));

    await tracker.teardown();

    const { stdout } = await exec('git', [
      '-C',
      projectDir,
      'log',
      '--oneline',
      `viewport/session-test-session`,
    ]);
    const stepCommits = stdout.split('\n').filter((l: string) => l.includes('[viewport] Step'));
    expect(stepCommits).toHaveLength(0);
  });

  it('records steps sequentially', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);

    tracker.onMessage({
      type: 'user_message',
      text: 'Hello',
      messageId: 'm1',
      timestamp: Date.now(),
    });

    await fs.writeFile(path.join(worktreePath, 'a.ts'), 'a\n');
    tracker.onMessage(toolCallUpdate('Edit'));
    await tracker.flush(); // Ensure first commit completes before creating second file

    await fs.writeFile(path.join(worktreePath, 'b.ts'), 'b\n');
    tracker.onMessage(toolCallUpdate('Write'));

    await tracker.teardown();

    expect(tracker.steps).toHaveLength(3);
    expect(tracker.steps[0]!.step).toBe(1);
    expect(tracker.steps[0]!.type).toBe('user_message');
    expect(tracker.steps[1]!.step).toBe(2);
    expect(tracker.steps[1]!.sha).toBeTruthy(); // Edit committed
    expect(tracker.steps[2]!.step).toBe(3);
    expect(tracker.steps[2]!.sha).toBeTruthy(); // Write committed
  });

  it('fires onStepCommitted callback', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);

    const committed: Step[] = [];
    tracker.onStepCommitted = (step) => committed.push({ ...step });

    await fs.writeFile(path.join(worktreePath, 'file.ts'), 'content\n');
    tracker.onMessage(toolCallUpdate('Edit'));

    await tracker.teardown();

    expect(committed).toHaveLength(1);
    expect(committed[0]!.sha).toBeTruthy();
    expect(committed[0]!.step).toBe(1);
  });

  it('respects maxCommitsPerSession', async () => {
    const config = { ...DEFAULT_CONFIG, maxCommitsPerSession: 2 };
    const tracker = new GitTracker(config, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);

    for (let i = 0; i < 5; i++) {
      await fs.writeFile(path.join(worktreePath, `file${i}.ts`), `content ${i}\n`);
      tracker.onMessage(toolCallUpdate('Edit'));
    }

    await tracker.teardown();

    const stepsWithSha = tracker.steps.filter((s) => s.sha);
    expect(stepsWithSha.length).toBeLessThanOrEqual(2);
  });

  it('respects ignore patterns', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);

    // Create a .env file (should be ignored)
    await fs.writeFile(path.join(worktreePath, '.env'), 'SECRET=abc\n');
    // Also create a normal file
    await fs.writeFile(path.join(worktreePath, 'app.ts'), 'code\n');
    tracker.onMessage(toolCallUpdate('Edit'));

    await tracker.teardown();

    // Verify .env was not committed
    const step = tracker.steps.find((s) => s.sha);
    if (step?.sha) {
      const { stdout } = await exec('git', [
        '-C',
        projectDir,
        'show',
        '--name-only',
        '--format=',
        step.sha,
      ]);
      expect(stdout).not.toContain('.env');
      expect(stdout).toContain('app.ts');
    }
  });

  // ---------------------------------------------------------------------------
  // rollback
  // ---------------------------------------------------------------------------

  it('rolls back to a specific commit', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);

    // Make first change
    await fs.writeFile(path.join(worktreePath, 'first.ts'), 'first\n');
    tracker.onMessage(toolCallUpdate('Edit'));
    // Wait for commit
    await tracker.flush();

    const firstSha = tracker.steps.find((s) => s.sha)?.sha;
    expect(firstSha).toBeTruthy();

    // Make second change
    await fs.writeFile(path.join(worktreePath, 'second.ts'), 'second\n');
    tracker.onMessage(toolCallUpdate('Edit'));
    await tracker.flush();

    // Rollback to first
    await tracker.rollback(firstSha!);

    // second.ts should not exist
    await expect(fs.access(path.join(worktreePath, 'second.ts'))).rejects.toThrow();
    // first.ts should still exist
    const content = await fs.readFile(path.join(worktreePath, 'first.ts'), 'utf-8');
    expect(content).toBe('first\n');

    await tracker.teardown();
  });

  // ---------------------------------------------------------------------------
  // branchRetry
  // ---------------------------------------------------------------------------

  it('creates a retry branch from a specific SHA', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);

    await fs.writeFile(path.join(worktreePath, 'base.ts'), 'base\n');
    tracker.onMessage(toolCallUpdate('Edit'));
    await tracker.flush();

    const baseSha = tracker.steps.find((s) => s.sha)?.sha;
    expect(baseSha).toBeTruthy();

    const retryPath = await tracker.branchRetry(baseSha!);

    // Retry worktree exists with the base file
    const content = await fs.readFile(path.join(retryPath, 'base.ts'), 'utf-8');
    expect(content).toBe('base\n');

    await tracker.teardown();
  });

  it('teardown removes retry worktrees created by branchRetry', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);

    await fs.writeFile(path.join(worktreePath, 'base.ts'), 'base\n');
    tracker.onMessage(toolCallUpdate('Edit'));
    await tracker.flush();

    const baseSha = tracker.steps.find((s) => s.sha)?.sha;
    expect(baseSha).toBeTruthy();

    const retryPath = await tracker.branchRetry(baseSha!);
    await fs.access(retryPath);

    await tracker.teardown();
    await expect(fs.access(retryPath)).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // squashMerge
  // ---------------------------------------------------------------------------

  it('squash-merges viewport branch into target', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);
    const { stdout: branchBefore } = await exec('git', [
      '-C',
      projectDir,
      'branch',
      '--show-current',
    ]);

    // Make several commits
    await fs.writeFile(path.join(worktreePath, 'a.ts'), 'a\n');
    tracker.onMessage(toolCallUpdate('Edit'));
    await tracker.flush();

    await fs.writeFile(path.join(worktreePath, 'b.ts'), 'b\n');
    tracker.onMessage(toolCallUpdate('Edit'));
    await tracker.flush();

    // Squash-merge to the repository's initialized branch (main/master).
    await tracker.squashMerge(baseBranch, 'feat: add a and b files');

    // Squash merge must not switch the main project worktree branch.
    const { stdout: branchAfter } = await exec('git', [
      '-C',
      projectDir,
      'branch',
      '--show-current',
    ]);
    expect(branchAfter.trim()).toBe(branchBefore.trim());

    // Verify target branch has the squash commit
    const { stdout } = await exec('git', ['-C', projectDir, 'log', '--oneline', baseBranch]);
    expect(stdout).toContain('feat: add a and b files');

    // Target branch now contains squashed content.
    const { stdout: aFromBranch } = await exec('git', [
      '-C',
      projectDir,
      'show',
      `${baseBranch}:a.ts`,
    ]);
    expect(aFromBranch).toBe('a\n');

    await tracker.teardown();
  }, 15_000);

  // ---------------------------------------------------------------------------
  // getDiff / getStepDiffs / getSummaryDiff
  // ---------------------------------------------------------------------------

  it('getDiff returns the diff for a commit', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);

    await fs.writeFile(path.join(worktreePath, 'new-file.ts'), 'hello world\n');
    tracker.onMessage(toolCallUpdate('Edit'));
    await tracker.flush();

    const sha = tracker.steps.find((s) => s.sha)?.sha;
    expect(sha).toBeTruthy();

    const diff = await tracker.getDiff(sha!);
    expect(diff).toContain('new-file.ts');
    expect(diff).toContain('hello world');

    await tracker.teardown();
  });

  it('getStepDiffs returns diffs for all committed steps', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);

    await fs.writeFile(path.join(worktreePath, 'a.ts'), 'a\n');
    tracker.onMessage(toolCallUpdate('Edit'));
    await tracker.flush();

    await fs.writeFile(path.join(worktreePath, 'b.ts'), 'b\n');
    tracker.onMessage(toolCallUpdate('Write'));
    await tracker.flush();

    const stepDiffs = await tracker.getStepDiffs();
    expect(stepDiffs.length).toBeGreaterThanOrEqual(2);
    expect(stepDiffs[0]!.diff).toContain('a.ts');

    await tracker.teardown();
  }, 15_000);

  it('getSummaryDiff returns total changes', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);

    await fs.writeFile(path.join(worktreePath, 'a.ts'), 'a\n');
    tracker.onMessage(toolCallUpdate('Edit'));
    await tracker.flush();

    await fs.writeFile(path.join(worktreePath, 'b.ts'), 'b\n');
    tracker.onMessage(toolCallUpdate('Edit'));
    await tracker.flush();

    const summary = await tracker.getSummaryDiff();
    expect(summary).toContain('a.ts');
    expect(summary).toContain('b.ts');

    await tracker.teardown();
  }, 15_000);

  // ---------------------------------------------------------------------------
  // teardown
  // ---------------------------------------------------------------------------

  it('teardown removes worktree and writes session log', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    const worktreePath = await tracker.setup('test-session', projectDir);

    await fs.writeFile(path.join(worktreePath, 'file.ts'), 'content\n');
    tracker.onMessage(toolCallUpdate('Edit'));

    await tracker.teardown();

    // Worktree directory should be removed
    await expect(fs.access(worktreePath)).rejects.toThrow();

    // Session log should be in the branch
    const { stdout } = await exec('git', [
      '-C',
      projectDir,
      'log',
      '--oneline',
      `viewport/session-test-session`,
    ]);
    expect(stdout).toContain('Session log');
  });

  it('teardown is idempotent', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    await tracker.setup('test-session', projectDir);

    await tracker.teardown();
    await expect(tracker.teardown()).resolves.toBeUndefined();
  });

  it('teardown times out waiting for stuck commit queue and continues cleanup', async () => {
    const tracker = new GitTracker(
      {
        ...DEFAULT_CONFIG,
        teardownCommitDrainMs: 25,
      },
      'test-session',
    );
    const worktreePath = await tracker.setup('test-session', projectDir);
    (tracker as unknown as { commitQueue: Promise<void> }).commitQueue = new Promise<void>(
      () => {},
    );

    const startedAt = Date.now();
    await tracker.teardown();
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(2_000);
    await expect(fs.access(worktreePath)).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // edge cases
  // ---------------------------------------------------------------------------

  it('throws on rollback before setup', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test');
    await expect(tracker.rollback('abc')).rejects.toThrow('not set up');
  });

  it('ignores messages after teardown', async () => {
    const tracker = new GitTracker(DEFAULT_CONFIG, 'test-session');
    await tracker.setup('test-session', projectDir);
    await tracker.teardown();

    // Should not throw
    tracker.onMessage(toolCallUpdate('Edit'));
    expect(tracker.steps.length).toBe(0);
  });

  it('skips oversized auto-commits when maxCommitSizeBytes is exceeded', async () => {
    const tracker = new GitTracker(
      {
        ...DEFAULT_CONFIG,
        maxCommitSizeBytes: 16,
      },
      'test-session',
    );
    const worktreePath = await tracker.setup('test-session', projectDir);
    await fs.writeFile(path.join(worktreePath, 'big.txt'), 'this content is definitely larger\n');
    tracker.onMessage(toolCallUpdate('Edit'));
    await tracker.teardown();

    const step = tracker.steps.find((s) => s.type === 'tool_call_update');
    expect(step?.sha).toBeNull();
  });
});
