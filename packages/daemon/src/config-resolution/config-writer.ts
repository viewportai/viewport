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
  useWhen?: string | null;
  updateWhen?: string | null;
}

export interface UseViewportVaultResult {
  configPath: string;
  changed: boolean;
  provider: {
    id: string;
    provider: 'viewport-vault';
    vault: string;
    required: boolean;
    use_when?: string;
    update_when?: string;
  };
}

export interface UseGitHubContextOptions {
  workingDirectory: string;
  repo: string;
  remote?: string;
  ref?: string;
  branch?: string;
  providerId?: string;
  required?: boolean;
  paths?: string[];
  useWhen?: string | null;
  updateWhen?: string | null;
}

export interface UseGitHubContextResult {
  configPath: string;
  changed: boolean;
  provider: {
    id: string;
    provider: 'github-repo';
    repo: string;
    remote?: string;
    ref: string;
    branch: string;
    paths: string[];
    required: boolean;
    use_when?: string;
    update_when?: string;
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
    ...(normalizeGuidance(options.useWhen) ? { use_when: normalizeGuidance(options.useWhen) } : {}),
    ...(normalizeGuidance(options.updateWhen)
      ? { update_when: normalizeGuidance(options.updateWhen) }
      : {}),
  };

  if (existingIndex >= 0) {
    const current = providers[existingIndex];
    if (current?.provider !== 'viewport-vault' || current.vault !== options.vaultId) {
      throw new Error(
        `Provider id "${providerId}" already exists for a different context provider.`,
      );
    }
    const next = {
      ...current,
      required,
      ...(provider.use_when ? { use_when: provider.use_when } : {}),
      ...(provider.update_when ? { update_when: provider.update_when } : {}),
    };
    const changed =
      current.required !== required ||
      current.use_when !== next.use_when ||
      current.update_when !== next.update_when;
    providers[existingIndex] = next;
    if (changed) {
      await writeConfig(configPath, { ...existing, context: { ...existing.context, providers } });
    }
    return { configPath, changed, provider };
  }

  providers.push(provider);
  await writeConfig(configPath, { ...existing, context: { ...existing.context, providers } });
  return { configPath, changed: true, provider };
}

export async function useGitHubContextProvider(
  options: UseGitHubContextOptions,
): Promise<UseGitHubContextResult> {
  const workingDirectory = path.resolve(options.workingDirectory);
  const configPath = await nearestYamlConfigPath(workingDirectory);
  const existing = await readExistingConfig(configPath);
  const providerId = options.providerId ?? nextGenericProviderId(existing, options.repo);
  const required = options.required ?? true;
  const providers = [...(existing.context?.providers ?? [])];
  const existingIndex = providers.findIndex((provider) => provider.id === providerId);
  const provider = {
    id: providerId,
    provider: 'github-repo' as const,
    repo: options.repo,
    ...(options.remote ? { remote: options.remote } : {}),
    ref: options.ref ?? 'main',
    branch: options.branch ?? 'main',
    paths: options.paths?.length ? options.paths : ['context/**/*.md', '**/*.md'],
    required,
    ...(normalizeGuidance(options.useWhen) ? { use_when: normalizeGuidance(options.useWhen) } : {}),
    ...(normalizeGuidance(options.updateWhen)
      ? { update_when: normalizeGuidance(options.updateWhen) }
      : {}),
  };

  if (existingIndex >= 0) {
    const current = providers[existingIndex];
    if (current?.provider !== 'github-repo') {
      throw new Error(
        `Provider id "${providerId}" already exists for a different context provider.`,
      );
    }
    const next = { ...current, ...provider };
    const changed = JSON.stringify(current) !== JSON.stringify(next);
    providers[existingIndex] = next;
    if (changed) {
      await writeConfig(configPath, { ...existing, context: { ...existing.context, providers } });
    }
    return { configPath, changed, provider };
  }

  providers.push(provider);
  await writeConfig(configPath, { ...existing, context: { ...existing.context, providers } });
  return { configPath, changed: true, provider };
}

function normalizeGuidance(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
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

function nextGenericProviderId(config: ViewportConfigInput, value: string): string {
  const existing = config.context?.providers ?? [];
  const base = sanitizeProviderId(value.split('/').filter(Boolean).slice(-1)[0] ?? value);
  if (!existing.some((provider) => provider.id === base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.some((provider) => provider.id === candidate)) return candidate;
  }
  throw new Error(`Could not choose a provider id for "${value}".`);
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
