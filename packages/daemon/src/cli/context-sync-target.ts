import { getFlag } from './args.js';
import { ConfigManager } from '../core/config.js';

export interface ContextSyncTarget {
  projectId: string;
  serverUrl: string;
  credential: string;
  decisionSigningKeys?: Record<string, string>;
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
  const decisionSigningKeys =
    parseDecisionSigningKeys(
      getFlag('context-decision-key') ??
        getFlag('decision-key') ??
        envValue('VIEWPORT_CONTEXT_DECISION_KEY'),
    ) ?? daemon.server?.contextCandidateDecisionKeys;

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

  return { projectId, serverUrl, credential, decisionSigningKeys };
}

function parseDecisionSigningKeys(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Context decision signing keys JSON must be an object');
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([kid, key]) =>
        typeof key === 'string' && key.length > 0 ? [[kid, key]] : [],
      ),
    );
  }

  const separator = trimmed.indexOf(':');
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error('Context decision signing key must use kid:base64-public-key format');
  }

  return {
    [trimmed.slice(0, separator)]: trimmed.slice(separator + 1),
  };
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
