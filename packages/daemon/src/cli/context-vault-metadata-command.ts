import { getFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import { transportFetch } from './network.js';
import { ConfigManager } from '../core/config.js';

type ContextVaultAccess = {
  role?: string | null;
  can_view?: boolean;
  can_review?: boolean;
  can_edit?: boolean;
  can_share?: boolean;
};

type ContextVaultMetadata = {
  id: string;
  vault_id: string;
  name: string;
  description?: string | null;
  workspace_id: string;
  encryption?: {
    protocol?: string;
    privacy?: string;
    server_plaintext?: boolean;
  };
  access?: ContextVaultAccess | null;
};

type RuntimeContextVaultTarget = {
  serverUrl: string;
  workspaceId: string;
  credential: string;
  tlsVerify?: 'auto' | '0' | '1';
  caCertPath?: string;
  tlsPins?: string[];
};

export async function contextVaultsList(): Promise<void> {
  const target = await resolveRuntimeContextVaultTarget('vaults');
  const vaults = await requestRuntimeContextVaults(target);

  if (isJsonMode()) {
    printJson({
      schema_version: 'viewport.cli.context_vaults/v1',
      command: 'context vaults',
      ok: true,
      workspace_id: target.workspaceId,
      vaults,
    });
    return;
  }

  if (vaults.length === 0) {
    console.log('No visible Context Vaults for this paired machine owner.');
    return;
  }
  for (const vault of vaults) {
    const role = vault.access?.role ? ` role=${vault.access.role}` : '';
    console.log(`${vault.vault_id}  ${vault.name}${role}`);
  }
}

export async function contextVaultCreate(): Promise<void> {
  const target = await resolveRuntimeContextVaultTarget('create');
  const name = getFlag('name');
  if (!name) {
    throw new Error('vpd context create requires --name <text>');
  }

  const vault = await requestRuntimeContextVaultCreate(target, {
    name,
    vault_id: getFlag('vault') ?? getFlag('vault-id') ?? undefined,
    description: getFlag('description') ?? undefined,
  });

  if (isJsonMode()) {
    printJson({
      schema_version: 'viewport.cli.context_create/v1',
      command: 'context create',
      ok: true,
      workspace_id: target.workspaceId,
      vault,
    });
    return;
  }

  console.log(`Context Vault created: ${vault.vault_id}`);
  console.log(`Name:        ${vault.name}`);
  console.log(`Privacy:     ${vault.encryption?.privacy ?? 'control_plane_blind'}`);
  console.log('Plaintext:   server never receives entry bodies');
}

async function resolveRuntimeContextVaultTarget(
  commandName: 'vaults' | 'create',
): Promise<RuntimeContextVaultTarget> {
  const manager = new ConfigManager();
  await manager.load();
  const daemon = manager.getDaemonConfig() ?? {};
  const relay = daemon.relay ?? {};
  const server = daemon.server ?? {};

  const serverUrl = getFlag('server-url') ?? relay.serverUrl ?? server.url;
  const workspaceId = getFlag('workspace') ?? relay.workspaceId;
  const credential = getFlag('credential') ?? relay.issueToken;

  if (!serverUrl) {
    throw new Error(
      `vpd context ${commandName} requires --server-url or a saved remote server from vpd remote login`,
    );
  }
  if (!workspaceId) {
    throw new Error(
      `vpd context ${commandName} requires --workspace <id> or a saved remote workspace from vpd remote login`,
    );
  }
  if (!credential) {
    throw new Error(
      `vpd context ${commandName} requires --credential or a saved relay issue token from vpd remote login`,
    );
  }

  return {
    serverUrl,
    workspaceId,
    credential,
    tlsVerify: server.tlsVerify ?? relay.tlsVerify,
    caCertPath: server.caCertPath ?? relay.caCertPath,
    tlsPins: server.tlsPins ?? relay.tlsPins,
  };
}

async function requestRuntimeContextVaults(
  target: RuntimeContextVaultTarget,
): Promise<ContextVaultMetadata[]> {
  const query = new URLSearchParams({ credential: target.credential });
  const payload = await requestJson(
    target,
    `${runtimeContextVaultsUrl(target)}?${query.toString()}`,
    { method: 'GET' },
  );
  return readVaultList(payload);
}

async function requestRuntimeContextVaultCreate(
  target: RuntimeContextVaultTarget,
  input: { name: string; vault_id?: string; description?: string },
): Promise<ContextVaultMetadata> {
  const payload = await requestJson(target, runtimeContextVaultsUrl(target), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      credential: target.credential,
      ...input,
    }),
  });
  return readVault(payload?.['data']);
}

async function requestJson(
  target: RuntimeContextVaultTarget,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown> | null> {
  let response: Response;
  try {
    response = await transportFetch(url, {
      ...init,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
      timeoutMs: 5_000,
      tlsVerify: target.tlsVerify,
      caCertPath: target.caCertPath,
      tlsPins: target.tlsPins,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Network error contacting Viewport Context Vaults: ${message}`);
  }

  const payload = await readJson(response);
  if (!response.ok) {
    const reason = readString(payload?.['reason']) ?? readString(payload?.['message']);
    throw new Error(
      `Context Vault request failed: HTTP ${response.status}${reason ? ` ${reason}` : ''}`,
    );
  }
  return payload;
}

function runtimeContextVaultsUrl(target: RuntimeContextVaultTarget): string {
  return `${target.serverUrl.replace(/\/+$/, '')}/api/runtime/workspaces/${encodeURIComponent(
    target.workspaceId,
  )}/context-vaults`;
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readVaultList(payload: Record<string, unknown> | null): ContextVaultMetadata[] {
  const data = payload?.['data'];
  if (!Array.isArray(data)) {
    throw new Error('Context Vault list response was missing data');
  }
  return data.map(readVault);
}

function readVault(value: unknown): ContextVaultMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Context Vault response item was not an object');
  }
  const record = value as Record<string, unknown>;
  const id = readRequiredString(record['id'], 'id');
  const vaultId = readRequiredString(record['vault_id'], 'vault_id');
  const name = readRequiredString(record['name'], 'name');
  const workspaceId = readRequiredString(record['workspace_id'], 'workspace_id');

  return {
    id,
    vault_id: vaultId,
    name,
    workspace_id: workspaceId,
    description: readString(record['description']),
    encryption: readRecord(record['encryption']) as ContextVaultMetadata['encryption'],
    access: readRecord(record['access']) as ContextVaultAccess | null,
  };
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`Context Vault response item was missing ${field}`);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
