import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  extractIpAddressWithTrustedProxies,
  FixedWindowRateLimiter,
  isAdminAuthorized,
  TokenBucketRateLimiter,
} from '../src/security.js';

function tokenHash(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

describe('fixed window rate limiter', () => {
  it('allows requests within window and denies over limit', () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000);
    const now = 1_000_000;
    expect(limiter.allow('ip-a', now)).toBe(true);
    expect(limiter.allow('ip-a', now + 10)).toBe(true);
    expect(limiter.allow('ip-a', now + 20)).toBe(false);
  });

  it('resets after new window', () => {
    const limiter = new FixedWindowRateLimiter(1, 1_000);
    const now = 1_000_000;
    expect(limiter.allow('ip-a', now)).toBe(true);
    expect(limiter.allow('ip-a', now + 100)).toBe(false);
    expect(limiter.allow('ip-a', now + 1_001)).toBe(true);
  });

  it('sweeps stale keys', () => {
    const limiter = new FixedWindowRateLimiter(1, 100);
    const now = 5_000;
    limiter.allow('ip-a', now);
    limiter.sweepStale(now + 300);
    expect(limiter.allow('ip-a', now + 301)).toBe(true);
  });

  it('caps fixed-window bucket cardinality', () => {
    const limiter = new FixedWindowRateLimiter(1, 1_000, 2);
    const now = 10_000;
    expect(limiter.allow('ip-a', now)).toBe(true);
    expect(limiter.allow('ip-b', now)).toBe(true);
    expect(limiter.allow('ip-c', now)).toBe(true);
    const buckets = (limiter as unknown as { buckets: Map<string, unknown> }).buckets;
    expect(buckets.size).toBeLessThanOrEqual(2);
  });

  it('admin token compare never compares same buffer reference on length mismatch', () => {
    const calls: Array<[NodeJS.ArrayBufferView, NodeJS.ArrayBufferView]> = [];
    const spy = vi
      .spyOn(crypto, 'timingSafeEqual')
      .mockImplementation((a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
        calls.push([a, b]);
        return false;
      });

    try {
      const req = {
        headers: {
          authorization: 'Bearer short',
        },
        socket: {
          remoteAddress: '127.0.0.1',
        },
      } as unknown as IncomingMessage;

      expect(isAdminAuthorized(req, tokenHash('much-longer-admin-token'), true)).toBe(false);
      expect(calls.length).toBeGreaterThan(0);
      for (const [left, right] of calls) {
        expect(left === right).toBe(false);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('only trusts x-forwarded-for when remote address is a trusted proxy', () => {
    const req = {
      headers: {
        'x-forwarded-for': '198.51.100.20, 192.0.2.10',
      },
      socket: {
        remoteAddress: '203.0.113.99',
      },
    } as unknown as IncomingMessage;

    expect(extractIpAddressWithTrustedProxies(req, ['127.0.0.1'])).toBe('203.0.113.99');
    expect(extractIpAddressWithTrustedProxies(req, ['203.0.113.99'])).toBe('198.51.100.20');
  });

  it('accepts bearer token when hash matches configured admin token hash', () => {
    const req = {
      headers: {
        authorization: 'Bearer relay-admin',
      },
      socket: {
        remoteAddress: '127.0.0.1',
      },
    } as unknown as IncomingMessage;

    expect(isAdminAuthorized(req, tokenHash('relay-admin'), true)).toBe(true);
    expect(isAdminAuthorized(req, tokenHash('wrong-admin'), true)).toBe(false);
  });

  it('normalizes ipv4-mapped ipv6 addresses when evaluating trusted proxies', () => {
    const req = {
      headers: {
        'x-forwarded-for': '198.51.100.44',
      },
      socket: {
        remoteAddress: '::ffff:127.0.0.1',
      },
    } as unknown as IncomingMessage;

    expect(extractIpAddressWithTrustedProxies(req, ['127.0.0.1'])).toBe('198.51.100.44');
  });

  it('supports CIDR trusted proxy entries for IPv4', () => {
    const req = {
      headers: {
        'x-forwarded-for': '198.51.100.88, 192.0.2.1',
      },
      socket: {
        remoteAddress: '10.44.2.7',
      },
    } as unknown as IncomingMessage;

    expect(extractIpAddressWithTrustedProxies(req, ['10.44.0.0/16'])).toBe('198.51.100.88');
  });

  it('supports CIDR trusted proxy entries for IPv6', () => {
    const req = {
      headers: {
        'x-forwarded-for': '2001:db8::77',
      },
      socket: {
        remoteAddress: '2001:db8:abcd::1',
      },
    } as unknown as IncomingMessage;

    expect(extractIpAddressWithTrustedProxies(req, ['2001:db8:abcd::/48'])).toBe('2001:db8::77');
  });
});

describe('token bucket rate limiter', () => {
  it('enforces burst capacity and refill', () => {
    const limiter = new TokenBucketRateLimiter(2, 1_000);
    const now = 1_000_000;
    expect(limiter.allow('client-a', now)).toBe(true);
    expect(limiter.allow('client-a', now + 1)).toBe(true);
    expect(limiter.allow('client-a', now + 2)).toBe(false);
    expect(limiter.allow('client-a', now + 600)).toBe(true);
  });

  it('caps token-bucket cardinality', () => {
    const limiter = new TokenBucketRateLimiter(1, 1_000, 2);
    const now = 2_000_000;
    expect(limiter.allow('a', now)).toBe(true);
    expect(limiter.allow('b', now)).toBe(true);
    expect(limiter.allow('c', now)).toBe(true);
    const buckets = (limiter as unknown as { buckets: Map<string, unknown> }).buckets;
    expect(buckets.size).toBeLessThanOrEqual(2);
  });
});
