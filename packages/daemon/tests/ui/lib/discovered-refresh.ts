import type { DiscoveredSessionInfo, RichSessionMessage } from './protocol-types';
import { sameScopedSession } from './session-scope';

export interface DiscoveredRefreshInput {
  previousSessions: DiscoveredSessionInfo[];
  updatedSessions: DiscoveredSessionInfo[];
  selectedSessionId: string | null;
  selectedDirectoryId: string | null;
  selectedIsActive: boolean;
}

export interface DiscoveredRefreshDeps {
  fetchMessages: (directoryId: string, sessionId: string) => Promise<RichSessionMessage[]>;
  emitTail: (sessionId: string, directoryId: string, blocks: RichSessionMessage[]) => void;
}

export async function refreshSelectedDiscoveredSessionFromUpdate(
  input: DiscoveredRefreshInput,
  deps: DiscoveredRefreshDeps,
): Promise<boolean> {
  const { selectedSessionId, selectedDirectoryId, selectedIsActive } = input;
  if (!selectedSessionId || !selectedDirectoryId || selectedIsActive) {
    return false;
  }

  const selectedNext = input.updatedSessions.find((session) =>
    sameScopedSession(session, { id: selectedSessionId, directoryId: selectedDirectoryId }),
  );
  if (!selectedNext) return false;

  const selectedPrev = input.previousSessions.find((session) =>
    sameScopedSession(session, { id: selectedSessionId, directoryId: selectedDirectoryId }),
  );

  const metadataAdvanced =
    !selectedPrev ||
    selectedNext.messageCount > selectedPrev.messageCount ||
    selectedNext.lastActivity > selectedPrev.lastActivity;
  if (!metadataAdvanced) return false;

  try {
    const blocks = await deps.fetchMessages(selectedNext.directoryId, selectedNext.id);
    deps.emitTail(selectedNext.id, selectedNext.directoryId, blocks);
    return true;
  } catch {
    return false;
  }
}
