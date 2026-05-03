import type { ConfigManager } from '../core/config.js';
import type { DaemonEvents } from '../core/events.js';
import { transportFetch } from '../cli/network.js';

type Fetcher = typeof transportFetch;
type PlanProposedEvent = DaemonEvents['hook:plan-proposed'];

export interface PlatformPlanHookSyncResult {
  synced: boolean;
  reason?: string;
  status?: number;
}

export class PlatformPlanHookSync {
  constructor(
    private readonly configManager: Pick<ConfigManager, 'getDaemonConfig'>,
    private readonly fetcher: Fetcher = transportFetch,
  ) {}

  async send(event: PlanProposedEvent): Promise<PlatformPlanHookSyncResult> {
    const target = this.targetFor();
    if (!target) return { synced: false, reason: 'missing_platform_target' };

    const res = await this.fetcher(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credential: target.issueToken,
        hook_event_name: 'PlanProposed',
        session_id: event.sessionId,
        cwd: event.cwd ?? null,
        title: event.title ?? null,
        summary: event.summary ?? null,
        body: event.body,
        source: event.source ?? event.adapter,
        source_ref: event.sourceRef ?? null,
        payload: sanitizeMetadata(event.metadata),
      }),
      timeoutMs: 5_000,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    });

    if (!res.ok) {
      return { synced: false, reason: 'platform_rejected_plan_hook', status: res.status };
    }

    return { synced: true };
  }

  private targetFor(): {
    url: string;
    issueToken: string;
    tlsVerify?: 'auto' | '0' | '1';
    caCertPath?: string;
    tlsPins?: string[];
  } | null {
    const daemonConfig = this.configManager.getDaemonConfig();
    const server = daemonConfig?.server ?? {};
    const relay = daemonConfig?.relay ?? {};
    const serverUrl = relay.serverUrl ?? server.url;
    const issueToken = relay.issueToken;
    const projectId = relay.workspaceId;

    if (!serverUrl || !issueToken || !projectId) return null;

    return {
      url: `${serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(projectId)}/agent-hooks/plans`,
      issueToken,
      tlsVerify: server.tlsVerify,
      caCertPath: server.caCertPath,
      tlsPins: server.tlsPins,
    };
  }
}

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};

  const allowed = new Set([
    'extractedFrom',
    'format',
    'marker',
    'providerModel',
    'schema',
    'workflowNodeId',
    'workflowRunId',
  ]);
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!allowed.has(key)) continue;
    if (['string', 'number', 'boolean'].includes(typeof value) || value === null) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
