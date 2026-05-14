import { configDir, loadConfig } from '../core/config.js';
import { logger } from '../core/logger.js';
import { resolveConfiguredContextSyncTarget } from '../cli/context-sync-target.js';
import { readContextMetadata } from './local-edge-metadata.js';
import {
  processPendingContextGrants,
  processPendingContextRevocations,
  pullContextEvents,
} from './local-edge-sync.js';

const log = logger.child({ module: 'context-auto-sync' });

export interface ContextAutoSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  pulled?: number;
  imported?: number;
  materializedGrants?: number;
  revocationsProcessed?: number;
  grantsEmitted?: number;
}

export async function refreshContextFromSavedTarget(options: {
  contextResourceId: string;
  workspaceId?: string;
  actorName?: string;
  home?: string;
}): Promise<ContextAutoSyncResult> {
  const home = options.home ?? configDir();
  let metadata: Awaited<ReturnType<typeof readContextMetadata>>;
  try {
    metadata = await readContextMetadata(options.contextResourceId, home);
  } catch (error) {
    logAutoSyncDebug(
      { err: error, contextResourceId: options.contextResourceId },
      'Skipped context auto-sync because this trusted edge has not joined the context',
    );
    return { ok: true, skipped: true, reason: 'context_not_joined' };
  }

  const daemonHome = configDir();
  const loadedConfig = await loadConfig(
    home === daemonHome ? process.env : { ...process.env, VPD_HOME: home },
  );
  const daemonConfig = loadedConfig.daemon ?? {};
  const target = resolveConfiguredContextSyncTarget(daemonConfig, {
    contextResourceId: options.contextResourceId,
    requestedWorkspaceId: options.workspaceId,
    decisionSigningKeys: daemonConfig.server?.contextCandidateDecisionKeys,
  });
  if (!target) {
    return { ok: true, skipped: true, reason: 'no_saved_workspace_target' };
  }

  const actorName = options.actorName ?? metadata.deviceName;
  const credentials = { passphrase: '', recoveryCode: '' };
  let pull: Awaited<ReturnType<typeof pullContextEvents>>;
  let revokes: Awaited<ReturnType<typeof processPendingContextRevocations>>;
  let grants: Awaited<ReturnType<typeof processPendingContextGrants>>;
  try {
    pull = await pullContextEvents({
      contextResourceId: options.contextResourceId,
      workspaceId: target.workspaceId,
      serverUrl: target.serverUrl,
      credential: target.credential,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
      actorName,
      credentials,
      trustedDecisionKeys: target.decisionSigningKeys,
      home,
    });
    revokes = await processPendingContextRevocations({
      contextResourceId: options.contextResourceId,
      workspaceId: target.workspaceId,
      serverUrl: target.serverUrl,
      credential: target.credential,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
      actorName,
      credentials,
      home,
    });
    grants = await processPendingContextGrants({
      contextResourceId: options.contextResourceId,
      workspaceId: target.workspaceId,
      serverUrl: target.serverUrl,
      credential: target.credential,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
      actorName,
      credentials,
      home,
    });
  } catch (error) {
    logAutoSyncDebug(
      { err: error, contextResourceId: options.contextResourceId, workspaceId: target.workspaceId },
      'Context auto-sync failed; falling back to local trusted-edge cache',
    );
    return {
      ok: false,
      skipped: true,
      reason: error instanceof Error ? error.message : 'context_auto_sync_failed',
    };
  }

  return {
    ok: true,
    pulled: pull.pulled,
    imported: pull.imported,
    materializedGrants: pull.materializedGrants,
    revocationsProcessed: revokes.revoked,
    grantsEmitted: grants.emitted,
  };
}

function logAutoSyncDebug(bindings: Record<string, unknown>, message: string): void {
  if (process.env.VIEWPORT_CONTEXT_AUTO_SYNC_DEBUG === '1') {
    log.debug(bindings, message);
  }
}
