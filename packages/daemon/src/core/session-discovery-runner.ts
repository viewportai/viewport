import type { Logger } from 'pino';
import type { DiscoveredSession, SessionDiscovery } from './interfaces.js';
import type { DirectoryInfo } from './types.js';
import { dedupeDiscoveredSessions } from './discovered-sessions.js';
import { addWorkflowLinkedDiscoveredSessions } from './workflow-linked-discovery.js';
import type { WorkflowSessionLinkStore } from '../workflows/session-links.js';

export async function discoverDirectorySessions(options: {
  directories: DirectoryInfo[];
  discoveries: Map<string, SessionDiscovery>;
  links: WorkflowSessionLinkStore;
  log: Logger;
}): Promise<Map<string, DiscoveredSession[]>> {
  const nextDiscovered = new Map<string, DiscoveredSession[]>();

  for (const dir of options.directories) {
    const allSessions: DiscoveredSession[] = [];

    for (const [agentId, discovery] of options.discoveries) {
      try {
        const sessions = await discovery.discoverSessions(dir.path);
        options.log.debug(
          { directoryId: dir.id, directoryPath: dir.path, agentId, sessions: sessions.length },
          'Discovery result',
        );
        allSessions.push(...sessions);
      } catch (err) {
        options.log.warn({ err, agentId, directory: dir.path }, 'Discovery failed for directory');
      }
    }

    const dedupedSessions = dedupeDiscoveredSessions(allSessions);
    options.log.debug(
      {
        directoryId: dir.id,
        directoryPath: dir.path,
        totalSessions: allSessions.length,
        dedupedSessions: dedupedSessions.length,
      },
      'Discovery aggregate result',
    );
    if (dedupedSessions.length > 0) {
      nextDiscovered.set(dir.id, dedupedSessions);
    }
  }

  await addWorkflowLinkedDiscoveredSessions({
    discoveredByDirectory: nextDiscovered,
    directories: options.directories,
    discoveries: options.discoveries,
    links: await options.links.list(),
    log: options.log,
  });

  return nextDiscovered;
}
