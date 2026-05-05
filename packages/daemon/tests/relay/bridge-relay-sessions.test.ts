import { describe, expect, it } from 'vitest';
import {
  RELAY_KEY_ROTATE_AFTER_MESSAGES,
  RELAY_REPLAY_WINDOW,
} from '../../src/relay/bridge-constants.js';
import { decryptEnvelope, parseRelayEnvelope } from '../../src/relay/bridge-crypto.js';
import {
  acceptInboundRelaySeq,
  createRelaySessionState,
  enforceRelaySessionCapacity,
  pruneIdleRelaySessions,
  sendToAllRelaySessions,
} from '../../src/relay/bridge-relay-sessions.js';

describe('bridge relay sessions', () => {
  it('encrypts outbound messages and emits one key-rotation notice at the threshold', () => {
    const sent: string[] = [];
    const session = createRelaySessionState(
      {
        key: Buffer.alloc(32, 4),
        profile: 'noise-ik',
        sessionId: 'rs_rotate',
        epoch: 1,
      },
      1_000,
    );
    session.txSeq = RELAY_KEY_ROTATE_AFTER_MESSAGES - 1;
    const sessions = new Map([[session.sessionId, session]]);

    sendToAllRelaySessions({
      relayWs: { send: (payload) => sent.push(payload) },
      sessions,
      payload: JSON.stringify({ type: 'ping' }),
      keyRotateAfterMessages: RELAY_KEY_ROTATE_AFTER_MESSAGES,
      now: 2_000,
    });
    sendToAllRelaySessions({
      relayWs: { send: (payload) => sent.push(payload) },
      sessions,
      payload: JSON.stringify({ type: 'pong' }),
      keyRotateAfterMessages: RELAY_KEY_ROTATE_AFTER_MESSAGES,
      now: 3_000,
    });

    expect(sent).toHaveLength(3);
    expect(decryptEnvelope(session.key, parseRelayEnvelope(sent[0] ?? ''))).toBe(
      JSON.stringify({ type: 'ping' }),
    );
    expect(JSON.parse(sent[1] ?? '{}')).toMatchObject({
      type: 'relay_key_update_required',
      sessionId: 'rs_rotate',
      nextEpoch: 2,
      reason: 'message_threshold',
    });
    expect(decryptEnvelope(session.key, parseRelayEnvelope(sent[2] ?? ''))).toBe(
      JSON.stringify({ type: 'pong' }),
    );
    expect(session.keyRotationRequested).toBe(true);
    expect(session.lastActivityAt).toBe(3_000);
  });

  it('deduplicates replayed inbound sequence numbers and rejects far-future frames', () => {
    const session = createRelaySessionState({
      key: Buffer.alloc(32, 5),
      profile: 'noise-ik',
      sessionId: 'rs_replay',
      epoch: 1,
    });

    expect(acceptInboundRelaySeq(session, 1)).toBe(true);
    expect(acceptInboundRelaySeq(session, 1)).toBe(false);
    expect(acceptInboundRelaySeq(session, RELAY_REPLAY_WINDOW + 10)).toBe(false);
  });

  it('prunes idle sessions before enforcing the session cap', () => {
    const sessions = new Map([
      [
        'idle',
        {
          ...createRelaySessionState({
            key: Buffer.alloc(32, 1),
            profile: 'noise-ik',
            sessionId: 'idle',
            epoch: 1,
          }),
          lastActivityAt: 1_000,
        },
      ],
      [
        'older',
        createRelaySessionState(
          {
            key: Buffer.alloc(32, 2),
            profile: 'noise-ik',
            sessionId: 'older',
            epoch: 1,
          },
          15_000,
        ),
      ],
      [
        'newer',
        createRelaySessionState(
          {
            key: Buffer.alloc(32, 3),
            profile: 'noise-ik',
            sessionId: 'newer',
            epoch: 1,
          },
          16_000,
        ),
      ],
    ]);

    expect(pruneIdleRelaySessions(sessions, 20_000, 10_000)).toEqual(['idle']);
    const evicted = enforceRelaySessionCapacity({
      sessions,
      maxEntries: 1,
      now: 20_000,
      idleTtlMs: 30_000,
    });

    expect(evicted).toEqual(['older']);
    expect([...sessions.keys()]).toEqual(['newer']);
  });
});
