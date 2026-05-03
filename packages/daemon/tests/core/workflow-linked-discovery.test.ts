import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { addWorkflowLinkedDiscoveredSessions } from '../../src/core/workflow-linked-discovery.js';
import type { DiscoveredSession, SessionDiscovery } from '../../src/core/interfaces.js';
import type { WorkflowSessionLink } from '../../src/workflows/session-links.js';

describe('workflow-linked discovery', () => {
  it('surfaces workflow sessions under the parent directory even when the transcript cwd is the parent repo', async () => {
    const discoveredByDirectory = new Map<string, DiscoveredSession[]>();
    const discovery = fakeDiscovery({
      '/repo/.viewport/worktrees/workflow-session': [],
      '/repo': [
        {
          agentId: 'codex',
          sessionId: 'native-session',
          summary: 'Workflow review output',
          lastModified: 1_000,
          cwd: '/repo',
          resumable: true,
        },
      ],
    });

    await addWorkflowLinkedDiscoveredSessions({
      discoveredByDirectory,
      directories: [{ id: 'dir-1', path: '/repo' }],
      discoveries: new Map([['codex', discovery]]),
      links: [workflowLink()],
      log: { warn: vi.fn() } as unknown as Logger,
    });

    expect(discoveredByDirectory.get('dir-1')).toEqual([
      expect.objectContaining({
        sessionId: 'native-session',
        workflowRunId: 'run-1',
        workflowNodeId: 'review',
        parentDirectoryId: 'dir-1',
        parentDirectoryPath: '/repo',
        worktreePath: '/repo/.viewport/worktrees/workflow-session',
      }),
    ]);
  });

  it('keeps parent directory discovery when worktree discovery fails', async () => {
    const discoveredByDirectory = new Map<string, DiscoveredSession[]>();
    const discovery = fakeDiscovery(
      {
        '/repo': [
          {
            agentId: 'codex',
            sessionId: 'native-session',
            summary: 'Recovered from parent',
            lastModified: 1_000,
            cwd: '/repo',
            resumable: true,
          },
        ],
      },
      new Set(['/repo/.viewport/worktrees/workflow-session']),
    );

    await addWorkflowLinkedDiscoveredSessions({
      discoveredByDirectory,
      directories: [{ id: 'dir-1', path: '/repo' }],
      discoveries: new Map([['codex', discovery]]),
      links: [workflowLink()],
      log: { warn: vi.fn() } as unknown as Logger,
    });

    expect(discoveredByDirectory.get('dir-1')?.[0]).toEqual(
      expect.objectContaining({
        sessionId: 'native-session',
        workflowRunId: 'run-1',
      }),
    );
  });
});

function fakeDiscovery(
  sessionsByPath: Record<string, DiscoveredSession[]>,
  throwingPaths = new Set<string>(),
): SessionDiscovery {
  return {
    agentId: 'codex',
    async discoverSessions(projectPath: string): Promise<DiscoveredSession[]> {
      if (throwingPaths.has(projectPath)) {
        throw new Error(`cannot read ${projectPath}`);
      }
      return sessionsByPath[projectPath] ?? [];
    },
  };
}

function workflowLink(): WorkflowSessionLink {
  return {
    sessionId: 'workflow-session',
    nativeSessionId: 'native-session',
    workflowRunId: 'run-1',
    workflowNodeId: 'review',
    parentDirectoryId: 'dir-1',
    parentDirectoryPath: '/repo',
    worktreePath: '/repo/.viewport/worktrees/workflow-session',
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}
