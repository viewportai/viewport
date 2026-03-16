import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';

export function extractIpAddress(req: IncomingMessage): string {
  return extractIpAddressWithTrustedProxies(req, []);
}

export function extractIpAddressWithTrustedProxies(
  req: IncomingMessage,
  trustedProxies: string[],
): string {
  const remote = normalizeIp(req.socket.remoteAddress || 'unknown');
  const isTrustedProxy = isTrustedProxyAddress(remote, trustedProxies);
  const forwarded = req.headers['x-forwarded-for'];
  if (isTrustedProxy && typeof forwarded === 'string' && forwarded.trim()) {
    return normalizeIp(forwarded.split(',')[0]?.trim() || 'unknown');
  }
  return remote;
}

export function isAdminAuthorized(
  req: IncomingMessage,
  adminTokenHash: string | undefined,
  enabled: boolean,
): boolean {
  if (!enabled) return false;
  if (!adminTokenHash) return false;
  const headerToken = extractAdminToken(req);
  if (!headerToken) return false;
  const providedHash = hashToken(headerToken);
  return secureCompare(providedHash, adminTokenHash);
}

function extractAdminToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) return m[1].trim();
  }
  const xToken = req.headers['x-relay-admin-token'];
  if (typeof xToken === 'string' && xToken.trim()) {
    return xToken.trim();
  }
  return null;
}

function secureCompare(aRaw: string, bRaw: string): boolean {
  const a = Buffer.from(aRaw, 'utf8');
  const b = Buffer.from(bRaw, 'utf8');
  const compareLength = Math.max(a.length, b.length, 1);
  const paddedA = Buffer.alloc(compareLength);
  const paddedB = Buffer.alloc(compareLength);
  a.copy(paddedA);
  b.copy(paddedB);
  const equal = crypto.timingSafeEqual(paddedA, paddedB);
  return equal && a.length === b.length;
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function normalizeIp(value: string): string {
  if (value.startsWith('::ffff:')) {
    return value.slice(7);
  }
  return value;
}

function isTrustedProxyAddress(remoteAddress: string, trustedProxies: string[]): boolean {
  const normalizedRemote = normalizeIp(remoteAddress);
  const family = net.isIP(normalizedRemote);
  if (family === 0) return false;

  const matcher = buildTrustedProxyMatcher(trustedProxies);
  return matcher.check(normalizedRemote, family === 4 ? 'ipv4' : 'ipv6');
}

function buildTrustedProxyMatcher(trustedProxies: string[]): net.BlockList {
  const matcher = new net.BlockList();
  for (const rawEntry of trustedProxies) {
    const entry = normalizeIp(rawEntry.trim());
    if (!entry) continue;
    const slashIndex = entry.indexOf('/');
    if (slashIndex === -1) {
      const family = net.isIP(entry);
      if (family === 0) continue;
      matcher.addAddress(entry, family === 4 ? 'ipv4' : 'ipv6');
      continue;
    }

    const ipPart = normalizeIp(entry.slice(0, slashIndex));
    const prefixPart = entry.slice(slashIndex + 1);
    const family = net.isIP(ipPart);
    const prefix = Number(prefixPart);
    if (!Number.isInteger(prefix) || family === 0) continue;
    const maxPrefix = family === 4 ? 32 : 128;
    if (prefix < 0 || prefix > maxPrefix) continue;
    matcher.addSubnet(ipPart, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return matcher;
}

interface Bucket {
  count: number;
  windowStartMs: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    private readonly maxBuckets = Number.POSITIVE_INFINITY,
  ) {}

  private touchEntry(key: string, bucket: Bucket): void {
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
  }

  private enforceMaxBuckets(): void {
    while (this.buckets.size > this.maxBuckets) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
  }

  allow(key: string, now = Date.now()): boolean {
    const current = this.buckets.get(key);
    if (!current) {
      const created = { count: 1, windowStartMs: now };
      this.touchEntry(key, created);
      this.enforceMaxBuckets();
      return true;
    }
    if (now - current.windowStartMs >= this.windowMs) {
      current.count = 1;
      current.windowStartMs = now;
      this.touchEntry(key, current);
      return true;
    }
    if (current.count >= this.maxPerWindow) {
      this.touchEntry(key, current);
      return false;
    }
    current.count += 1;
    this.touchEntry(key, current);
    return true;
  }

  sweepStale(now = Date.now()): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.windowStartMs >= this.windowMs * 2) {
        this.buckets.delete(key);
      }
    }
    this.enforceMaxBuckets();
  }
}

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly refillPerMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillWindowMs: number,
    private readonly maxBuckets = Number.POSITIVE_INFINITY,
  ) {
    this.refillPerMs = capacity / refillWindowMs;
  }

  private refill(bucket: TokenBucket, now: number): void {
    if (now <= bucket.lastRefillMs) return;
    const elapsed = now - bucket.lastRefillMs;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.lastRefillMs = now;
  }

  private touchEntry(key: string, bucket: TokenBucket): void {
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
  }

  private enforceMaxBuckets(): void {
    while (this.buckets.size > this.maxBuckets) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
  }

  allow(key: string, now = Date.now()): boolean {
    const existing = this.buckets.get(key);
    if (!existing) {
      const created: TokenBucket = {
        tokens: this.capacity - 1,
        lastRefillMs: now,
      };
      this.touchEntry(key, created);
      this.enforceMaxBuckets();
      return true;
    }
    this.refill(existing, now);
    if (existing.tokens < 1) {
      this.touchEntry(key, existing);
      return false;
    }
    existing.tokens -= 1;
    this.touchEntry(key, existing);
    return true;
  }

  sweepStale(now = Date.now()): void {
    const staleAfterMs = this.refillWindowMs * 2;
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefillMs >= staleAfterMs) {
        this.buckets.delete(key);
      }
    }
    this.enforceMaxBuckets();
  }
}
