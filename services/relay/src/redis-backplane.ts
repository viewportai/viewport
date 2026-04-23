import { createClient } from 'redis';
import type { RelayBackplane, RelayPresenceResolution } from './backplane.js';
import type { RelayBusFrame } from './bus.js';
import { signBusFrame, verifyBusFrameSignature } from './bus-signing.js';
import type { RelayConfig } from './config.js';
import { isAllowedRedirectWsBaseUrl } from './presence.js';
import type { RelayLogger } from './logger.js';
import type { RelayMetrics } from './metrics.js';

interface RedisBusEnvelope {
  workspaceId: string;
  sourceRelayId: string;
  targetRelayId: string | null;
  installId?: string | null;
  direction: RelayBusFrame['direction'];
  payload: string;
  issuedAtMs?: number;
  signature?: string;
}

interface RedisPresenceEntry {
  relayId: string;
  relayWsBaseUrl: string;
  daemonConnected: boolean;
  updatedAtMs: number;
}

interface PresenceCacheEntry extends RelayPresenceResolution {
  expiresAt: number;
}

type RedisClient = ReturnType<typeof createClient>;

function normalizeRedisUrl(url: string | undefined): string {
  return (url ?? '').trim();
}

function isRedisBusEnvelope(value: unknown): value is RedisBusEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['workspaceId'] === 'string' &&
    typeof candidate['sourceRelayId'] === 'string' &&
    typeof candidate['payload'] === 'string' &&
    (candidate['targetRelayId'] === null || typeof candidate['targetRelayId'] === 'string') &&
    (typeof candidate['installId'] === 'undefined' ||
      candidate['installId'] === null ||
      typeof candidate['installId'] === 'string') &&
    (candidate['direction'] === 'client_to_daemon' ||
      candidate['direction'] === 'daemon_to_clients') &&
    (typeof candidate['issuedAtMs'] === 'undefined' || typeof candidate['issuedAtMs'] === 'number') &&
    (typeof candidate['signature'] === 'undefined' || typeof candidate['signature'] === 'string')
  );
}

function parseRedisPresenceEntry(raw: string | null): RedisPresenceEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entry = parsed as Record<string, unknown>;
    if (
      typeof entry['relayId'] !== 'string' ||
      typeof entry['relayWsBaseUrl'] !== 'string' ||
      typeof entry['daemonConnected'] !== 'boolean' ||
      typeof entry['updatedAtMs'] !== 'number'
    ) {
      return null;
    }
    return {
      relayId: entry['relayId'],
      relayWsBaseUrl: entry['relayWsBaseUrl'],
      daemonConnected: entry['daemonConnected'],
      updatedAtMs: entry['updatedAtMs'],
    };
  } catch {
    return null;
  }
}

function parseRedisBusEnvelope(raw: string): RedisBusEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRedisBusEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export class RedisRelayBackplane implements RelayBackplane {
  readonly mode = 'redis' as const;
  readonly crossRelayEnabled = true;
  readonly pollIntervalMs: number;

  private readonly redisUrl: string;
  private readonly keyPrefix: string;
  private readonly busHmacKey: Buffer | null;
  private readonly resolveCache = new Map<string, PresenceCacheEntry>();
  private readonly lastAcceptedIssuedAtMs = new Map<string, number>();
  private readonly lastAcceptedSignature = new Map<string, string>();
  private readonly seenSignedFrames = new Map<string, number>();
  private readonly commandClient: RedisClient;
  private readonly blockingClient: RedisClient;
  private commandConnectPromise: Promise<unknown> | null = null;
  private blockingConnectPromise: Promise<unknown> | null = null;

  constructor(
    private readonly config: RelayConfig,
    private readonly logger: RelayLogger,
    private readonly metrics: RelayMetrics,
  ) {
    this.redisUrl = normalizeRedisUrl(config.redisUrl);
    this.keyPrefix = config.redisKeyPrefix;
    this.busHmacKey = config.busHmacKey ? Buffer.from(config.busHmacKey, 'utf8') : null;
    this.pollIntervalMs = config.busPollIntervalMs;
    this.commandClient = this.createRedisClient('command');
    this.blockingClient = this.createRedisClient('blocking');
  }

  private createRedisClient(channel: 'command' | 'blocking'): RedisClient {
    const client = createClient({
      url: this.redisUrl,
      socket: {
        connectTimeout: this.config.redisConnectTimeoutMs,
        keepAlive: 5_000,
        reconnectStrategy: (retries) => Math.min(1_000 * 2 ** retries, 10_000),
      },
    });
    client.on('error', (error) => {
      this.logger.warn('relay_redis_error', {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return client;
  }

  private async ensureCommandClient(): Promise<RedisClient> {
    if (!this.commandClient.isOpen) {
      this.commandConnectPromise ??= this.commandClient.connect().finally(() => {
        this.commandConnectPromise = null;
      });
      await this.commandConnectPromise;
    }
    return this.commandClient;
  }

  private async ensureBlockingClient(): Promise<RedisClient> {
    if (!this.blockingClient.isOpen) {
      this.blockingConnectPromise ??= this.blockingClient.connect().finally(() => {
        this.blockingConnectPromise = null;
      });
      await this.blockingConnectPromise;
    }
    return this.blockingClient;
  }

  private presenceKey(workspaceId: string): string {
    return `${this.keyPrefix}:presence:${workspaceId}`;
  }

  private queueKey(relayId: string): string {
    return `${this.keyPrefix}:queue:${relayId}`;
  }

  async resolvePresence(workspaceId: string): Promise<RelayPresenceResolution | null> {
    const cached = this.resolveCache.get(workspaceId);
    if (cached && cached.expiresAt > Date.now()) {
      this.touchResolveCache(workspaceId, cached);
      return cached;
    }

    try {
      const client = await this.ensureCommandClient();
      const raw = await client.get(this.presenceKey(workspaceId));
      const entry = parseRedisPresenceEntry(raw);
      if (!entry?.daemonConnected) {
        this.resolveCache.delete(workspaceId);
        return null;
      }
      if (!isAllowedRedirectWsBaseUrl(entry.relayWsBaseUrl, this.config)) {
        this.metrics.increment('relay_presence_resolve_failed_total');
        this.logger.warn('relay_presence_resolve_invalid_redirect', {
          workspaceId,
          relayId: entry.relayId,
          relayWsBaseUrl: entry.relayWsBaseUrl,
        });
        return null;
      }

      const resolved: PresenceCacheEntry = {
        relayId: entry.relayId,
        relayWsBaseUrl: entry.relayWsBaseUrl,
        daemonConnected: true,
        expiresAt: Date.now() + Math.min(this.config.redisPresenceTtlMs, 2_000),
      };
      this.touchResolveCache(workspaceId, resolved);
      this.trimResolveCache();
      this.metrics.increment('relay_presence_resolve_ok_total');
      return resolved;
    } catch (error) {
      this.metrics.increment('relay_presence_resolve_failed_total');
      this.logger.warn('relay_presence_resolve_error', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async upsertPresence(workspaceId: string, daemonConnected: boolean): Promise<void> {
    try {
      const client = await this.ensureCommandClient();
      if (!daemonConnected) {
        await client.del(this.presenceKey(workspaceId));
        this.resolveCache.delete(workspaceId);
      } else {
        await client.set(
          this.presenceKey(workspaceId),
          JSON.stringify({
            relayId: this.config.relayId,
            relayWsBaseUrl: this.config.publicWsBaseUrl,
            daemonConnected: true,
            updatedAtMs: Date.now(),
          } satisfies RedisPresenceEntry),
          {
            PX: this.config.redisPresenceTtlMs,
          },
        );
      }
      this.metrics.increment('relay_presence_upsert_ok_total');
    } catch (error) {
      this.metrics.increment('relay_presence_upsert_failed_total');
      this.logger.warn('relay_presence_upsert_error', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async publishClientToDaemon(
    workspaceId: string,
    payload: string,
    targetRelayId: string,
    installId?: string | null,
  ): Promise<boolean> {
    return await this.publish(workspaceId, 'client_to_daemon', payload, targetRelayId, installId);
  }

  async publishDaemonToClients(
    workspaceId: string,
    payload: string,
    targetRelayId: string | null = null,
  ): Promise<boolean> {
    if (!targetRelayId) {
      this.logger.warn('relay_bus_publish_failed', {
        workspaceId,
        direction: 'daemon_to_clients',
        reason: 'missing_target_relay_id',
      });
      this.metrics.increment('relay_bus_publish_failed_total');
      return false;
    }
    return await this.publish(workspaceId, 'daemon_to_clients', payload, targetRelayId);
  }

  private async publish(
    workspaceId: string,
    direction: RelayBusFrame['direction'],
    payload: string,
    targetRelayId: string,
    installId?: string | null,
  ): Promise<boolean> {
    try {
      const client = await this.ensureCommandClient();
      const signedFields = {
        workspaceId,
        sourceRelayId: this.config.relayId,
        targetRelayId,
        installId,
        direction,
        payload,
        issuedAtMs: Date.now(),
      };
      const serialized = JSON.stringify({
        ...signedFields,
        signature: this.busHmacKey ? signBusFrame(signedFields, this.busHmacKey) : undefined,
      } satisfies RedisBusEnvelope);

      await client.rPush(this.queueKey(targetRelayId), serialized);
      if (this.config.redisQueueMax > 0) {
        await client.lTrim(this.queueKey(targetRelayId), -this.config.redisQueueMax, -1);
      }
      this.metrics.increment('relay_bus_publish_ok_total');
      return true;
    } catch (error) {
      this.metrics.increment('relay_bus_publish_failed_total');
      this.logger.warn('relay_bus_publish_error', {
        workspaceId,
        direction,
        targetRelayId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async pullFrames(): Promise<RelayBusFrame[]> {
    try {
      const blockingClient = await this.ensureBlockingClient();
      const commandClient = await this.ensureCommandClient();
      const timeoutSeconds =
        this.config.busPullWaitMs <= 0 ? 1 : Math.max(1, Math.ceil(this.config.busPullWaitMs / 1_000));
      const first = (await blockingClient.sendCommand([
        'BLPOP',
        this.queueKey(this.config.relayId),
        String(timeoutSeconds),
      ])) as [string, string] | null;
      if (!first) {
        return [];
      }

      const rawEntries = [first[1]];
      if (this.config.busPullLimit > 1) {
        const extra = (await commandClient.sendCommand([
          'LPOP',
          this.queueKey(this.config.relayId),
          String(this.config.busPullLimit - 1),
        ])) as string[] | string | null;
        if (Array.isArray(extra)) {
          rawEntries.push(...extra);
        } else if (typeof extra === 'string') {
          rawEntries.push(extra);
        }
      }

      const accepted: RelayBusFrame[] = [];
      const now = Date.now();
      for (const raw of rawEntries) {
        const parsed = parseRedisBusEnvelope(raw);
        if (!parsed) continue;
        if (Buffer.byteLength(parsed.payload, 'utf8') > this.config.maxFrameBytes) {
          this.metrics.increment('relay_bus_pull_frame_too_large_total');
          continue;
        }
        if (
          parsed.targetRelayId &&
          parsed.targetRelayId.trim().length > 0 &&
          parsed.targetRelayId !== this.config.relayId
        ) {
          continue;
        }
        if (
          parsed.direction !== 'client_to_daemon' &&
          parsed.direction !== 'daemon_to_clients'
        ) {
          continue;
        }
        if (this.busHmacKey) {
          if (
            typeof parsed.issuedAtMs !== 'number' ||
            !Number.isInteger(parsed.issuedAtMs) ||
            typeof parsed.signature !== 'string' ||
            parsed.signature.trim().length === 0
          ) {
            this.metrics.increment('relay_bus_pull_invalid_signature_total');
            continue;
          }
          const skewMs = Math.abs(now - parsed.issuedAtMs);
          if (skewMs > this.config.busSignatureMaxSkewMs) {
            this.metrics.increment('relay_bus_pull_stale_signature_total');
            continue;
          }
          const freshnessKey = `${parsed.sourceRelayId}\n${parsed.workspaceId}`;
          const previousIssuedAt = this.lastAcceptedIssuedAtMs.get(freshnessKey);
          const previousSignature = this.lastAcceptedSignature.get(freshnessKey);
          const seenFrameKey = `${parsed.sourceRelayId}\n${parsed.workspaceId}\n${parsed.signature}`;
          const seenFrameIssuedAt = this.seenSignedFrames.get(seenFrameKey);
          if (
            typeof seenFrameIssuedAt === 'number' &&
            parsed.issuedAtMs <= seenFrameIssuedAt
          ) {
            this.metrics.increment('relay_bus_pull_replayed_signature_total');
            continue;
          }
          if (
            typeof previousIssuedAt === 'number' &&
            (parsed.issuedAtMs < previousIssuedAt ||
              (parsed.issuedAtMs === previousIssuedAt &&
                typeof previousSignature === 'string' &&
                previousSignature === parsed.signature))
          ) {
            this.metrics.increment('relay_bus_pull_replayed_signature_total');
            continue;
          }
          const validSignature = verifyBusFrameSignature(
            {
              workspaceId: parsed.workspaceId,
              sourceRelayId: parsed.sourceRelayId,
              targetRelayId: parsed.targetRelayId,
              installId: parsed.installId ?? null,
              direction: parsed.direction,
              payload: parsed.payload,
              issuedAtMs: parsed.issuedAtMs,
            },
            this.busHmacKey,
            parsed.signature,
          );
          if (!validSignature) {
            this.metrics.increment('relay_bus_pull_invalid_signature_total');
            continue;
          }
          this.lastAcceptedIssuedAtMs.delete(freshnessKey);
          this.lastAcceptedIssuedAtMs.set(freshnessKey, parsed.issuedAtMs);
          this.lastAcceptedSignature.delete(freshnessKey);
          this.lastAcceptedSignature.set(freshnessKey, parsed.signature);
          this.seenSignedFrames.delete(seenFrameKey);
          this.seenSignedFrames.set(seenFrameKey, parsed.issuedAtMs);
          while (this.lastAcceptedIssuedAtMs.size > this.config.busFreshnessTrackMax) {
            const oldest = this.lastAcceptedIssuedAtMs.keys().next();
            if (oldest.done) break;
            this.lastAcceptedIssuedAtMs.delete(oldest.value);
            this.lastAcceptedSignature.delete(oldest.value);
          }
          const seenCap = Math.max(this.config.busFreshnessTrackMax * 4, 100_000);
          while (this.seenSignedFrames.size > seenCap) {
            const oldestSeen = this.seenSignedFrames.keys().next();
            if (oldestSeen.done) break;
            this.seenSignedFrames.delete(oldestSeen.value);
          }
        }

        accepted.push({
          id: now + accepted.length,
          workspaceId: parsed.workspaceId,
          sourceRelayId: parsed.sourceRelayId,
          targetRelayId: parsed.targetRelayId,
          installId: parsed.installId ?? null,
          direction: parsed.direction,
          payload: parsed.payload,
          issuedAtMs: parsed.issuedAtMs,
          signature: parsed.signature,
        });
      }

      this.metrics.increment('relay_bus_pull_ok_total');
      return accepted;
    } catch (error) {
      this.metrics.increment('relay_bus_pull_failed_total');
      this.logger.warn('relay_bus_pull_error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.commandClient.quit(), this.blockingClient.quit()]);
  }

  private touchResolveCache(workspaceId: string, entry: PresenceCacheEntry): void {
    this.resolveCache.delete(workspaceId);
    this.resolveCache.set(workspaceId, entry);
  }

  private trimResolveCache(): void {
    while (this.resolveCache.size > this.config.presenceResolveCacheMax) {
      const oldest = this.resolveCache.keys().next();
      if (oldest.done) break;
      this.resolveCache.delete(oldest.value);
    }
  }
}
