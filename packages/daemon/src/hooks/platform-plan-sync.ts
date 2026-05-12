import { openUrl } from '../cli/open-url.js';
import { resolveConfiguredWorkspaceSyncTarget } from '../cli/context-sync-target.js';
import { resolveLocalOrgBindingSync } from '../cli/org-binding.js';
import type { Daemon } from '../core/daemon.js';
import type { DaemonEvents } from '../core/events.js';

type PlanProposedEvent = DaemonEvents['hook:plan-proposed'];
type UrlOpener = (url: string) => void;

export interface PlatformPlanHookSyncResult {
  opened: boolean;
  reason?: string;
  planUrl?: string;
}

export class PlatformPlanHookSync {
  constructor(
    private readonly daemon: Pick<Daemon, 'configManager' | 'createEphemeralPlanDraft'>,
    private readonly urlOpener: UrlOpener = openUrl,
  ) {}

  async send(event: PlanProposedEvent): Promise<PlatformPlanHookSyncResult> {
    const target = this.targetFor(event);
    if (!target) return { opened: false, reason: 'missing_platform_target' };

    const draft = this.daemon.createEphemeralPlanDraft(target.workspaceId, event);
    const planUrl = buildDraftPlanUrl(target.appUrl, target.workspaceId, draft.draftId);
    try {
      this.urlOpener(planUrl);
    } catch {
      return { opened: false, reason: 'browser_open_failed', planUrl };
    }

    return { opened: true, planUrl };
  }

  private targetFor(event: PlanProposedEvent): { appUrl: string; workspaceId: string } | null {
    const daemonConfig = this.daemon.configManager.getDaemonConfig();
    if (!daemonConfig) return null;

    const cwd = typeof event.cwd === 'string' && event.cwd.length > 0 ? event.cwd : process.cwd();
    const requestedWorkspaceId = resolveLocalOrgBindingSync(cwd)?.organizationId;
    const target = resolveConfiguredWorkspaceSyncTarget(daemonConfig, { requestedWorkspaceId });
    if (!target) return null;

    return {
      appUrl: inferAppUrl(daemonConfig.server?.appUrl, target.serverUrl),
      workspaceId: target.workspaceId,
    };
  }
}

function buildDraftPlanUrl(appUrl: string, workspaceId: string, draftId: string): string {
  const url = new URL('/plans', appUrl);
  url.searchParams.set('resource_id', workspaceId);
  url.hash = `viewport-plan-draft=${encodeURIComponent(draftId)}`;
  return url.toString();
}

function inferAppUrl(configuredAppUrl: string | undefined, serverUrl: string): string {
  if (configuredAppUrl?.trim()) return configuredAppUrl.trim().replace(/\/+$/, '');

  try {
    const url = new URL(serverUrl);
    if (url.hostname === 'api.getviewport.com') {
      url.hostname = 'app.getviewport.com';
      return url.toString().replace(/\/+$/, '');
    }
    if (url.hostname === 'getviewport.test' || url.hostname === 'api.getviewport.test') {
      url.hostname = 'app.getviewport.test';
      return url.toString().replace(/\/+$/, '');
    }
    if (url.hostname === 'getviewport.dev' || url.hostname === 'api.getviewport.dev') {
      url.hostname = 'app.getviewport.dev';
      return url.toString().replace(/\/+$/, '');
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return serverUrl.replace(/\/+$/, '');
  }
}
