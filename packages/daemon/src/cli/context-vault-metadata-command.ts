import { getFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';
import { transportFetch } from './network.js';
import { resolveConfiguredWorkspaceSyncTarget } from './context-sync-target.js';
import { resolveLocalOrgBindingSync } from './org-binding.js';
import { ConfigManager } from '../core/config.js';
import { initContextResource, type ContextKeyStore } from '../context/local-edge-store.js';
import { resolveContextKeyStore } from '../context/local-edge-key-store.js';
import { resolveSessionResourceManifestSync } from '../config-resolution/index.js';
import { useViewportVaultProvider } from '../config-resolution/config-writer.js';

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

type ContextVaultMetadataLocalInit = {
  contextResourceId: string;
  userName: string;
  deviceName: string;
  keyStore: ContextKeyStore;
};

type ContextVaultMetadataConfig = {
  config_path: string;
  changed: boolean;
  provider: {
    id: string;
    provider: 'viewport-vault';
    vault: string;
    required: boolean;
  };
  manifest_digest: string;
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
  const localContext = await maybeInitLocalContext(vault.vault_id);
  const config = await maybeAttachVaultToConfig(vault.vault_id);

  if (isJsonMode()) {
    printJson({
      schema_version: 'viewport.cli.context_create/v1',
      command: 'context create',
      ok: true,
      workspace_id: target.workspaceId,
      vault,
      ...(localContext ? { local_context: localContext } : {}),
      ...(config ? { config } : {}),
    });
    return;
  }

  console.log(`Context Vault created: ${vault.vault_id}`);
  console.log(`Name:        ${vault.name}`);
  console.log(`Privacy:     ${vault.encryption?.privacy ?? 'control_plane_blind'}`);
  console.log('Plaintext:   server never receives entry bodies');
  if (localContext) {
    console.log(`Local init:  ${localContext.contextResourceId}`);
  }
  if (config) {
    console.log(`Config:      ${config.config_path}`);
    console.log(`Manifest:    ${config.manifest_digest}`);
  }
}

async function maybeInitLocalContext(
  vaultId: string,
): Promise<ContextVaultMetadataLocalInit | null> {
  if (!hasFlagCompat('init')) return null;
  const record = await initContextResource({
    contextResourceId: vaultId,
    userName: requiredFlag('user', 'vpd context create --init requires --user <name>'),
    deviceName: requiredFlag('device', 'vpd context create --init requires --device <name>'),
    credentials: {
      passphrase: requiredFlag(
        'passphrase',
        'vpd context create --init requires --passphrase <text>',
      ),
      recoveryCode: requiredFlag(
        'recovery-code',
        'vpd context create --init requires --recovery-code <text>',
      ),
    },
    keyStore: parseKeyStore(getFlag('key-store')),
    home: getFlag('home'),
  });
  return {
    contextResourceId: record.contextResourceId,
    userName: record.userName,
    deviceName: record.deviceName,
    keyStore: record.keyStore,
  };
}

async function maybeAttachVaultToConfig(
  vaultId: string,
): Promise<ContextVaultMetadataConfig | null> {
  if (!hasFlagCompat('use')) return null;
  const workingDirectory = getFlag('path') ?? getFlag('cwd') ?? process.cwd();
  const result = await useViewportVaultProvider({
    workingDirectory,
    vaultId,
    providerId: getFlag('provider') ?? getFlag('id'),
    required: !hasFlagCompat('optional'),
  });
  const manifest = resolveSessionResourceManifestSync({ workingDirectory });
  return {
    config_path: result.configPath,
    changed: result.changed,
    provider: result.provider,
    manifest_digest: manifest.manifestDigest,
  };
}

async function resolveRuntimeContextVaultTarget(
  commandName: 'vaults' | 'create',
): Promise<RuntimeContextVaultTarget> {
  const manager = new ConfigManager();
  await manager.load();
  const daemon = manager.getDaemonConfig() ?? {};
  const target = resolveConfiguredWorkspaceSyncTarget(daemon, {
    requestedWorkspaceId:
      getFlag('workspace') ?? resolveLocalOrgBindingSync(process.cwd())?.organizationId,
    explicitServerUrl: getFlag('server-url'),
    explicitCredential: getFlag('credential'),
  });

  if (!target) {
    throw new Error(
      `vpd context ${commandName} requires an unambiguous remote workspace. Pass --workspace <id>, run from a bound repo, or keep exactly one saved remote workspace binding.`,
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

function parseKeyStore(raw: string | undefined): ContextKeyStore {
  return resolveContextKeyStore(raw);
}

function requiredFlag(name: string, message: string): string {
  const value = getFlag(name);
  if (!value || value.startsWith('--')) {
    throw new Error(message);
  }
  return value;
}

function hasFlagCompat(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
