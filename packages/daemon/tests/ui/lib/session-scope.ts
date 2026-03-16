/**
 * Session scoping helpers.
 *
 * Keeps cross-directory session identity and keying logic centralized so
 * UI routing/state updates cannot leak between sessions that share an id.
 */

export interface ScopedSessionRef {
  id: string;
  directoryId: string;
}

export interface ScopedSessionTarget {
  id: string;
  directoryId?: string | null;
}

export function discoveredSessionKey(session: ScopedSessionRef): string {
  return `${session.directoryId}::${session.id}`;
}

export function sameScopedSession(session: ScopedSessionRef, target: ScopedSessionTarget): boolean {
  if (session.id !== target.id) return false;
  if (!target.directoryId) return true;
  return session.directoryId === target.directoryId;
}

export function activeChatViewKey(sessionId: string, directoryId?: string | null): string {
  return `active-${directoryId ?? 'none'}-${sessionId}`;
}

export function discoveredChatViewKey(session: ScopedSessionRef): string {
  return `discovered-${session.directoryId}-${session.id}`;
}

export function isErroredEndReason(reason?: string): boolean {
  if (!reason) return false;
  const normalized = reason.toLowerCase();
  return (
    normalized.startsWith('error:') ||
    normalized.includes('exited with code') ||
    normalized.includes('history_poisoned') ||
    normalized.includes('failed')
  );
}

export function sessionPermissionKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`;
}

export function sessionEndKey(
  sessionId: string,
  timestamp: number | undefined,
  reason: string | undefined,
): string {
  return `${sessionId}:${timestamp ?? 0}:${reason ?? ''}`;
}
