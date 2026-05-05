export type BridgeErrorCode =
  | 'TOKEN_ISSUE_FAILED'
  | 'TOKEN_RESPONSE_INVALID'
  | 'DAEMON_KEY_REGISTER_FAILED'
  | 'KEY_EXCHANGE_FAILED'
  | 'WEBSOCKET_CONNECT_TIMEOUT'
  | 'ENVELOPE_DECRYPT_FAILED'
  | 'CIRCUIT_OPEN'
  | 'WEBSOCKET_ERROR'
  | 'UNKNOWN';

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export function normalizeBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) {
    return error;
  }
  if (error instanceof Error) {
    return new BridgeError('UNKNOWN', error.message);
  }
  return new BridgeError('UNKNOWN', String(error));
}

export function isControlPlaneBridgeError(code: BridgeErrorCode): boolean {
  return (
    code === 'TOKEN_ISSUE_FAILED' ||
    code === 'TOKEN_RESPONSE_INVALID' ||
    code === 'DAEMON_KEY_REGISTER_FAILED'
  );
}
