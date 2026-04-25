import { describe, expect, it } from 'vitest';
import { classifyRetry } from '../../src/workflows/retry-classifier.js';

describe('classifyRetry', () => {
  it('treats every error as retryable when no policy is set', () => {
    expect(classifyRetry('rate limit hit', undefined)).toBe('fatal');
  });

  it('retries by default when a policy is set with no patterns', () => {
    expect(classifyRetry('rate limit hit', { maxAttempts: 3 })).toBe('retry');
  });

  it('treats any error as fatal when transient patterns are set and none match', () => {
    expect(
      classifyRetry('permission denied: read /etc/shadow', {
        maxAttempts: 3,
        transient: ['rate limit', 'timeout'],
      }),
    ).toBe('fatal');
  });

  it('retries when a transient pattern matches (case insensitive)', () => {
    expect(
      classifyRetry('OpenAI returned 429: rate limit reached', {
        maxAttempts: 3,
        transient: ['Rate Limit'],
      }),
    ).toBe('retry');
  });

  it('classifies fatal patterns as fatal even when transient also matches', () => {
    expect(
      classifyRetry('permission denied (rate limit)', {
        maxAttempts: 3,
        transient: ['rate limit'],
        fatal: ['permission denied'],
      }),
    ).toBe('fatal');
  });
});
