import type { Logger } from 'pino';
import { dedupeDiscoveredSessions } from './discovered-sessions.js';
import type { DiscoveredSession, SessionDiscovery } from './interfaces.js';
import type { WorkflowSessionLink } from '../workflows/session-links.js';

interface DirectoryRef {
  id: string;
  path: string;
}

interface Params {
  discoveredByDirectory: Map<string, DiscoveredSession[]>;
  directories: DirectoryRef[];
  discoveries: Map<string, SessionDiscovery>;
  links: WorkflowSessionLink[];
  log: Logger;
}

export async function addWorkflowLinkedDiscoveredSessions({
  discoveredByDirectory,
  directories,
  discoveries,
  links,
  log,
}: Params): Promise<void> {
  const directoryIds = new Set(directories.map((directory) => directory.id));

  for (const link of links) {
    if (!directoryIds.has(link.parentDirectoryId)) continue;
    const linkedSessions = await discoverLinkSessions(link, discoveries, log);
    if (linkedSessions.length === 0) continue;

    const existing = discoveredByDirectory.get(link.parentDirectoryId) ?? [];
    discoveredByDirectory.set(
      link.parentDirectoryId,
      dedupeDiscoveredSessions([...existing, ...linkedSessions]),
    );
  }
}

async function discoverLinkSessions(
  link: WorkflowSessionLink,
  discoveries: Map<string, SessionDiscovery>,
  log: Logger,
): Promise<DiscoveredSession[]> {
  const linkedSessions: DiscoveredSession[] = [];

  for (const [agentId, discovery] of discoveries) {
    try {
      const sessions = await discovery.discoverSessions(link.worktreePath);
      const linkedIds = new Set(
        [link.sessionId, link.nativeSessionId].filter((id): id is string => Boolean(id)),
      );
      const matches = sessions.filter((session) => linkedIds.has(session.sessionId));
      linkedSessions.push(
        ...matches.map((session) => ({
          ...session,
          agentId: session.agentId || agentId,
          parentDirectoryId: link.parentDirectoryId,
          parentDirectoryPath: link.parentDirectoryPath,
          worktreePath: link.worktreePath,
          workflowRunId: link.workflowRunId,
          workflowNodeId: link.workflowNodeId,
        })),
      );
    } catch (err) {
      log.warn(
        { err, agentId, worktreePath: link.worktreePath, workflowRunId: link.workflowRunId },
        'Workflow-linked session discovery failed',
      );
    }
  }

  return linkedSessions;
}
