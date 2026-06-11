import { describe, expect, it } from 'vitest';
import { isAllowedClientFrame, isAllowedDaemonFrame } from '../src/relay-frame-validation.js';

function envelope(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'e2ee',
    version: 2,
    profile: 'noise-ik',
    sessionId: 'sess-1',
    epoch: 1,
    seq: 1,
    iv: 'iv-1',
    tag: 'tag-1',
    ciphertext: 'cipher-1',
    ...overrides,
  });
}

describe('relay frame validation', () => {
  it('accepts bounded encrypted runtime envelopes for clients and daemons', () => {
    const frame = envelope();

    expect(isAllowedClientFrame(frame)).toBe(true);
    expect(isAllowedDaemonFrame(frame)).toBe(true);
  });

  it('rejects raw trusted-edge commands instead of forwarding plaintext through relay', () => {
    const rawContextCommand = JSON.stringify({
      type: 'context-candidate-preview',
      contextResourceId: 'ctx_123',
      candidateEventId: 'evt_rose_secret',
      body: 'SUPER_SECRET_ROSE_CONTEXT',
    });
    const rawPlanCommand = JSON.stringify({
      type: 'trusted-edge-plan-decrypt',
      planId: 'plan_123',
      bodyEncryption: {
        schema: 'viewport.plan_body_encrypted/v1',
        ciphertext: 'ciphertext',
      },
      bodyKeyGrants: [],
    });
    const rawAck = JSON.stringify({
      type: 'ack',
      requestId: 'req_123',
      status: 'ok',
      candidate: {
        title: 'SUPER_SECRET_ROSE_CONTEXT',
      },
    });

    expect(isAllowedClientFrame(rawContextCommand)).toBe(false);
    expect(isAllowedClientFrame(rawPlanCommand)).toBe(false);
    expect(isAllowedDaemonFrame(rawAck)).toBe(false);
  });

  it.each([
    ['sessionId'],
    ['iv'],
    ['tag'],
    ['ciphertext'],
  ] as const)('rejects encrypted envelopes with empty %s', (field) => {
    const frame = envelope({ [field]: '   ' });

    expect(isAllowedClientFrame(frame)).toBe(false);
    expect(isAllowedDaemonFrame(frame)).toBe(false);
  });
});

describe('session viewer presence frames', () => {
  const presence = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: 'viewport.session_viewer_presence/v1',
      channel: 'agent-session:session_a',
      action: 'joined',
      userId: 'user:42',
      displayName: 'Priya Patel',
      sentAt: '2026-06-11T00:00:00.000Z',
      ...overrides,
    });

  it.each([['joined'], ['heartbeat'], ['left']] as const)(
    'accepts a %s presence frame as a client frame',
    (action) => {
      expect(isAllowedClientFrame(presence({ action }))).toBe(true);
    },
  );

  it('accepts presence without the optional displayName/sentAt', () => {
    expect(isAllowedClientFrame(presence({ displayName: undefined, sentAt: undefined }))).toBe(true);
  });

  it.each([
    ['unknown action', { action: 'typing' }],
    ['missing userId', { userId: undefined }],
    ['empty userId', { userId: '   ' }],
    ['oversized userId', { userId: 'u'.repeat(129) }],
    ['non agent-session channel', { channel: 'workspace:demo' }],
    ['missing channel', { channel: undefined }],
    ['non-string displayName', { displayName: 42 }],
    ['oversized displayName', { displayName: 'x'.repeat(256) }],
    ['non-string sentAt', { sentAt: 1718000000 }],
  ] as const)('rejects presence frames with %s', (_label, overrides) => {
    expect(isAllowedClientFrame(presence(overrides as Record<string, unknown>))).toBe(false);
  });

  it('never admits presence as a daemon frame', () => {
    expect(isAllowedDaemonFrame(presence())).toBe(false);
  });
});
