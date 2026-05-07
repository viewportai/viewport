import { getFlag } from './args.js';
import { ConfigManager } from '../core/config.js';

export interface ContextSyncTarget {
  projectId: string;
  serverUrl: string;
  credential: string;
}

export async function resolveContextSyncTarget(
  commandName: 'sync-push' | 'sync-pull',
): Promise<ContextSyncTarget> {
  const manager = new ConfigManager();
  await manager.load();
  const daemon = manager.getDaemonConfig() ?? {};
  const relay = daemon.relay ?? {};

  const projectId = getFlag('project') ?? relay.workspaceId;
  const serverUrl = getFlag('server-url') ?? relay.serverUrl ?? daemon.server?.url;
  const credential = getFlag('credential') ?? relay.issueToken;

  if (!projectId) {
    throw new Error(
      `vpd context ${commandName} requires --project or a saved remote workspace from vpd remote login`,
    );
  }
  if (!serverUrl) {
    throw new Error(
      `vpd context ${commandName} requires --server-url or a saved remote server from vpd remote login`,
    );
  }
  if (!credential) {
    throw new Error(
      `vpd context ${commandName} requires --credential or a saved relay issue token from vpd remote login`,
    );
  }

  return { projectId, serverUrl, credential };
}
