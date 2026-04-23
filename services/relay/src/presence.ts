import { URL } from 'node:url';
import type { RelayConfig } from './config.js';
import { postInternalJson, resolveInternalApiTlsOptions, type InternalTlsOptions } from './internal-api.js';
import type { RelayLogger } from './logger.js';
import type { RelayMetrics } from './metrics.js';

interface PresenceResolveResponse {
  ok?: boolean;
  relayId?: string | null;
  relayWsBaseUrl?: string | null;
  daemonConnected?: boolean;
  stale?: boolean;
}

interface PresenceUpsertResponse {
  ok?: boolean;
}

interface PresenceCacheEntry {
  relayId: string;
  relayWsBaseUrl: string;
  daemonConnected: boolean;
  expiresAt: number;
}

export function isAllowedRedirectWsBaseUrl(relayWsBaseUrl: string, config: RelayConfig): boolean {
  let parsed: URL;
  try {
    parsed = new URL(relayWsBaseUrl);
  } catch {
    return false;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'ws:' && protocol !== 'wss:') {
    return false;
  }
  if (config.relayMode === 'prod' && protocol !== 'wss:') {
    return false;
  }
  if (!parsed.hostname) {
    return false;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return false;
  }

  const allowedHosts = config.redirectAllowedHosts;
  if (allowedHosts.length > 0) {
    return allowedHosts.includes(parsed.hostname.toLowerCase());
  }

  if (config.relayMode === 'prod') {
    const selfHostnames = new Set<string>();
    try {
      selfHostnames.add(new URL(config.publicWsBaseUrl).hostname.toLowerCase());
    } catch {
      // ignore malformed configured value here; fallback to tlsHost check below
    }
    selfHostnames.add(config.tlsHost.toLowerCase());
    return selfHostnames.has(parsed.hostname.toLowerCase());
  }

  return true;
}

export class RelayPresenceClient {
  private readonly resolveCache = new Map<string, PresenceCacheEntry>();
  private readonly tlsOptions: InternalTlsOptions;
  private readonly enabled: boolean;

  constructor(
    private readonly config: RelayConfig,
    private readonly logger: RelayLogger,
    private readonly metrics: RelayMetrics,
  ) {
    this.tlsOptions = resolveInternalApiTlsOptions(config);
    this.enabled = config.presenceSyncEnabled && !!config.relayInternalKey;
  }

  async upsert(workspaceId: string, daemonConnected: boolean): Promise<void> {
    if (!this.enabled) return;

    const endpoint = new URL('/api/runtime/internal/relay/presence/upsert', this.config.serverUrl);
    try {
      const res = await postInternalJson<Record<string, unknown>, PresenceUpsertResponse>(
        endpoint,
        {
          workspaceId,
          relayId: this.config.relayId,
          relayWsBaseUrl: this.config.publicWsBaseUrl,
          daemonConnected,
        },
        {
          'x-relay-internal-key': this.config.relayInternalKey!,
        },
        this.tlsOptions,
        this.config.internalApiTimeoutMs,
        this.config.internalApiMaxResponseBytes,
      );
      if (res.status >= 200 && res.status < 300 && res.json?.ok === true) {
        this.metrics.increment('relay_presence_upsert_ok_total');
        return;
      }
      this.metrics.increment('relay_presence_upsert_failed_total');
      this.logger.warn('relay_presence_upsert_failed', {
        workspaceId,
        status: res.status,
      });
    } catch (error) {
      this.metrics.increment('relay_presence_upsert_failed_total');
      this.logger.warn('relay_presence_upsert_error', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async resolve(workspaceId: string): Promise<PresenceCacheEntry | null> {
    if (!this.enabled) return null;

    const cached = this.resolveCache.get(workspaceId);
    if (cached && cached.expiresAt > Date.now()) {
      this.touchCache(workspaceId, cached);
      return cached;
    }

    const endpoint = new URL('/api/runtime/internal/relay/presence/resolve', this.config.serverUrl);
    try {
      const res = await postInternalJson<Record<string, unknown>, PresenceResolveResponse>(
        endpoint,
        { workspaceId },
        {
          'x-relay-internal-key': this.config.relayInternalKey!,
        },
        this.tlsOptions,
        this.config.internalApiTimeoutMs,
        this.config.internalApiMaxResponseBytes,
      );
      if (res.status < 200 || res.status >= 300 || !res.json?.ok) {
        this.metrics.increment('relay_presence_resolve_failed_total');
        return null;
      }

      const daemonConnected = res.json.daemonConnected === true;
      const relayId = typeof res.json.relayId === 'string' ? res.json.relayId : '';
      const relayWsBaseUrl =
        typeof res.json.relayWsBaseUrl === 'string' ? res.json.relayWsBaseUrl : '';
      if (!daemonConnected || !relayId || !relayWsBaseUrl) {
        return null;
      }
      if (!isAllowedRedirectWsBaseUrl(relayWsBaseUrl, this.config)) {
        this.metrics.increment('relay_presence_resolve_failed_total');
        this.logger.warn('relay_presence_resolve_invalid_redirect', {
          workspaceId,
          relayId,
          relayWsBaseUrl,
        });
        return null;
      }

      const entry: PresenceCacheEntry = {
        relayId,
        relayWsBaseUrl,
        daemonConnected: true,
        expiresAt: Date.now() + 2_000,
      };
      this.touchCache(workspaceId, entry);
      this.trimCache();
      this.metrics.increment('relay_presence_resolve_ok_total');
      return entry;
    } catch (error) {
      this.metrics.increment('relay_presence_resolve_failed_total');
      this.logger.warn('relay_presence_resolve_error', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private touchCache(workspaceId: string, entry: PresenceCacheEntry): void {
    this.resolveCache.delete(workspaceId);
    this.resolveCache.set(workspaceId, entry);
  }

  private trimCache(): void {
    while (this.resolveCache.size > this.config.presenceResolveCacheMax) {
      const oldest = this.resolveCache.keys().next();
      if (oldest.done) break;
      this.resolveCache.delete(oldest.value);
    }
  }
}
