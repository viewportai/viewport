import { describe, it, expect } from 'vitest';
import { ViewportError } from '../../src/core/errors.js';

describe('ViewportError', () => {
  it('has name ViewportError', () => {
    const err = new ViewportError('INTERNAL_ERROR', 'Something broke');
    expect(err.name).toBe('ViewportError');
  });

  it('is an instance of Error', () => {
    const err = new ViewportError('INTERNAL_ERROR', 'test');
    expect(err).toBeInstanceOf(Error);
  });

  it('stores code and message', () => {
    const err = new ViewportError('SESSION_NOT_FOUND', 'No session');
    expect(err.code).toBe('SESSION_NOT_FOUND');
    expect(err.message).toBe('No session');
  });

  it('maps AUTH_REQUIRED to 401', () => {
    expect(new ViewportError('AUTH_REQUIRED', '').statusCode).toBe(401);
  });

  it('maps AUTH_INVALID to 401', () => {
    expect(new ViewportError('AUTH_INVALID', '').statusCode).toBe(401);
  });

  it('maps PERMISSION_DENIED to 403', () => {
    expect(new ViewportError('PERMISSION_DENIED', '').statusCode).toBe(403);
  });

  it('maps RATE_LIMITED to 429', () => {
    expect(new ViewportError('RATE_LIMITED', '').statusCode).toBe(429);
  });

  it('maps SESSION_NOT_FOUND to 404', () => {
    expect(new ViewportError('SESSION_NOT_FOUND', '').statusCode).toBe(404);
  });

  it('maps DIRECTORY_NOT_FOUND to 404', () => {
    expect(new ViewportError('DIRECTORY_NOT_FOUND', '').statusCode).toBe(404);
  });

  it('maps DIRECTORY_NOT_REGISTERED to 404', () => {
    expect(new ViewportError('DIRECTORY_NOT_REGISTERED', '').statusCode).toBe(404);
  });

  it('maps SESSION_ALREADY_EXISTS to 409', () => {
    expect(new ViewportError('SESSION_ALREADY_EXISTS', '').statusCode).toBe(409);
  });

  it('maps INVALID_INPUT to 400', () => {
    expect(new ViewportError('INVALID_INPUT', '').statusCode).toBe(400);
  });

  it('maps CONFIG_INVALID to 400', () => {
    expect(new ViewportError('CONFIG_INVALID', '').statusCode).toBe(400);
  });

  it('maps ADAPTER_NOT_AVAILABLE to 503', () => {
    expect(new ViewportError('ADAPTER_NOT_AVAILABLE', '').statusCode).toBe(503);
  });

  it('maps INTERNAL_ERROR to 500', () => {
    expect(new ViewportError('INTERNAL_ERROR', '').statusCode).toBe(500);
  });

  it('maps PERMISSION_TIMEOUT to 500 (default)', () => {
    expect(new ViewportError('PERMISSION_TIMEOUT', '').statusCode).toBe(500);
  });

  it('maps GIT_OPERATION_FAILED to 500 (default)', () => {
    expect(new ViewportError('GIT_OPERATION_FAILED', '').statusCode).toBe(500);
  });

  it('allows custom statusCode override', () => {
    const err = new ViewportError('INTERNAL_ERROR', 'Custom', 502);
    expect(err.statusCode).toBe(502);
  });

  it('toJSON returns code and message', () => {
    const err = new ViewportError('SESSION_NOT_FOUND', 'No session found');
    expect(err.toJSON()).toEqual({
      code: 'SESSION_NOT_FOUND',
      message: 'No session found',
    });
  });
});
