/**
 * ClaudeDiscovery — discovers existing Claude Code sessions.
 *
 * Reads ~/.claude/projects/ JSONL files to find sessions for registered
 * project directories. This is the same approach ClaudeCodeUI uses.
 *
 * Two discovery modes:
 * 1. discoverSessions(projectPath) — find sessions for a specific project
 * 2. discoverAllProjects() — scan all Claude Code projects
 */

import type { SessionDiscovery, DiscoveredSession } from '../core/interfaces.js';
import {
  encodeProjectDir,
  listProjectSessions,
  listProjects,
  type SessionSummary,
} from './jsonl-reader.js';

export class ClaudeDiscovery implements SessionDiscovery {
  readonly agentId = 'claude';

  /**
   * Discover sessions for a specific project path.
   * Encodes the path to find the matching ~/.claude/projects/ directory.
   */
  async discoverSessions(projectPath: string): Promise<DiscoveredSession[]> {
    const dirName = encodeProjectDir(projectPath);
    const sessions = await listProjectSessions(dirName);
    return sessions.map(toDiscoveredSession);
  }

  /**
   * Discover ALL Claude Code projects and their sessions.
   * Used for auto-registration on daemon startup.
   */
  async discoverAllProjects(): Promise<
    Array<{ fsPath: string; dirName: string; sessions: DiscoveredSession[] }>
  > {
    const projects = await listProjects();
    const results: Array<{ fsPath: string; dirName: string; sessions: DiscoveredSession[] }> = [];

    for (const project of projects) {
      const sessions = await listProjectSessions(project.dirName);
      if (sessions.length > 0) {
        results.push({
          fsPath: project.fsPath,
          dirName: project.dirName,
          sessions: sessions.map(toDiscoveredSession),
        });
      }
    }

    return results;
  }
}

function toDiscoveredSession(s: SessionSummary): DiscoveredSession {
  return {
    agentId: 'claude',
    sessionId: s.sessionId,
    summary: s.summary,
    nativeTitle: s.nativeTitle,
    generatedTitle: s.generatedTitle,
    displayTitle: s.displayTitle,
    titleSource: s.titleSource,
    firstPrompt: s.firstPrompt,
    lastPrompt: s.lastPrompt,
    latestModel: s.latestModel,
    approvalPolicy: s.approvalPolicy,
    sandboxMode: s.sandboxMode,
    reasoningEffort: s.reasoningEffort,
    lastModified: new Date(s.lastActivity).getTime(),
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    resumable: s.resumable,
    messageCount: s.messageCount,
    sourcePath: s.sourcePath,
  };
}
