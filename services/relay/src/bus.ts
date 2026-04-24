import { URL } from 'node:url';
import type { RelayConfig } from './config.js';
import { signBusFrame, verifyBusFrameSignature, type BusSignatureFields } from './bus-signing.js';
import { postInternalJson, resolveInternalApiTlsOptions, type InternalTlsOptions } from './internal-api.js';
import type { RelayLogger } from './logger.js';
import type { RelayMetrics } from './metrics.js';

interface BusPublishResponse {
  ok?: boolean;
}

interface BusPullFrame {
  id?: number;
  workspaceId?: string;
  projectMachineBindingId?: string;
  machineId?: string;
  sourceRelayId?: string;
  targetRelayId?: string | null;
  direction?: string;
  payload?: string;
  issuedAtMs?: number;
  signature?: string;
}

interface BusPullResponse {
  ok?: boolean;
  frames?: BusPullFrame[];
}

export interface RelayBusFrame {
  id: number;
  workspaceId: string;
  projectMachineBindingId: string;
  machineId?: string;
  sourceRelayId: string;
  targetRelayId: string | null;
  direction: 'client_to_daemon' | 'daemon_to_clients';
  payload: string;
  issuedAtMs?: number;
  signature?: string;
}

type PublishDirection = RelayBusFrame['direction'];

export class RelayBusClient {
  private readonly enabled: boolean;
  private readonly tlsOptions: InternalTlsOptions;
  private readonly busHmacKey: Buffer | null;
  private readonly lastAcceptedIssuedAtMs = new Map<string, number>();
  private readonly lastAcceptedSignature = new Map<string, string>();
  private readonly seenSignedFrames = new Map<string, number>();
  private sinceId = 0;

  constructor(
    private readonly config: RelayConfig,
    private readonly logger: RelayLogger,
    private readonly metrics: RelayMetrics,
  ) {
    this.enabled = config.busEnabled && !!config.relayInternalKey;
    this.tlsOptions = resolveInternalApiTlsOptions(config);
    this.busHmacKey = config.busHmacKey ? Buffer.from(config.busHmacKey, 'utf8') : null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async publishClientToDaemon(
    workspaceId: string,
    projectMachineBindingId: string,
    machineId: string | undefined,
    payload: string,
    targetRelayId?: string,
  ): Promise<boolean> {
    return await this.publish(
      workspaceId,
      projectMachineBindingId,
      machineId,
      'client_to_daemon',
      payload,
      targetRelayId ?? '',
    );
  }

  async publishDaemonToClients(
    workspaceId: string,
    projectMachineBindingId: string,
    machineId: string | undefined,
    payload: string,
    targetRelayId?: string | null,
  ): Promise<boolean> {
    return await this.publish(
      workspaceId,
      projectMachineBindingId,
      machineId,
      'daemon_to_clients',
      payload,
      targetRelayId ?? null,
    );
  }

  private async publish(
    workspaceId: string,
    projectMachineBindingId: string | undefined,
    machineId: string | undefined,
    direction: PublishDirection,
    payload: string,
    targetRelayId: string | null,
  ): Promise<boolean> {
    if (!this.enabled) return false;
    if (!projectMachineBindingId || projectMachineBindingId.trim().length === 0) {
      this.metrics.increment('relay_bus_publish_failed_total');
      this.logger.warn('relay_bus_publish_failed', {
        workspaceId,
        direction,
        targetRelayId,
        reason: 'missing_project_machine_binding',
      });
      return false;
    }
    const endpoint = new URL('/api/runtime/internal/relay/bus/publish', this.config.serverUrl);
    const signed: BusSignatureFields = {
      workspaceId,
      projectMachineBindingId,
      machineId,
      sourceRelayId: this.config.relayId,
      targetRelayId,
      direction,
      payload,
      issuedAtMs: Date.now(),
    };
    try {
      const res = await postInternalJson<Record<string, unknown>, BusPublishResponse>(
        endpoint,
        {
          workspaceId,
          projectMachineBindingId,
          machineId,
          sourceRelayId: this.config.relayId,
          targetRelayId,
          direction,
          payload,
          issuedAtMs: this.busHmacKey ? signed.issuedAtMs : undefined,
          signature: this.busHmacKey ? signBusFrame(signed, this.busHmacKey) : undefined,
        },
        {
          'x-relay-internal-key': this.config.relayInternalKey!,
        },
        this.tlsOptions,
        this.config.internalApiTimeoutMs,
        this.config.internalApiMaxResponseBytes,
      );
      if (res.status >= 200 && res.status < 300 && res.json?.ok === true) {
        this.metrics.increment('relay_bus_publish_ok_total');
        return true;
      }
      this.metrics.increment('relay_bus_publish_failed_total');
      this.logger.warn('relay_bus_publish_failed', {
        workspaceId,
        direction,
        targetRelayId,
        status: res.status,
      });
      return false;
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

  async pull(): Promise<RelayBusFrame[]> {
    if (!this.enabled) return [];
    const endpoint = new URL('/api/runtime/internal/relay/bus/pull', this.config.serverUrl);
    try {
      const res = await postInternalJson<Record<string, unknown>, BusPullResponse>(
        endpoint,
        {
          relayId: this.config.relayId,
          sinceId: this.sinceId,
          limit: this.config.busPullLimit,
          waitMs: Math.min(2000, Math.max(0, this.config.busPullWaitMs)),
        },
        {
          'x-relay-internal-key': this.config.relayInternalKey!,
        },
        this.tlsOptions,
        this.config.internalApiTimeoutMs,
        this.config.internalApiMaxResponseBytes,
      );
      if (res.status < 200 || res.status >= 300 || res.json?.ok !== true) {
        this.metrics.increment('relay_bus_pull_failed_total');
        return [];
      }
      const framesRaw = Array.isArray(res.json.frames) ? res.json.frames : [];
      const frames: RelayBusFrame[] = [];
      const now = Date.now();
      for (const candidate of framesRaw) {
        if (typeof candidate.id !== 'number' || !Number.isInteger(candidate.id) || candidate.id <= 0) {
          continue;
        }
        if (candidate.id > this.sinceId) this.sinceId = candidate.id;
        if (candidate.sourceRelayId === this.config.relayId) continue;
        if (
          typeof candidate.workspaceId !== 'string' ||
          typeof candidate.projectMachineBindingId !== 'string' ||
          candidate.projectMachineBindingId.trim().length === 0 ||
          typeof candidate.sourceRelayId !== 'string' ||
          typeof candidate.payload !== 'string'
        ) {
          continue;
        }
        if (
          typeof candidate.targetRelayId === 'string' &&
          candidate.targetRelayId.trim().length > 0 &&
          candidate.targetRelayId !== this.config.relayId
        ) {
          continue;
        }
        if (Buffer.byteLength(candidate.payload, 'utf8') > this.config.maxFrameBytes) {
          this.metrics.increment('relay_bus_pull_frame_too_large_total');
          continue;
        }
        if (candidate.direction !== 'client_to_daemon' && candidate.direction !== 'daemon_to_clients') {
          continue;
        }

        if (this.busHmacKey) {
          if (typeof candidate.issuedAtMs !== 'number' || !Number.isInteger(candidate.issuedAtMs)) {
            this.metrics.increment('relay_bus_pull_invalid_signature_total');
            continue;
          }
          const skewMs = Math.abs(now - candidate.issuedAtMs);
          if (skewMs > this.config.busSignatureMaxSkewMs) {
            this.metrics.increment('relay_bus_pull_stale_signature_total');
            continue;
          }
          const candidateProjectMachineBindingId = candidate.projectMachineBindingId;
          const candidateMachineId = typeof candidate.machineId === 'string' ? candidate.machineId : '';
          const freshnessKey = [candidate.sourceRelayId, candidate.workspaceId, candidateProjectMachineBindingId].join(
            '\n',
          );
          const previousIssuedAt = this.lastAcceptedIssuedAtMs.get(freshnessKey);
          const previousSignature = this.lastAcceptedSignature.get(freshnessKey);
          const seenFrameKey = `${candidate.sourceRelayId}\n${candidate.workspaceId}\n${candidateProjectMachineBindingId}\n${candidate.signature}`;
          const seenFrameIssuedAt = this.seenSignedFrames.get(seenFrameKey);
          if (typeof seenFrameIssuedAt === 'number' && candidate.issuedAtMs <= seenFrameIssuedAt) {
            this.metrics.increment('relay_bus_pull_replayed_signature_total');
            continue;
          }
          if (
            typeof previousIssuedAt === 'number' &&
            (candidate.issuedAtMs < previousIssuedAt ||
              (candidate.issuedAtMs === previousIssuedAt &&
                typeof previousSignature === 'string' &&
                previousSignature === candidate.signature))
          ) {
            this.metrics.increment('relay_bus_pull_replayed_signature_total');
            continue;
          }
          if (typeof candidate.signature !== 'string' || candidate.signature.trim().length === 0) {
            this.metrics.increment('relay_bus_pull_invalid_signature_total');
            continue;
          }
          const validSignature = verifyBusFrameSignature(
            {
              workspaceId: candidate.workspaceId,
              projectMachineBindingId: candidateProjectMachineBindingId,
              machineId: candidateMachineId || undefined,
              sourceRelayId: candidate.sourceRelayId,
              targetRelayId: typeof candidate.targetRelayId === 'string' ? candidate.targetRelayId : null,
              direction: candidate.direction,
              payload: candidate.payload,
              issuedAtMs: candidate.issuedAtMs,
            },
            this.busHmacKey,
            candidate.signature,
          );
          if (!validSignature) {
            this.metrics.increment('relay_bus_pull_invalid_signature_total');
            continue;
          }
          this.lastAcceptedIssuedAtMs.delete(freshnessKey);
          this.lastAcceptedIssuedAtMs.set(freshnessKey, candidate.issuedAtMs);
          this.lastAcceptedSignature.delete(freshnessKey);
          this.lastAcceptedSignature.set(freshnessKey, candidate.signature);
          this.seenSignedFrames.delete(seenFrameKey);
          this.seenSignedFrames.set(seenFrameKey, candidate.issuedAtMs);
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

        frames.push({
          id: candidate.id,
          workspaceId: candidate.workspaceId,
          projectMachineBindingId: candidate.projectMachineBindingId,
          machineId: typeof candidate.machineId === 'string' ? candidate.machineId : undefined,
          sourceRelayId: candidate.sourceRelayId,
          targetRelayId: typeof candidate.targetRelayId === 'string' ? candidate.targetRelayId : null,
          direction: candidate.direction,
          payload: candidate.payload,
          issuedAtMs: typeof candidate.issuedAtMs === 'number' ? candidate.issuedAtMs : undefined,
          signature: typeof candidate.signature === 'string' ? candidate.signature : undefined,
        });
      }
      if (frames.length > 0) {
        this.metrics.increment('relay_bus_pull_ok_total');
      }
      return frames;
    } catch (error) {
      this.metrics.increment('relay_bus_pull_failed_total');
      this.logger.warn('relay_bus_pull_error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}
