import { RELAY_REPLAY_WINDOW, RELAY_SESSION_IDLE_TTL_MS } from './bridge-constants.js';
import { encryptEnvelope } from './bridge-crypto.js';
import type { RelayHandshakeProfile } from './bridge-key-exchange.js';
import type { RelayKeyUpdateRequiredFrame } from './relay-control-frames.js';

export interface RelaySessionState {
  key: Buffer;
  profile: RelayHandshakeProfile;
  sessionId: string;
  epoch: number;
  txSeq: number;
  rxHighestSeq: number;
  rxSeenSeq: Set<number>;
  lastActivityAt: number;
  keyRotationRequested: boolean;
}

export interface RelaySessionSeed {
  key: Buffer;
  profile: RelayHandshakeProfile;
  sessionId: string;
  epoch: number;
}

export interface RelaySessionSocket {
  send(payload: string): void;
}

export function createRelaySessionState(
  seed: RelaySessionSeed,
  now = Date.now(),
): RelaySessionState {
  return {
    ...seed,
    txSeq: 0,
    rxHighestSeq: 0,
    rxSeenSeq: new Set<number>(),
    lastActivityAt: now,
    keyRotationRequested: false,
  };
}

export function acceptInboundRelaySeq(session: RelaySessionState, seq: number): boolean {
  if (seq < 1) return false;
  if (session.rxSeenSeq.has(seq)) return false;
  if (seq > session.rxHighestSeq + RELAY_REPLAY_WINDOW) return false;
  const minimumAllowed = Math.max(1, session.rxHighestSeq - RELAY_REPLAY_WINDOW + 1);
  if (seq < minimumAllowed) return false;

  session.rxSeenSeq.add(seq);
  if (seq > session.rxHighestSeq) session.rxHighestSeq = seq;

  const pruneBelow = Math.max(1, session.rxHighestSeq - RELAY_REPLAY_WINDOW + 1);
  for (const seen of session.rxSeenSeq) {
    if (seen < pruneBelow) session.rxSeenSeq.delete(seen);
  }
  return true;
}

export function pruneIdleRelaySessions(
  sessions: Map<string, RelaySessionState>,
  now = Date.now(),
  idleTtlMs = RELAY_SESSION_IDLE_TTL_MS,
): string[] {
  const pruned: string[] = [];
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastActivityAt > idleTtlMs) {
      sessions.delete(sessionId);
      pruned.push(sessionId);
    }
  }
  return pruned;
}

export function enforceRelaySessionCapacity(options: {
  sessions: Map<string, RelaySessionState>;
  maxEntries: number;
  now?: number;
  idleTtlMs?: number;
}): string[] {
  pruneIdleRelaySessions(options.sessions, options.now, options.idleTtlMs);

  const evicted: string[] = [];
  while (options.sessions.size > options.maxEntries) {
    const oldestSessionId = options.sessions.keys().next().value;
    if (!oldestSessionId) break;
    options.sessions.delete(oldestSessionId);
    evicted.push(oldestSessionId);
  }
  return evicted;
}

export function sendToRelaySession(options: {
  relayWs: RelaySessionSocket;
  session: RelaySessionState;
  payload: string;
  now?: number;
}): void {
  options.session.txSeq += 1;
  options.session.lastActivityAt = options.now ?? Date.now();
  const envelope = encryptEnvelope(options.session.key, options.payload, {
    profile: options.session.profile,
    sessionId: options.session.sessionId,
    epoch: options.session.epoch,
    seq: options.session.txSeq,
  });
  options.relayWs.send(envelope);
}

export function sendToAllRelaySessions(options: {
  relayWs: RelaySessionSocket;
  sessions: Map<string, RelaySessionState>;
  payload: string;
  keyRotateAfterMessages: number;
  now?: number;
  idleTtlMs?: number;
}): void {
  const now = options.now ?? Date.now();
  pruneIdleRelaySessions(options.sessions, now, options.idleTtlMs);

  for (const session of options.sessions.values()) {
    sendToRelaySession({
      relayWs: options.relayWs,
      session,
      payload: options.payload,
      now,
    });

    if (!session.keyRotationRequested && session.txSeq >= options.keyRotateAfterMessages) {
      const rotateNotice: RelayKeyUpdateRequiredFrame = {
        type: 'relay_key_update_required',
        sessionId: session.sessionId,
        nextEpoch: session.epoch + 1,
        reason: 'message_threshold',
      };
      options.relayWs.send(JSON.stringify(rotateNotice));
      session.keyRotationRequested = true;
    }
  }
}
