import { logger as out } from '../core/output.js';

export function logDaemonFrameSummary(
  source: 'daemon->relay' | 'relay->daemon',
  payload: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const frame = parsed as Record<string, unknown>;
  const type = typeof frame.type === 'string' ? frame.type : '';
  if (!type) return;

  if (type === 'hello') {
    const directories = Array.isArray(frame.directories) ? frame.directories.length : 0;
    const activeSessions = Array.isArray(frame.activeSessions) ? frame.activeSessions.length : 0;
    const discoveredSessions = Array.isArray(frame.discoveredSessions)
      ? frame.discoveredSessions.length
      : 0;
    out.log(
      `[relay] ${source} hello dirs=${directories} active=${activeSessions} discovered=${discoveredSessions}`,
    );
    return;
  }

  if (type === 'session-list') {
    const sessions = Array.isArray(frame.sessions) ? frame.sessions.length : 0;
    const directoryId = typeof frame.directoryId === 'string' ? frame.directoryId : '<unknown>';
    const total = typeof frame.total === 'number' ? frame.total : sessions;
    out.log(
      `[relay] ${source} session-list directory=${directoryId} returned=${sessions} total=${total}`,
    );
    return;
  }

  if (type === 'discovered-sessions-updated') {
    const sessions = Array.isArray(frame.sessions) ? frame.sessions.length : 0;
    out.log(`[relay] ${source} discovered-sessions-updated count=${sessions}`);
  }
}
