import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter, DEFAULT_LIMITS } from '../../src/server/rate-limiter.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  describe('check()', () => {
    it('allows commands up to the bucket limit', () => {
      const config = DEFAULT_LIMITS['launch']!;

      for (let i = 0; i < config.maxTokens; i++) {
        expect(limiter.check('client-1', 'launch')).toBe(true);
      }
    });

    it('rejects commands once the bucket is exhausted', () => {
      const config = DEFAULT_LIMITS['launch']!;

      // Drain the bucket
      for (let i = 0; i < config.maxTokens; i++) {
        limiter.check('client-1', 'launch');
      }

      // Next request should be rejected
      expect(limiter.check('client-1', 'launch')).toBe(false);
    });

    it('tracks clients independently', () => {
      const config = DEFAULT_LIMITS['launch']!;

      // Drain client-1
      for (let i = 0; i < config.maxTokens; i++) {
        limiter.check('client-1', 'launch');
      }
      expect(limiter.check('client-1', 'launch')).toBe(false);

      // client-2 should still have tokens
      expect(limiter.check('client-2', 'launch')).toBe(true);
    });

    it('tracks command types independently per client', () => {
      const launchConfig = DEFAULT_LIMITS['launch']!;

      // Drain launch tokens for client-1
      for (let i = 0; i < launchConfig.maxTokens; i++) {
        limiter.check('client-1', 'launch');
      }
      expect(limiter.check('client-1', 'launch')).toBe(false);

      // prompt should still have tokens for the same client
      expect(limiter.check('client-1', 'prompt')).toBe(true);
    });

    it('always allows commands without configured limits', () => {
      for (let i = 0; i < 100; i++) {
        expect(limiter.check('client-1', 'unknown-command')).toBe(true);
      }
    });

    it('allows session history hydration across many registered directories', () => {
      for (let i = 0; i < 14; i++) {
        expect(limiter.check('client-1', 'list-sessions')).toBe(true);
      }
    });

    it('refills tokens over time', () => {
      const config = DEFAULT_LIMITS['prompt']!;

      // Drain the bucket
      for (let i = 0; i < config.maxTokens; i++) {
        limiter.check('client-1', 'prompt');
      }
      expect(limiter.check('client-1', 'prompt')).toBe(false);

      // Simulate time passing by manipulating Date.now
      // The refillRate for prompt is 0.5 tokens/sec, so after 2 seconds we get 1 token
      const originalNow = Date.now;
      Date.now = () => originalNow() + 2000; // 2 seconds later

      expect(limiter.check('client-1', 'prompt')).toBe(true);

      // But immediately after consuming that refilled token, should be rejected again
      expect(limiter.check('client-1', 'prompt')).toBe(false);

      Date.now = originalNow;
    });

    it('does not exceed maxTokens when refilling', () => {
      const config = DEFAULT_LIMITS['launch']!;

      // Wait a very long time (simulated) — bucket should still cap at maxTokens
      const originalNow = Date.now;
      const baseTime = originalNow();

      // First call creates the bucket
      Date.now = () => baseTime;
      limiter.check('client-1', 'launch');

      // Jump forward 1 hour
      Date.now = () => baseTime + 3600 * 1000;

      // Should allow maxTokens calls (we used 1, but refill caps at maxTokens)
      for (let i = 0; i < config.maxTokens; i++) {
        expect(limiter.check('client-1', 'launch')).toBe(true);
      }
      expect(limiter.check('client-1', 'launch')).toBe(false);

      Date.now = originalNow;
    });
  });

  describe('removeClient()', () => {
    it('removes all buckets for a client', () => {
      const config = DEFAULT_LIMITS['launch']!;

      // Drain the bucket
      for (let i = 0; i < config.maxTokens; i++) {
        limiter.check('client-1', 'launch');
      }
      expect(limiter.check('client-1', 'launch')).toBe(false);

      // Remove client
      limiter.removeClient('client-1');

      // Client should get fresh buckets
      expect(limiter.check('client-1', 'launch')).toBe(true);
    });

    it('does not affect other clients', () => {
      const config = DEFAULT_LIMITS['launch']!;

      // Drain both clients
      for (let i = 0; i < config.maxTokens; i++) {
        limiter.check('client-1', 'launch');
        limiter.check('client-2', 'launch');
      }

      // Remove only client-1
      limiter.removeClient('client-1');

      // client-1 gets fresh buckets, client-2 is still drained
      expect(limiter.check('client-1', 'launch')).toBe(true);
      expect(limiter.check('client-2', 'launch')).toBe(false);
    });
  });

  describe('clear()', () => {
    it('resets all state for all clients', () => {
      const config = DEFAULT_LIMITS['launch']!;

      // Drain both clients
      for (let i = 0; i < config.maxTokens; i++) {
        limiter.check('client-1', 'launch');
        limiter.check('client-2', 'launch');
      }

      limiter.clear();

      // Both clients should have fresh buckets
      expect(limiter.check('client-1', 'launch')).toBe(true);
      expect(limiter.check('client-2', 'launch')).toBe(true);
    });
  });

  describe('DEFAULT_LIMITS', () => {
    it('has rate limits for expected command types', () => {
      expect(DEFAULT_LIMITS['launch']).toBeDefined();
      expect(DEFAULT_LIMITS['prompt']).toBeDefined();
      expect(DEFAULT_LIMITS['respond-permission']).toBeDefined();
      expect(DEFAULT_LIMITS['list-sessions']).toBeDefined();
      expect(DEFAULT_LIMITS['read-session-messages']).toBeDefined();
      expect(DEFAULT_LIMITS['resume']).toBeDefined();
      expect(DEFAULT_LIMITS['subscribe']).toBeDefined();
      expect(DEFAULT_LIMITS['watch-discovered-session']).toBeDefined();
      expect(DEFAULT_LIMITS['respond-hook-permission']).toBeDefined();
      expect(DEFAULT_LIMITS['get-hook-plan-draft']).toBeDefined();
    });

    it('all limits have positive maxTokens and refillRate', () => {
      for (const [, config] of Object.entries(DEFAULT_LIMITS)) {
        expect(config.maxTokens).toBeGreaterThan(0);
        expect(config.refillRate).toBeGreaterThan(0);
      }
    });
  });
});
