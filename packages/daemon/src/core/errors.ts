/**
 * Structured error type for the Viewport daemon.
 * Every error has a machine-readable code and human-readable message.
 */

import { ErrorCodes, type ErrorCode } from './error-codes.js';

export type ViewportErrorCode = ErrorCode;

export class ViewportError extends Error {
  readonly code: ViewportErrorCode;
  readonly statusCode: number;

  constructor(code: ViewportErrorCode, message: string, statusCode?: number) {
    super(message);
    this.name = 'ViewportError';
    this.code = code;
    this.statusCode = statusCode ?? codeToStatus(code);
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

function codeToStatus(code: ViewportErrorCode): number {
  switch (code) {
    case ErrorCodes.AUTH_REQUIRED:
    case ErrorCodes.AUTH_INVALID:
      return 401;
    case ErrorCodes.PERMISSION_DENIED:
      return 403;
    case ErrorCodes.RATE_LIMITED:
      return 429;
    case ErrorCodes.SESSION_NOT_FOUND:
    case ErrorCodes.DIRECTORY_NOT_FOUND:
    case ErrorCodes.DIRECTORY_NOT_REGISTERED:
      return 404;
    case ErrorCodes.SESSION_ALREADY_EXISTS:
      return 409;
    case ErrorCodes.INVALID_INPUT:
    case ErrorCodes.CONFIG_INVALID:
      return 400;
    case ErrorCodes.ADAPTER_NOT_AVAILABLE:
      return 503;
    default:
      return 500;
  }
}
