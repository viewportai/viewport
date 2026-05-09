import { describe, expect, it } from 'vitest';

import { relayRecoveryHint } from '../../src/cli/relay-diagnostics.js';

describe('relayRecoveryHint', () => {
  it('returns no hint for connected relay state', () => {
    expect(relayRecoveryHint({ state: 'connected' })).toBeNull();
  });

  it('explains daemon key registration failures', () => {
    expect(
      relayRecoveryHint({
        state: 'waiting_retry',
        lastErrorCode: 'DAEMON_KEY_REGISTER_FAILED',
        lastErrorMessage: 'daemon key registration failed: HTTP 404',
      }),
    ).toContain('Re-pair this daemon');
  });

  it('explains open relay circuits', () => {
    expect(
      relayRecoveryHint({
        state: 'circuit_open',
        reconnectAttempt: 5,
        lastErrorCode: 'CIRCUIT_OPEN',
      }),
    ).toContain('run `vpd restart`');
  });

  it('explains inactive runtime target bindings', () => {
    expect(
      relayRecoveryHint({
        state: 'waiting_retry',
        lastErrorCode: 'RUNTIME_TARGET_NOT_FOUND',
        lastErrorMessage: 'runtime target not found',
      }),
    ).toContain('Re-pair this machine');
  });

  it('explains runtime target binding mismatches', () => {
    expect(
      relayRecoveryHint({
        state: 'waiting_retry',
        lastErrorCode: 'RUNTIME_TARGET_MISMATCH',
        lastErrorMessage: 'daemon connected with a different runtime target',
      }),
    ).toContain('different runtime target');
  });

  it('explains network failures', () => {
    expect(
      relayRecoveryHint({
        state: 'waiting_retry',
        lastErrorCode: 'ECONNREFUSED',
        lastErrorMessage: 'connection refused',
      }),
    ).toContain('Verify the server URL');
  });

  it('returns a generic retry hint for unknown retrying states', () => {
    expect(relayRecoveryHint({ state: 'waiting_retry' })).toContain('Relay is retrying');
  });
});
