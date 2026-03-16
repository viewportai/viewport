import { describe, expect, it } from 'vitest';
import { resolveMaxWsClients } from '../../src/server/ws-limits.js';

describe('resolveMaxWsClients', () => {
  it('uses explicit override when provided', () => {
    expect(resolveMaxWsClients(25, {})).toBe(25);
    expect(resolveMaxWsClients(0, {})).toBe(1);
  });

  it('uses env value when override is not provided', () => {
    expect(resolveMaxWsClients(undefined, { VIEWPORT_MAX_WS_CLIENTS: '150' })).toBe(150);
  });

  it('falls back to default for invalid env values', () => {
    expect(resolveMaxWsClients(undefined, { VIEWPORT_MAX_WS_CLIENTS: 'NaN' })).toBe(500);
    expect(resolveMaxWsClients(undefined, { VIEWPORT_MAX_WS_CLIENTS: '-2' })).toBe(500);
  });
});
