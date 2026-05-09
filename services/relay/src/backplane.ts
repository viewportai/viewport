import { RelayBusClient, type RelayBusFrame } from './bus.js';
import type { RelayConfig, RelayBackplaneMode } from './config.js';
import type { RelayLogger } from './logger.js';
import type { RelayMetrics } from './metrics.js';
import { RelayPresenceClient } from './presence.js';
import { RedisRelayBackplane } from './redis-backplane.js';

export interface RelayPresenceResolution {
  relayId: string;
  relayWsBaseUrl: string;
  daemonConnected: boolean;
  runtimeTargetId?: string;
  machineId?: string;
}

export interface RelayBackplane {
  readonly mode: RelayBackplaneMode;
  readonly crossRelayEnabled: boolean;
  readonly pollIntervalMs: number | null;
  resolvePresence(workspaceId: string, runtimeTargetId?: string): Promise<RelayPresenceResolution | null>;
  upsertPresence(
    workspaceId: string,
    daemonConnected: boolean,
    runtimeTargetId?: string,
    machineId?: string,
  ): Promise<void>;
  publishClientToDaemon(
    workspaceId: string,
    runtimeTargetId: string,
    machineId: string | undefined,
    payload: string,
    targetRelayId?: string,
  ): Promise<boolean>;
  publishDaemonToClients(
    workspaceId: string,
    runtimeTargetId: string,
    machineId: string | undefined,
    payload: string,
    targetRelayId?: string | null,
  ): Promise<boolean>;
  pullFrames(): Promise<RelayBusFrame[]>;
  close?(): Promise<void>;
}

class SingleRelayBackplane implements RelayBackplane {
  readonly mode = 'single' as const;
  readonly crossRelayEnabled = false;
  readonly pollIntervalMs = null;

  async resolvePresence(): Promise<RelayPresenceResolution | null> {
    return null;
  }

  async upsertPresence(): Promise<void> {
    return;
  }

  async publishClientToDaemon(): Promise<boolean> {
    return false;
  }

  async publishDaemonToClients(): Promise<boolean> {
    return false;
  }

  async pullFrames(): Promise<RelayBusFrame[]> {
    return [];
  }
}

class ServerRelayBackplane implements RelayBackplane {
  readonly mode = 'server' as const;
  readonly crossRelayEnabled = true;
  readonly pollIntervalMs: number;

  private readonly presence: RelayPresenceClient;
  private readonly bus: RelayBusClient;

  constructor(config: RelayConfig, logger: RelayLogger, metrics: RelayMetrics) {
    this.presence = new RelayPresenceClient(config, logger, metrics);
    this.bus = new RelayBusClient(config, logger, metrics);
    this.pollIntervalMs = config.busPollIntervalMs;
  }

  async resolvePresence(
    workspaceId: string,
    runtimeTargetId?: string,
  ): Promise<RelayPresenceResolution | null> {
    return runtimeTargetId
      ? await this.presence.resolve(workspaceId, runtimeTargetId)
      : await this.presence.resolve(workspaceId);
  }

  async upsertPresence(
    workspaceId: string,
    daemonConnected: boolean,
    runtimeTargetId?: string,
    machineId?: string,
  ): Promise<void> {
    if (runtimeTargetId || machineId) {
      await this.presence.upsert(workspaceId, daemonConnected, runtimeTargetId, machineId);
      return;
    }

    await this.presence.upsert(workspaceId, daemonConnected);
  }

  async publishClientToDaemon(
    workspaceId: string,
    runtimeTargetId: string,
    machineId: string | undefined,
    payload: string,
    targetRelayId?: string,
  ): Promise<boolean> {
    return await this.bus.publishClientToDaemon(
      workspaceId,
      runtimeTargetId,
      machineId,
      payload,
      targetRelayId,
    );
  }

  async publishDaemonToClients(
    workspaceId: string,
    runtimeTargetId: string,
    machineId: string | undefined,
    payload: string,
    targetRelayId?: string | null,
  ): Promise<boolean> {
    return await this.bus.publishDaemonToClients(
      workspaceId,
      runtimeTargetId,
      machineId,
      payload,
      targetRelayId,
    );
  }

  async pullFrames(): Promise<RelayBusFrame[]> {
    return await this.bus.pull();
  }
}

export function createRelayBackplane(config: RelayConfig, logger: RelayLogger, metrics: RelayMetrics): RelayBackplane {
  switch (config.backplaneMode) {
    case 'single':
      return new SingleRelayBackplane();
    case 'server':
      return new ServerRelayBackplane(config, logger, metrics);
    case 'redis':
      return new RedisRelayBackplane(config, logger, metrics);
  }
}
