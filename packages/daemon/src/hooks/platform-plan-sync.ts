import type { ConfigManager } from '../core/config.js';
import type { DaemonEvents } from '../core/events.js';
import { transportFetch } from '../cli/network.js';
import { resolveConfiguredWorkspaceSyncTarget } from '../cli/context-sync-target.js';
import { resolveLocalOrgBindingSync } from '../cli/org-binding.js';
import { PLAN_PROPOSAL_SCHEMA_VERSION, sanitizePlanProposalMetadata } from './plan-extractor.js';

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
    const target = this.targetFor(event);
    if (!target) return { synced: false, reason: 'missing_platform_target' };

    const res = await this.fetcher(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credential: target.issueToken,
        hook_event_name: 'PlanProposed',
        schema: PLAN_PROPOSAL_SCHEMA_VERSION,
        session_id: event.sessionId,
        title: event.title ?? null,
        summary: event.summary ?? null,
        body: event.body,
        source: event.source ?? event.adapter,
        source_ref: event.sourceRef ?? `agent-hook:${event.sessionId}`,
        payload: sanitizePlanProposalMetadata(event.metadata),
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

  private targetFor(event: PlanProposedEvent): {
    url: string;
    issueToken: string;
    tlsVerify?: 'auto' | '0' | '1';
    caCertPath?: string;
    tlsPins?: string[];
  } | null {
    const daemonConfig = this.configManager.getDaemonConfig();
    if (!daemonConfig) return null;

    const cwd = typeof event.cwd === 'string' && event.cwd.length > 0 ? event.cwd : process.cwd();
    const requestedWorkspaceId = resolveLocalOrgBindingSync(cwd)?.organizationId;
    const target = resolveConfiguredWorkspaceSyncTarget(daemonConfig, { requestedWorkspaceId });
    if (!target) return null;

    return {
      url: `${target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(target.workspaceId)}/agent-hooks/plans`,
      issueToken: target.credential,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    };
  }
}
