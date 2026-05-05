export interface SessionUpdateEntry {
  seq: number;
  sessionId: string;
  update: Record<string, unknown>;
}

export interface ReplayWindow {
  entries: SessionUpdateEntry[];
  droppedWindow: boolean;
  requestedLastSeq: number;
  earliestAvailableSeq: number;
  latestAvailableSeq: number;
}

export interface PersistedReplayMeta {
  sessionId: string;
  directoryId?: string;
  latestSeq: number;
  updatedAt: number;
}

export interface RingBufferOptions {
  sessionId?: string;
  storageDir?: string;
  durableTtlMs?: number;
  maxDurableEntries?: number;
}
