import { describe, expect, it } from 'vitest';
import { HTTP_LOG_REDACT_PATHS } from '../src/startup.js';

describe('startup logger configuration', () => {
  it('redacts auth-sensitive headers in Fastify request logs', () => {
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers.authorization');
    expect(HTTP_LOG_REDACT_PATHS).toContain('req.headers.cookie');
    expect(HTTP_LOG_REDACT_PATHS).toContain('res.headers["set-cookie"]');
  });
});
