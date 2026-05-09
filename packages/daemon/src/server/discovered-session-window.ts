import type { DiscoveredSession } from '../core/interfaces.js';

export const RECENT_DISCOVERED_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isRecentlyDiscoveredSession(
  session: Pick<DiscoveredSession, 'lastModified'>,
  now = Date.now(),
): boolean {
  return now - session.lastModified <= RECENT_DISCOVERED_SESSION_WINDOW_MS;
}
