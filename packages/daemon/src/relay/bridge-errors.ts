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
