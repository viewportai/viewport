import { describe, expect, it } from 'vitest';
import {
  BridgeError,
  isControlPlaneBridgeError,
  normalizeBridgeError,
  type BridgeErrorCode,
} from '../../src/relay/bridge-errors.js';

describe('bridge errors', () => {
  it('keeps existing bridge errors intact', () => {
    const error = new BridgeError('TOKEN_ISSUE_FAILED', 'token issue failed');

    expect(normalizeBridgeError(error)).toBe(error);
  });

  it('normalizes generic errors and thrown values', () => {
    expect(normalizeBridgeError(new Error('socket closed'))).toMatchObject({
      code: 'UNKNOWN',
      message: 'socket closed',
    });

    expect(normalizeBridgeError('boom')).toMatchObject({
      code: 'UNKNOWN',
      message: 'boom',
    });
  });

  it('classifies control-plane bridge errors for circuit breaker accounting', () => {
    const controlPlaneCodes: BridgeErrorCode[] = [
      'TOKEN_ISSUE_FAILED',
      'TOKEN_RESPONSE_INVALID',
      'DAEMON_KEY_REGISTER_FAILED',
    ];
    const runtimeCodes: BridgeErrorCode[] = [
      'KEY_EXCHANGE_FAILED',
      'WEBSOCKET_CONNECT_TIMEOUT',
      'ENVELOPE_DECRYPT_FAILED',
      'WEBSOCKET_ERROR',
      'UNKNOWN',
    ];

    expect(controlPlaneCodes.every(isControlPlaneBridgeError)).toBe(true);
    expect(runtimeCodes.some(isControlPlaneBridgeError)).toBe(false);
  });
});
