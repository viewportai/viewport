import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { VIEWPORT_CONFIG_FILE } from './types.js';
import { ViewportConfigSchema, type ViewportConfigInput } from './schema.js';

export interface UseViewportVaultOptions {
  workingDirectory: string;
  vaultId: string;
  providerId?: string;
  required?: boolean;
}

export interface UseViewportVaultResult {
  configPath: string;
  changed: boolean;
  provider: {
    id: string;
    provider: 'viewport-vault';
    vault: string;
    required: boolean;
  };
}

export async function useViewportVaultProvider(
  options: UseViewportVaultOptions,
): Promise<UseViewportVaultResult> {
  const workingDirectory = path.resolve(options.workingDirectory);
  const configPath = await nearestYamlConfigPath(workingDirectory);
  const existing = await readExistingConfig(configPath);
  const providerId = options.providerId ?? nextProviderId(existing, options.vaultId);
  const required = options.required ?? true;
  const providers = [...(existing.context?.providers ?? [])];
  const existingIndex = providers.findIndex((provider) => provider.id === providerId);
  const provider = {
    id: providerId,
    provider: 'viewport-vault' as const,
    vault: options.vaultId,
    required,
  };

  if (existingIndex >= 0) {
    const current = providers[existingIndex];
    if (current?.provider !== 'viewport-vault' || current.vault !== options.vaultId) {
      throw new Error(
        `Provider id "${providerId}" already exists for a different context provider.`,
      );
    }
    const changed = current.required !== required;
    providers[existingIndex] = { ...current, required };
    if (changed) {
      await writeConfig(configPath, { ...existing, context: { ...existing.context, providers } });
    }
    return { configPath, changed, provider };
  }

  providers.push(provider);
  await writeConfig(configPath, { ...existing, context: { ...existing.context, providers } });
  return { configPath, changed: true, provider };
}

async function nearestYamlConfigPath(workingDirectory: string): Promise<string> {
  let current = workingDirectory;
  for (;;) {
    const candidate = path.join(current, VIEWPORT_CONFIG_FILE);
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) {
      return path.join(workingDirectory, VIEWPORT_CONFIG_FILE);
    }
    current = parent;
  }
}

async function readExistingConfig(configPath: string): Promise<ViewportConfigInput> {
  if (!(await exists(configPath))) {
    return { version: 1 };
  }
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed = YAML.parse(raw) as unknown;
  return ViewportConfigSchema.parse(parsed);
}

async function writeConfig(configPath: string, config: ViewportConfigInput): Promise<void> {
  const parsed = ViewportConfigSchema.parse(config);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, YAML.stringify(parsed), 'utf8');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function nextProviderId(config: ViewportConfigInput, vaultId: string): string {
  const existing = config.context?.providers ?? [];
  const base = sanitizeProviderId(vaultId);
  if (!existing.some((provider) => provider.id === base)) return base;
  const matching = existing.find(
    (provider) =>
      provider.id === base && provider.provider === 'viewport-vault' && provider.vault === vaultId,
  );
  if (matching) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.some((provider) => provider.id === candidate)) return candidate;
  }
  throw new Error(`Could not choose a provider id for vault "${vaultId}".`);
}

function sanitizeProviderId(value: string): string {
  const slug = value
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
  if (!slug) {
    throw new Error('Context vault id must contain at least one identifier character.');
  }
  return slug;
}
