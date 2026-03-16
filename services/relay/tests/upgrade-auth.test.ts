import { describe, expect, it } from 'vitest';
import { resolveUpgradeAuth } from '../src/upgrade-auth.js';

describe('upgrade auth', () => {
  it('accepts bearer token from Authorization header in prod mode', () => {
    const result = resolveUpgradeAuth({
      relayMode: 'prod',
      authorizationHeader: 'Bearer token-from-header',
      protocolHeader: undefined,
      queryToken: 'token-from-query',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toBe('token-from-header');
    expect(result.source).toBe('header');
  });

  it('accepts token from Sec-WebSocket-Protocol in prod mode', () => {
    const result = resolveUpgradeAuth({
      relayMode: 'prod',
      authorizationHeader: undefined,
      protocolHeader: 'viewport-relay-v1,auth.token-from-protocol',
      queryToken: undefined,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toBe('token-from-protocol');
    expect(result.source).toBe('protocol');
  });

  it('rejects query token in prod mode', () => {
    const result = resolveUpgradeAuth({
      relayMode: 'prod',
      authorizationHeader: undefined,
      protocolHeader: undefined,
      queryToken: 'query-token',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'QUERY_TOKEN_NOT_ALLOWED',
    });
  });

  it('allows query token in dev mode for local ergonomics', () => {
    const result = resolveUpgradeAuth({
      relayMode: 'dev',
      authorizationHeader: undefined,
      protocolHeader: undefined,
      queryToken: 'query-token',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toBe('query-token');
    expect(result.source).toBe('query');
  });
});
