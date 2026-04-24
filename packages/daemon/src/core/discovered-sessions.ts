import type { DiscoveredSession } from './interfaces.js';

function score(session: DiscoveredSession): [number, number, number] {
  return [session.lastModified, session.messageCount ?? 0, session.summary.trim().length];
}

function compareScore(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] !== b[2]) return a[2] - b[2];
  return 0;
}

function mergeSessionPair(
  existing: DiscoveredSession,
  incoming: DiscoveredSession,
): DiscoveredSession {
  const incomingWins = compareScore(score(incoming), score(existing)) >= 0;
  const winner = incomingWins ? incoming : existing;
  const loser = incomingWins ? existing : incoming;

  return {
    ...winner,
    summary: winner.summary.trim().length > 0 ? winner.summary : loser.summary,
    messageCount: Math.max(winner.messageCount ?? 0, loser.messageCount ?? 0),
    resumable: winner.resumable || loser.resumable,
    sourcePath: winner.sourcePath ?? loser.sourcePath,
    gitBranch: winner.gitBranch ?? loser.gitBranch,
    cwd: winner.cwd ?? loser.cwd,
    workflowRunId: winner.workflowRunId ?? loser.workflowRunId,
    workflowNodeId: winner.workflowNodeId ?? loser.workflowNodeId,
    parentDirectoryId: winner.parentDirectoryId ?? loser.parentDirectoryId,
    parentDirectoryPath: winner.parentDirectoryPath ?? loser.parentDirectoryPath,
    worktreePath: winner.worktreePath ?? loser.worktreePath,
  };
}

/**
 * Collapse duplicate discovered sessions by session id.
 * The daemon/UI currently key session identity by directory + session id.
 */
export function dedupeDiscoveredSessions(
  sessions: ReadonlyArray<DiscoveredSession>,
): DiscoveredSession[] {
  const bySessionId = new Map<string, DiscoveredSession>();
  for (const session of sessions) {
    const existing = bySessionId.get(session.sessionId);
    bySessionId.set(session.sessionId, existing ? mergeSessionPair(existing, session) : session);
  }
  return [...bySessionId.values()].sort((a, b) => b.lastModified - a.lastModified);
}
