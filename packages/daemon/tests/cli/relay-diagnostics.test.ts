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

  it('explains inactive project machine bindings', () => {
    expect(
      relayRecoveryHint({
        state: 'waiting_retry',
        lastErrorCode: 'PROJECT_MACHINE_BINDING_NOT_FOUND',
        lastErrorMessage: 'project machine binding not found',
      }),
    ).toContain('Re-pair this machine');
  });

  it('explains project machine binding mismatches', () => {
    expect(
      relayRecoveryHint({
        state: 'waiting_retry',
        lastErrorCode: 'PROJECT_MACHINE_BINDING_MISMATCH',
        lastErrorMessage: 'daemon connected with a different project machine binding',
      }),
    ).toContain('different project machine binding');
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
