import { directoryStreamsToOrganization } from '../cli/org-binding.js';

type JsonRecord = Record<string, unknown>;

export interface OrgRoutingFilter {
  filter(payload: string): string | null;
}

export function createOrgRoutingFilter(options: {
  organizationId: string;
  profileName?: string | null;
}): OrgRoutingFilter {
  const directoryPaths = new Map<string, string>();
  const sessionDirectories = new Map<string, string>();

  function directoryAllowed(directoryId: unknown, workingDirectory?: unknown): boolean {
    const directoryPath =
      typeof workingDirectory === 'string'
        ? workingDirectory
        : typeof directoryId === 'string'
          ? directoryPaths.get(directoryId)
          : undefined;
    return directoryStreamsToOrganization({
      directory: directoryPath,
      organizationId: options.organizationId,
      profileName: options.profileName,
    });
  }

  function rememberDirectory(entry: JsonRecord): void {
    if (typeof entry.id === 'string' && typeof entry.path === 'string') {
      directoryPaths.set(entry.id, entry.path);
    }
  }

  function rememberSession(entry: JsonRecord): void {
    if (typeof entry.id === 'string' && typeof entry.directoryId === 'string') {
      sessionDirectories.set(entry.id, entry.directoryId);
    }
    if (typeof entry.sessionId === 'string' && typeof entry.directoryId === 'string') {
      sessionDirectories.set(entry.sessionId, entry.directoryId);
    }
  }

  function sessionAllowed(sessionId: unknown): boolean {
    if (typeof sessionId !== 'string') return false;
    const directoryId = sessionDirectories.get(sessionId);
    if (!directoryId) return false;
    return directoryAllowed(directoryId);
  }

  function filterSessionArray(value: unknown): unknown[] {
    if (!Array.isArray(value)) return [];
    const filtered: unknown[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entry = item as JsonRecord;
      if (directoryAllowed(entry.directoryId, entry.workingDirectory)) {
        rememberSession(entry);
        filtered.push(entry);
      }
    }
    return filtered;
  }

  function filterDirectoryArray(value: unknown): unknown[] {
    if (!Array.isArray(value)) return [];
    const filtered: unknown[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entry = item as JsonRecord;
      rememberDirectory(entry);
      if (directoryAllowed(entry.id, entry.path)) {
        filtered.push(entry);
      }
    }
    return filtered;
  }

  return {
    filter(payload: string): string | null {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload) as unknown;
      } catch {
        return null;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const message = parsed as JsonRecord;
      const type = message.type;

      if (type === 'hello' || type === 'sync-snapshot') {
        const next = { ...message };
        next.directories = filterDirectoryArray(message.directories);
        next.activeSessions = filterSessionArray(message.activeSessions);
        next.discoveredSessions = filterSessionArray(message.discoveredSessions);
        return JSON.stringify(next);
      }

      if (type === 'discovered-sessions-updated') {
        const sessions = filterSessionArray(message.sessions);
        return JSON.stringify({
          ...message,
          sessions,
          truncated: message.truncated === true && sessions.length > 0,
        });
      }

      if (
        type === 'session-update' ||
        type === 'session-ended' ||
        type === 'hook-session-end' ||
        type === 'hook-notification' ||
        type === 'hook-tool-completed' ||
        type === 'hook-tool-failed' ||
        type === 'hook-stop' ||
        type === 'hook-subagent-start' ||
        type === 'hook-subagent-stop' ||
        type === 'hook-plan-proposed'
      ) {
        return sessionAllowed(message.sessionId) ? payload : null;
      }

      if (
        type === 'session-alert' ||
        type === 'discovered-session-tail' ||
        type === 'discovered-session-waiting'
      ) {
        return directoryAllowed(message.directoryId) ? payload : null;
      }

      if (type === 'hook-session-start') {
        if (!directoryAllowed(undefined, message.cwd)) return null;
        if (typeof message.sessionId === 'string' && typeof message.cwd === 'string') {
          sessionDirectories.set(message.sessionId, `cwd:${message.sessionId}`);
          directoryPaths.set(`cwd:${message.sessionId}`, message.cwd);
        }
        return payload;
      }

      if (type === 'workflow-run-updated') {
        return null;
      }

      return payload;
    },
  };
}
