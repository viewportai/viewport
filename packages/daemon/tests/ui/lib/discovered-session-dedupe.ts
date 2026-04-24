import type { DiscoveredSessionInfo } from './protocol-types';
import { discoveredSessionKey } from './session-scope';

function score(session: DiscoveredSessionInfo): [number, number, number] {
  return [session.lastActivity, session.messageCount, session.summary.trim().length];
}

function compareScore(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] !== b[2]) return a[2] - b[2];
  return 0;
}

function mergePair(
  existing: DiscoveredSessionInfo,
  incoming: DiscoveredSessionInfo,
): DiscoveredSessionInfo {
  const incomingWins = compareScore(score(incoming), score(existing)) >= 0;
  const winner = incomingWins ? incoming : existing;
  const loser = incomingWins ? existing : incoming;

  return {
    ...winner,
    summary: winner.summary.trim().length > 0 ? winner.summary : loser.summary,
    messageCount: Math.max(winner.messageCount, loser.messageCount),
    resumable: winner.resumable || loser.resumable,
    agentId: winner.agentId ?? loser.agentId,
    waiting: winner.waiting !== undefined ? winner.waiting : loser.waiting,
    waitingToolName: winner.waitingToolName ?? loser.waitingToolName,
    workflowRunId: winner.workflowRunId ?? loser.workflowRunId,
    workflowNodeId: winner.workflowNodeId ?? loser.workflowNodeId,
    parentDirectoryId: winner.parentDirectoryId ?? loser.parentDirectoryId,
    parentDirectoryPath: winner.parentDirectoryPath ?? loser.parentDirectoryPath,
    worktreePath: winner.worktreePath ?? loser.worktreePath,
  };
}

export function dedupeDiscoveredSessionInfo(
  sessions: ReadonlyArray<DiscoveredSessionInfo>,
): DiscoveredSessionInfo[] {
  const map = new Map<string, DiscoveredSessionInfo>();
  for (const session of sessions) {
    const key = discoveredSessionKey(session);
    const existing = map.get(key);
    map.set(key, existing ? mergePair(existing, session) : session);
  }
  return [...map.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}
