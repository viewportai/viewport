export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface ActiveSessionSnapshot {
  id: string;
  directoryId: string;
  lastSeq: number;
}

export interface ActiveSubscriptionSnapshot {
  connectionStatus: ConnectionStatus;
  selectedSessionId: string | null;
  selectedDirectoryId: string | null;
  sessions: Record<string, ActiveSessionSnapshot>;
}

export interface ActiveSubscriptionState {
  subscribedSessionId: string | null;
}

export type ActiveSubscriptionCommand =
  | { type: 'subscribe'; sessionId: string; lastSeq: number }
  | { type: 'unsubscribe'; sessionId: string };

export function reconcileActiveSubscription(
  current: ActiveSubscriptionState,
  snapshot: ActiveSubscriptionSnapshot,
): {
  state: ActiveSubscriptionState;
  commands: ActiveSubscriptionCommand[];
} {
  if (snapshot.connectionStatus !== 'connected') {
    return { state: { subscribedSessionId: null }, commands: [] };
  }

  const selectedSession = snapshot.selectedSessionId
    ? snapshot.sessions[snapshot.selectedSessionId]
    : undefined;
  const desiredSessionId =
    selectedSession &&
    (!snapshot.selectedDirectoryId || selectedSession.directoryId === snapshot.selectedDirectoryId)
      ? selectedSession.id
      : null;

  const commands: ActiveSubscriptionCommand[] = [];

  if (current.subscribedSessionId && current.subscribedSessionId !== desiredSessionId) {
    commands.push({ type: 'unsubscribe', sessionId: current.subscribedSessionId });
  }

  if (desiredSessionId && current.subscribedSessionId !== desiredSessionId) {
    commands.push({
      type: 'subscribe',
      sessionId: desiredSessionId,
      lastSeq: selectedSession?.lastSeq ?? 0,
    });
  }

  return {
    state: { subscribedSessionId: desiredSessionId },
    commands,
  };
}
