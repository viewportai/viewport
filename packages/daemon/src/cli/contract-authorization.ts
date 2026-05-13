import { getFlag } from './args.js';
import { transportFetch } from './network.js';
import { resolveConfiguredWorkspaceSyncTarget } from './context-sync-target.js';
import { resolveLocalOrgBindingSync } from './org-binding.js';
import { ConfigManager } from '../core/config.js';
import type { SessionResourceManifest } from '../config-resolution/index.js';

export interface AuthorizationTarget {
  serverUrl: string;
  workspaceId: string;
  credential: string;
  tlsVerify?: 'auto' | '0' | '1';
  caCertPath?: string;
  tlsPins?: string[];
}

export interface AuthorizationResult {
  schema: string;
  manifest_digest?: string | null;
  providers?: Array<Record<string, unknown>>;
  resources?: Array<Record<string, unknown>>;
  summary?: {
    allowed?: number;
    denied?: number;
    local?: number;
    delegated?: number;
  };
}

export async function resolveAuthorizationTarget(): Promise<AuthorizationTarget> {
  const manager = new ConfigManager();
  await manager.load();
  const daemon = manager.getDaemonConfig() ?? {};
  const target = resolveConfiguredWorkspaceSyncTarget(daemon, {
    requestedWorkspaceId:
      getFlag('workspace') ??
      getFlag('resource') ??
      resolveLocalOrgBindingSync(process.cwd())?.organizationId,
    explicitServerUrl: getFlag('server-url'),
    explicitCredential: getFlag('credential'),
  });

  if (!target) {
    throw new Error(
      'vpd contract authorize requires an unambiguous remote workspace. Pass --workspace <id>, run from a bound repo, or keep exactly one saved remote workspace binding.',
    );
  }

  return {
    serverUrl: target.serverUrl,
    workspaceId: target.workspaceId,
    credential: target.credential,
    tlsVerify: target.tlsVerify,
    caCertPath: target.caCertPath,
    tlsPins: target.tlsPins,
  };
}

export async function requestAuthorization(
  target: AuthorizationTarget,
  manifest: SessionResourceManifest,
): Promise<AuthorizationResult> {
  const url = `${target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(
    target.workspaceId,
  )}/contract/authorize`;
  let res: Response;
  try {
    res = await transportFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credential: target.credential,
        resource_manifest: manifest,
      }),
      timeoutMs: 5_000,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Network error authorizing Viewport contract: ${message}`);
  }

  const payload = await readJson(res);
  if (!res.ok) {
    const reason = readString(payload?.['reason']) ?? readString(payload?.['message']);
    throw new Error(
      `Viewport contract authorization failed: HTTP ${res.status}${reason ? ` ${reason}` : ''}`,
    );
  }

  const data = payload?.['data'];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Viewport contract authorization response was missing data');
  }

  return data as AuthorizationResult;
}

export function printAuthorization(
  manifest: SessionResourceManifest,
  authorization: AuthorizationResult,
  workspaceId: string,
): void {
  const summary = authorization.summary ?? {};
  console.log('Viewport contract authorization');
  console.log(`Workspace:   ${workspaceId}`);
  console.log(`Digest:      ${manifest.manifestDigest}`);
  console.log(
    `Summary:     ${summary.allowed ?? 0} allowed, ${summary.denied ?? 0} denied, ${summary.local ?? 0} local, ${summary.delegated ?? 0} delegated`,
  );

  for (const provider of authorization.providers ?? []) {
    const id = readString(provider['id']) ?? '-';
    const kind = readString(provider['provider']) ?? 'provider';
    const status = readString(provider['status']) ?? 'unknown';
    const reason = readString(provider['reason']);
    console.log(`Provider:    ${id} (${kind}) ${status}${reason ? ` - ${reason}` : ''}`);
  }

  for (const resource of authorization.resources ?? []) {
    const type = readString(resource['resource_type']) ?? 'resource';
    const id = readString(resource['resource_ulid']) ?? '-';
    const source = readString(resource['source']) ?? 'manifest';
    const status = readString(resource['status']) ?? 'unknown';
    const reason = readString(resource['reason']);
    console.log(`Resource:    ${id} (${type}, ${source}) ${status}${reason ? ` - ${reason}` : ''}`);
  }
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await res.json()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
