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
