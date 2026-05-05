import type { FastifyInstance } from 'fastify';
import type { Daemon } from '../core/daemon.js';
import { metrics } from '../core/metrics.js';
import { resolveDaemonRuntimeIdentity } from '../core/runtime-identity.js';
import type { DaemonRelayBridgeStatus } from '../relay/daemon-relay-bridge.js';
import type { DaemonRuntimeInfo } from './http-route-types.js';

export function registerHealthRoutes(
  app: FastifyInstance,
  daemon: Daemon,
  options: {
    getRelayStatus?: () => DaemonRelayBridgeStatus | null;
    runtime?: DaemonRuntimeInfo;
    startedAtFallback: number;
  },
): void {
  app.get('/health', async () => {
    const runtime = options.runtime;
    const memory = process.memoryUsage();
    const relayEnabled = runtime?.relayEnabled ?? false;
    const relayStatus = options.getRelayStatus?.() ?? null;
    const machine = resolveDaemonRuntimeIdentity({
      daemonConfig: daemon.configManager.getDaemonConfig(),
      machineId: daemon.configManager.getMachineId(),
      daemonVersion: runtime?.version ?? 'unknown',
    });

    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - (runtime?.startedAt ?? options.startedAtFallback)) / 1000),
      pid: process.pid,
      startedAt: runtime?.startedAt ?? options.startedAtFallback,
      now: Date.now(),
      host: runtime?.host ?? '127.0.0.1',
      port: runtime?.port ?? Number(process.env['PORT'] ?? 7070),
      listen: runtime?.listen ?? `${runtime?.host ?? '127.0.0.1'}:${runtime?.port ?? 7070}`,
      socketPath: runtime?.socketPath,
      sessions: daemon.getActiveSessions().length,
      directories: daemon.directoryManager.list().length,
      agents: daemon.getAvailableAgents().join(', ') || 'none',
      version: runtime?.version ?? '0.1.0',
      machine,
      process: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        memoryRss: memory.rss,
        memoryHeapUsed: memory.heapUsed,
        memoryHeapTotal: memory.heapTotal,
      },
      relay:
        relayEnabled || relayStatus
          ? {
              enabled: relayEnabled || !!relayStatus,
              state: relayStatus?.state ?? (relayEnabled ? 'connecting' : 'stopped'),
              reconnectAttempt: relayStatus?.reconnectAttempt ?? 0,
              lastErrorCode: relayStatus?.lastErrorCode,
              lastErrorMessage: relayStatus?.lastErrorMessage,
              lastErrorAt: relayStatus?.lastErrorAt,
              circuitOpenUntil: relayStatus?.circuitOpenUntil,
            }
          : undefined,
    };
  });

  app.get('/api/metrics', async () => {
    const snapshot = metrics.snapshot();

    snapshot.gauges['sessions.active'] = daemon.getActiveSessions().length;
    snapshot.gauges['directories.registered'] = daemon.directoryManager.list().length;
    snapshot.gauges['uptime.seconds'] = Math.floor((Date.now() - options.startedAtFallback) / 1000);

    return snapshot;
  });
}
