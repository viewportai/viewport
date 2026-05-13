/**
 * Simple token-bucket rate limiter for WebSocket commands.
 * Each client gets independent buckets per command type.
 */

export interface RateLimitConfig {
  /** Max tokens in the bucket. */
  maxTokens: number;
  /** Tokens refilled per second. */
  refillRate: number;
}

export const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  launch: { maxTokens: 3, refillRate: 0.05 }, // 3 per minute
  prompt: { maxTokens: 30, refillRate: 0.5 }, // 30 per minute
  'respond-permission': { maxTokens: 20, refillRate: 0.33 },
  // Read-only directory history hydration can legitimately fan out across
  // every registered directory when the web app opens `/sessions`.
  'list-sessions': { maxTokens: 60, refillRate: 2.0 },
  'read-session-messages': { maxTokens: 20, refillRate: 0.5 },
  'context-candidate-preview': { maxTokens: 20, refillRate: 0.5 },
  'trusted-edge-plan-decrypt': { maxTokens: 20, refillRate: 0.5 },
  'trusted-edge-plan-encrypt-field': { maxTokens: 40, refillRate: 1.0 },
  'trusted-edge-plan-wrap-key': { maxTokens: 20, refillRate: 0.5 },
  resume: { maxTokens: 3, refillRate: 0.05 },
  subscribe: { maxTokens: 40, refillRate: 1.0 },
  unsubscribe: { maxTokens: 40, refillRate: 1.0 },
  kill: { maxTokens: 15, refillRate: 0.5 },
  rollback: { maxTokens: 10, refillRate: 0.25 },
  'branch-retry': { maxTokens: 6, refillRate: 0.1 },
  'squash-merge': { maxTokens: 6, refillRate: 0.1 },
  'watch-discovered-session': { maxTokens: 20, refillRate: 0.5 },
  'unwatch-discovered-session': { maxTokens: 20, refillRate: 0.5 },
  supervise: { maxTokens: 20, refillRate: 0.5 },
  'respond-hook-permission': { maxTokens: 20, refillRate: 0.5 },
  'get-hook-plan-draft': { maxTokens: 20, refillRate: 0.5 },
};

export class RateLimiter {
  // per client ID -> per command type -> bucket state
  private buckets = new Map<string, Map<string, { tokens: number; lastRefill: number }>>();

  /** Check if a command is allowed. Returns true if allowed, false if rate-limited. */
  check(clientId: string, commandType: string): boolean {
    const config = DEFAULT_LIMITS[commandType];
    if (!config) return true; // No limit configured

    let clientBuckets = this.buckets.get(clientId);
    if (!clientBuckets) {
      clientBuckets = new Map();
      this.buckets.set(clientId, clientBuckets);
    }

    let bucket = clientBuckets.get(commandType);
    const now = Date.now() / 1000;

    if (!bucket) {
      bucket = { tokens: config.maxTokens, lastRefill: now };
      clientBuckets.set(commandType, bucket);
    }

    // Refill tokens
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(config.maxTokens, bucket.tokens + elapsed * config.refillRate);
    bucket.lastRefill = now;

    // Check
    if (bucket.tokens < 1) return false;

    // Consume
    bucket.tokens -= 1;
    return true;
  }

  /** Remove all buckets for a client (on disconnect). */
  removeClient(clientId: string): void {
    this.buckets.delete(clientId);
  }

  /** Reset all state. */
  clear(): void {
    this.buckets.clear();
  }
}
