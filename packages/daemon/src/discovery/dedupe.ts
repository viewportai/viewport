import type { DiscoveredSession } from '../core/interfaces.js';

export function dedupeBySessionId(sessions: DiscoveredSession[]): DiscoveredSession[] {
  const seen = new Set<string>();
  const out: DiscoveredSession[] = [];
  for (const session of sessions) {
    const key = `${session.agentId}:${session.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(session);
  }
  return out;
}
