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
