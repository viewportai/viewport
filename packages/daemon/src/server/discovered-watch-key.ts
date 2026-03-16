export function discoveredWatchKey(sessionId: string, directoryId?: string): string {
  return directoryId ? `${directoryId}::${sessionId}` : `*::${sessionId}`;
}

export function matchesDiscoveredWatch(
  watched: Set<string>,
  sessionId: string,
  directoryId: string,
): boolean {
  return resolveMatchedDiscoveredWatch(watched, [sessionId], directoryId) !== null;
}

export function resolveMatchedDiscoveredWatch(
  watched: Set<string>,
  sessionIds: string[],
  directoryId: string,
): string | null {
  for (const sessionId of sessionIds) {
    if (watched.has(discoveredWatchKey(sessionId, directoryId))) {
      return sessionId;
    }
  }
  for (const sessionId of sessionIds) {
    if (watched.has(discoveredWatchKey(sessionId))) {
      return sessionId;
    }
  }
  return null;
}

export function removeDiscoveredWatch(
  watched: Set<string>,
  sessionId: string,
  directoryId?: string,
): void {
  if (directoryId) {
    watched.delete(discoveredWatchKey(sessionId, directoryId));
    return;
  }

  for (const key of watched) {
    if (key.endsWith(`::${sessionId}`)) {
      watched.delete(key);
    }
  }
}
