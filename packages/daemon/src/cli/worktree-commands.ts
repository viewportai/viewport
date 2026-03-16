import { getArgs, getFlag } from './args.js';
import { daemonFetch, isDaemonRunning } from './daemon-client.js';
import { printStructured, resolveOutputFormat, type TableColumn } from './command-shared.js';

interface WorktreeSummary {
  sessionId: string;
  directoryId: string;
  agent: string;
  state: string;
  mode: string;
  worktreePath: string;
  stepCount: number;
  lastStepSha: string | null;
  lastStepAt: number | null;
}

interface WorktreeListResponse {
  worktrees: WorktreeSummary[];
  count: number;
}

interface SessionDiffEntry {
  step: number;
  sha: string;
  diff: string;
}

interface SessionSummaryDiffResponse {
  diff: string;
}

const WORKTREE_TABLE_COLUMNS: TableColumn[] = [
  { key: 'sessionId', header: 'Session' },
  { key: 'agent', header: 'Agent' },
  { key: 'state', header: 'State' },
  { key: 'mode', header: 'Mode' },
  { key: 'stepCount', header: 'Steps' },
  { key: 'lastStepSha', header: 'Last SHA' },
  {
    key: 'lastStepAt',
    header: 'Last Step At',
    format: (value) => (typeof value === 'number' ? new Date(value).toISOString() : ''),
  },
  { key: 'worktreePath', header: 'Worktree' },
];

const WORKTREE_DIFF_COLUMNS: TableColumn[] = [
  { key: 'step', header: 'Step' },
  { key: 'sha', header: 'SHA' },
  { key: 'summary', header: 'Summary' },
];

async function ensureDaemonRunningOrThrow(): Promise<void> {
  if (await isDaemonRunning()) return;
  throw new Error('Daemon is not running. Start it first with `vpd start`.');
}

function parseSessionIdAt(index: number, usage: string): string {
  const value = getArgs()[index];
  if (!value || value.startsWith('--')) {
    throw new Error(usage);
  }
  return value;
}

function summarizeDiff(diff: string): string {
  const first = diff
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) return '(empty)';
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

async function listWorktrees(): Promise<void> {
  const format = resolveOutputFormat({ allowTable: true });
  const sessionId = getFlag('session');
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  const res = await daemonFetch(`/api/worktrees${query}`);
  if (!res || !res.ok) {
    throw new Error(sessionId ? `Session not found: ${sessionId}` : 'Failed to list worktrees');
  }
  const payload = (await res.json()) as WorktreeListResponse;
  const body = {
    schemaVersion: 1,
    command: 'worktree ls',
    ok: true,
    worktrees: payload.worktrees,
    count: payload.count,
  };
  if (format !== 'text') {
    printStructured(body, {
      format,
      table:
        format === 'table'
          ? {
              rows: payload.worktrees.map((entry) => ({
                sessionId: entry.sessionId,
                agent: entry.agent,
                state: entry.state,
                mode: entry.mode,
                stepCount: entry.stepCount,
                lastStepSha: entry.lastStepSha ?? '',
                lastStepAt: entry.lastStepAt,
                worktreePath: entry.worktreePath,
              })),
              columns: WORKTREE_TABLE_COLUMNS,
              emptyMessage: 'No active worktrees found.',
            }
          : undefined,
    });
    return;
  }
  if (payload.worktrees.length === 0) {
    console.log('No active worktrees found.');
    return;
  }
  console.log(`Worktrees (${payload.count})\n`);
  for (const item of payload.worktrees) {
    console.log(`${item.sessionId}  [${item.state}]`);
    console.log(`  agent:      ${item.agent}`);
    console.log(`  mode:       ${item.mode}`);
    console.log(`  directory:  ${item.directoryId}`);
    console.log(`  steps:      ${item.stepCount}`);
    console.log(`  last sha:   ${item.lastStepSha ?? '-'}`);
    console.log(`  worktree:   ${item.worktreePath}`);
    console.log('');
  }
}

async function diffsWorktree(): Promise<void> {
  const format = resolveOutputFormat({ allowTable: true });
  const sessionId = parseSessionIdAt(
    2,
    'Usage: vpd worktree diffs <session-id> [--json|--format <fmt>]',
  );
  const res = await daemonFetch(`/api/sessions/${encodeURIComponent(sessionId)}/diffs`);
  if (!res || !res.ok) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const diffs = (await res.json()) as SessionDiffEntry[];
  const body = {
    schemaVersion: 1,
    command: 'worktree diffs',
    ok: true,
    sessionId,
    diffs,
  };
  if (format !== 'text') {
    printStructured(body, {
      format,
      table:
        format === 'table'
          ? {
              rows: diffs.map((item) => ({
                step: item.step,
                sha: item.sha,
                summary: summarizeDiff(item.diff),
              })),
              columns: WORKTREE_DIFF_COLUMNS,
              emptyMessage: 'No diffs available.',
            }
          : undefined,
    });
    return;
  }
  if (diffs.length === 0) {
    console.log('No diffs available.');
    return;
  }
  for (const item of diffs) {
    console.log(`#${item.step} ${item.sha}\n`);
    console.log(item.diff);
    console.log('');
  }
}

async function summaryWorktree(): Promise<void> {
  const format = resolveOutputFormat();
  const sessionId = parseSessionIdAt(
    2,
    'Usage: vpd worktree summary <session-id> [--json|--format <fmt>]',
  );
  const res = await daemonFetch(`/api/sessions/${encodeURIComponent(sessionId)}/summary-diff`);
  if (!res || !res.ok) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const payload = (await res.json()) as SessionSummaryDiffResponse;
  if (format !== 'text') {
    printStructured(
      {
        schemaVersion: 1,
        command: 'worktree summary',
        ok: true,
        sessionId,
        diff: payload.diff,
      },
      { format },
    );
    return;
  }
  console.log(payload.diff);
}

async function rollbackWorktree(): Promise<void> {
  const format = resolveOutputFormat();
  const sessionId = parseSessionIdAt(
    2,
    'Usage: vpd worktree rollback <session-id> <sha> [--json|--format <fmt>]',
  );
  const toSha = parseSessionIdAt(
    3,
    'Usage: vpd worktree rollback <session-id> <sha> [--json|--format <fmt>]',
  );
  const res = await daemonFetch(`/api/worktrees/${encodeURIComponent(sessionId)}/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toSha }),
  });
  if (!res || !res.ok) {
    throw new Error(`Failed to rollback session ${sessionId}`);
  }
  const payload = { schemaVersion: 1, command: 'worktree rollback', ok: true, sessionId, toSha };
  if (format !== 'text') {
    printStructured(payload, { format });
    return;
  }
  console.log(`Rolled back ${sessionId} to ${toSha}`);
}

async function retryWorktree(): Promise<void> {
  const format = resolveOutputFormat();
  const sessionId = parseSessionIdAt(
    2,
    'Usage: vpd worktree retry <session-id> <sha> [--json|--format <fmt>]',
  );
  const fromSha = parseSessionIdAt(
    3,
    'Usage: vpd worktree retry <session-id> <sha> [--json|--format <fmt>]',
  );
  const res = await daemonFetch(`/api/worktrees/${encodeURIComponent(sessionId)}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromSha }),
  });
  if (!res || !res.ok) {
    throw new Error(`Failed to create retry branch for ${sessionId}`);
  }
  const payload = (await res.json()) as { retryPath: string };
  const body = {
    schemaVersion: 1,
    command: 'worktree retry',
    ok: true,
    sessionId,
    fromSha,
    retryPath: payload.retryPath,
  };
  if (format !== 'text') {
    printStructured(body, { format });
    return;
  }
  console.log(`Created retry branch for ${sessionId}`);
  console.log(payload.retryPath);
}

async function squashWorktree(): Promise<void> {
  const format = resolveOutputFormat();
  const sessionId = parseSessionIdAt(
    2,
    'Usage: vpd worktree squash <session-id> [--target <branch>] [--message <text>] [--json|--format <fmt>]',
  );
  const targetBranch = getFlag('target') ?? 'main';
  const commitMessage = getFlag('message') ?? `chore: squash merge viewport session ${sessionId}`;
  const res = await daemonFetch(`/api/worktrees/${encodeURIComponent(sessionId)}/squash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetBranch, commitMessage }),
  });
  if (!res || !res.ok) {
    throw new Error(`Failed to squash merge session ${sessionId}`);
  }
  const body = {
    schemaVersion: 1,
    command: 'worktree squash',
    ok: true,
    sessionId,
    targetBranch,
  };
  if (format !== 'text') {
    printStructured(body, { format });
    return;
  }
  console.log(`Squash-merged ${sessionId} into ${targetBranch}`);
}

export async function worktree(): Promise<void> {
  await ensureDaemonRunningOrThrow();
  const action = getArgs()[1] ?? 'ls';
  if (action === 'ls') return listWorktrees();
  if (action === 'diffs') return diffsWorktree();
  if (action === 'summary') return summaryWorktree();
  if (action === 'rollback') return rollbackWorktree();
  if (action === 'retry') return retryWorktree();
  if (action === 'squash') return squashWorktree();
  throw new Error(
    'Usage: vpd worktree <ls|diffs|summary|rollback|retry|squash> ... [--json|--format <fmt>]',
  );
}
