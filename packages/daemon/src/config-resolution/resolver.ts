import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { discoverViewportConfigPaths, discoverViewportConfigPathsSync } from './discovery.js';
import { ViewportConfigSchema, type ViewportConfigInput } from './schema.js';
import {
  SESSION_RESOURCE_MANIFEST_SCHEMA,
  type ParsedViewportConfig,
  type SessionResourceConflict,
  type SessionResourceManifest,
  type SessionResourceManifestResource,
  type SessionResourceWarning,
  type ViewportConfigDefaults,
  type ViewportResourceKind,
  type ViewportResourceRef,
} from './types.js';

const RESOURCE_KINDS: ViewportResourceKind[] = ['contexts', 'workflows', 'plans', 'agentProfiles'];
const CONFLICT_FIELDS: Array<keyof ViewportConfigDefaults> = [
  'inboxRoute',
  'visibility',
  'contextCandidateReview',
];

export interface ResolveViewportConfigOptions {
  workingDirectory: string;
  explicitConfigPaths?: string[];
  maxChildConfigs?: number;
}

export async function resolveSessionResourceManifest(
  options: ResolveViewportConfigOptions,
): Promise<SessionResourceManifest> {
  const workingDirectory = path.resolve(options.workingDirectory);
  const discovery = await discoverViewportConfigPaths({
    workingDirectory,
    explicitConfigPaths: options.explicitConfigPaths,
    maxChildConfigs: options.maxChildConfigs,
  });

  const parsedConfigs: ParsedViewportConfig[] = [];
  const warnings = [...discovery.warnings];
  for (const configPath of discovery.configPaths) {
    try {
      parsedConfigs.push(await parseViewportConfig(configPath));
    } catch (error) {
      warnings.push({
        code: 'invalid_config_skipped',
        path: configPath,
        message: error instanceof Error ? error.message : `Invalid Viewport config: ${configPath}`,
      });
    }
  }

  return buildSessionResourceManifest({
    workingDirectory,
    configs: parsedConfigs,
    warnings,
  });
}

export function resolveSessionResourceManifestSync(
  options: ResolveViewportConfigOptions,
): SessionResourceManifest {
  const workingDirectory = path.resolve(options.workingDirectory);
  const discovery = discoverViewportConfigPathsSync({
    workingDirectory,
    explicitConfigPaths: options.explicitConfigPaths,
    maxChildConfigs: options.maxChildConfigs,
  });

  const parsedConfigs: ParsedViewportConfig[] = [];
  const warnings = [...discovery.warnings];
  for (const configPath of discovery.configPaths) {
    try {
      parsedConfigs.push(parseViewportConfigSync(configPath));
    } catch (error) {
      warnings.push({
        code: 'invalid_config_skipped',
        path: configPath,
        message: error instanceof Error ? error.message : `Invalid Viewport config: ${configPath}`,
      });
    }
  }

  return buildSessionResourceManifest({
    workingDirectory,
    configs: parsedConfigs,
    warnings,
  });
}

export async function parseViewportConfig(configPath: string): Promise<ParsedViewportConfig> {
  const absolutePath = path.resolve(configPath);
  const raw = await fs.readFile(absolutePath, 'utf8');
  const parsed = ViewportConfigSchema.parse(JSON.parse(raw));
  return normalizeViewportConfig(absolutePath, raw, parsed);
}

export function parseViewportConfigSync(configPath: string): ParsedViewportConfig {
  const absolutePath = path.resolve(configPath);
  const raw = fsSync.readFileSync(absolutePath, 'utf8');
  const parsed = ViewportConfigSchema.parse(JSON.parse(raw));
  return normalizeViewportConfig(absolutePath, raw, parsed);
}

export function buildSessionResourceManifest(input: {
  workingDirectory: string;
  configs: ParsedViewportConfig[];
  warnings?: SessionResourceWarning[];
}): SessionResourceManifest {
  const resources = emptyManifestResources();
  for (const config of input.configs) {
    for (const kind of RESOURCE_KINDS) {
      for (const ref of config.resources[kind]) {
        if (resources[kind].some((existing) => existing.id === ref.id)) continue;
        resources[kind].push({
          id: ref.id,
          required: ref.required,
          sourceConfigPath: ref.sourceConfigPath,
          resolution: 'requested_unverified',
        });
      }
    }
  }

  const manifestWithoutDigest = {
    schema: SESSION_RESOURCE_MANIFEST_SCHEMA as typeof SESSION_RESOURCE_MANIFEST_SCHEMA,
    workingDirectory: path.resolve(input.workingDirectory),
    configSources: input.configs.map((config) => ({
      path: config.path,
      digest: config.digest,
      version: config.version,
      ...(config.name ? { name: config.name } : {}),
    })),
    resources,
    conflicts: detectConflicts(input.configs),
    warnings: input.warnings ?? [],
  };

  return {
    ...manifestWithoutDigest,
    manifestDigest: digestJson(manifestWithoutDigest),
  };
}

function normalizeViewportConfig(
  configPath: string,
  raw: string,
  config: ViewportConfigInput,
): ParsedViewportConfig {
  const resources = Object.fromEntries(
    RESOURCE_KINDS.map((kind) => [
      kind,
      (config.resources?.[kind] ?? []).map((ref) => normalizeResourceRef(configPath, ref)),
    ]),
  ) as Record<ViewportResourceKind, ViewportResourceRef[]>;

  return {
    path: configPath,
    digest: `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`,
    version: config.version,
    ...(config.name ? { name: config.name } : {}),
    resources,
    defaults: config.defaults ?? {},
    scope: config.scope ?? {},
  };
}

function normalizeResourceRef(
  sourceConfigPath: string,
  ref: string | { id: string; required?: boolean },
): ViewportResourceRef {
  if (typeof ref === 'string') {
    return { id: ref, required: false, sourceConfigPath };
  }
  return { id: ref.id, required: ref.required ?? false, sourceConfigPath };
}

function detectConflicts(configs: ParsedViewportConfig[]): SessionResourceConflict[] {
  const conflicts: SessionResourceConflict[] = [];
  for (const field of CONFLICT_FIELDS) {
    const values = new Map<string, string[]>();
    for (const config of configs) {
      const value = config.defaults[field];
      if (!value) continue;
      const paths = values.get(value) ?? [];
      paths.push(config.path);
      values.set(value, paths);
    }
    if (values.size <= 1) continue;
    conflicts.push({
      field: `defaults.${field}`,
      values: [...values.entries()].flatMap(([value, sourcePaths]) =>
        sourcePaths.map((sourceConfigPath) => ({ value, sourceConfigPath })),
      ),
      resolution: 'requires_user_selection',
    });
  }
  return conflicts;
}

function emptyManifestResources(): Record<ViewportResourceKind, SessionResourceManifestResource[]> {
  return {
    contexts: [],
    workflows: [],
    plans: [],
    agentProfiles: [],
  };
}

function digestJson(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
