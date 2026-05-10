import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { manifestRiskyPathRules, normalizeRiskyPathRules } from './approval-rules.js';
import { discoverViewportConfigPaths, discoverViewportConfigPathsSync } from './discovery.js';
import { ViewportConfigSchema, type ViewportConfigInput } from './schema.js';
import { digestJson } from './stable-json.js';
import YAML from 'yaml';
import {
  SESSION_RESOURCE_MANIFEST_SCHEMA,
  type ParsedViewportConfig,
  type SessionContextProviderManifest,
  type SessionResourceConflict,
  type SessionResourceManifest,
  type SessionResourceManifestResource,
  type SessionResourceWarning,
  type SessionWorkflowManifest,
  type ViewportContextProviderCapability,
  type ViewportContextProviderKind,
  type ViewportContextProviderPrivacy,
  type ViewportContextProviderRef,
  type ViewportContextResolution,
  type ViewportConfigDefaults,
  type ViewportResourceKind,
  type ViewportResourceRef,
  type ViewportWorkflowRef,
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
  const parsed = ViewportConfigSchema.parse(parseConfig(raw, absolutePath));
  return normalizeViewportConfig(absolutePath, raw, parsed);
}

export function parseViewportConfigSync(configPath: string): ParsedViewportConfig {
  const absolutePath = path.resolve(configPath);
  const raw = fsSync.readFileSync(absolutePath, 'utf8');
  const parsed = ViewportConfigSchema.parse(parseConfig(raw, absolutePath));
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
    for (const provider of config.contract.contextProviders) {
      if (provider.provider !== 'viewport-vault' || !provider.vault) continue;
      if (resources.contexts.some((existing) => existing.id === provider.vault)) continue;
      resources.contexts.push({
        id: provider.vault,
        required: provider.required,
        sourceConfigPath: provider.sourceConfigPath,
        resolution: 'requested_unverified',
      });
    }
    for (const workflow of config.contract.workflows) {
      if (resources.workflows.some((existing) => existing.id === workflow.id)) continue;
      resources.workflows.push({
        id: workflow.id,
        required: workflow.required,
        sourceConfigPath: workflow.sourceConfigPath,
        resolution: 'requested_unverified',
      });
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
    contract: {
      contextProviders: manifestContextProviders(input.configs),
      contextResolution: mergeContextResolution(input.configs),
      workflows: manifestWorkflows(input.configs),
      riskyPathRules: manifestRiskyPathRules(input.configs),
    },
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
    contract: {
      contextProviders: normalizeContextProviders(configPath, config.context?.providers ?? []),
      contextResolution: normalizeContextResolution(config.context?.resolution),
      workflows: normalizeWorkflowRefs(configPath, config.workflows ?? {}),
      riskyPathRules: normalizeRiskyPathRules(configPath, config.approvals),
    },
    defaults: config.defaults ?? {},
    scope: config.scope ?? {},
  };
}

function parseConfig(raw: string, configPath: string): unknown {
  if (configPath.endsWith('.json')) return JSON.parse(raw);
  return YAML.parse(raw);
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

function normalizeContextProviders(
  sourceConfigPath: string,
  providers: NonNullable<ViewportConfigInput['context']>['providers'],
): ViewportContextProviderRef[] {
  return (providers ?? []).map((provider) => {
    const kind = provider.provider as ViewportContextProviderKind;
    return {
      id: provider.id,
      provider: kind,
      required: provider.required ?? false,
      privacy: provider.privacy ?? defaultPrivacy(kind),
      capabilities: provider.capabilities?.length
        ? (provider.capabilities as ViewportContextProviderCapability[])
        : defaultCapabilities(kind),
      sourceConfigPath,
      ...(provider.credential_ref || provider.credentialRef
        ? { credentialRef: provider.credential_ref ?? provider.credentialRef }
        : {}),
      ...(provider.vault ? { vault: provider.vault } : {}),
      ...(provider.paths ? { paths: provider.paths } : {}),
      ...(provider.notebook ? { notebook: provider.notebook } : {}),
      ...(provider.command ? { command: provider.command } : {}),
    };
  });
}

function normalizeContextResolution(
  resolution: NonNullable<ViewportConfigInput['context']>['resolution'],
): ViewportContextResolution {
  if (!resolution) return {};
  const sizeBudget = resolution.size_budget ?? resolution.size_budget_bytes;
  const proposeFallbackProvider =
    resolution.propose_fallback_provider ?? resolution.proposeFallbackProvider;
  return {
    ...(resolution.order ? { order: resolution.order } : {}),
    ...(sizeBudget ? { sizeBudgetBytes: parseSizeBudget(sizeBudget) } : {}),
    ...(resolution.strategy ? { strategy: resolution.strategy } : {}),
    ...(proposeFallbackProvider ? { proposeFallbackProvider } : {}),
  };
}

function parseSizeBudget(value: number | string): number {
  if (typeof value === 'number') return value;
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d+)(b|kb|mb)?$/);
  if (!match) throw new Error(`Invalid context resolution size budget: ${value}`);
  const amount = Number.parseInt(match[1] ?? '0', 10);
  const unit = match[2] ?? 'b';
  const bytes = unit === 'mb' ? amount * 1024 * 1024 : unit === 'kb' ? amount * 1024 : amount;
  if (bytes < 1024 || bytes > 1_000_000) {
    throw new Error(`Context resolution size budget must be between 1024 and 1000000 bytes.`);
  }
  return bytes;
}

function normalizeWorkflowRefs(
  sourceConfigPath: string,
  workflows: NonNullable<ViewportConfigInput['workflows']>,
): ViewportWorkflowRef[] {
  return Object.entries(workflows).map(([id, workflow]) => {
    if (typeof workflow === 'string') {
      return {
        id,
        required: true,
        sourceConfigPath,
        path: workflow,
      };
    }
    return {
      id,
      required: workflow.required ?? true,
      sourceConfigPath,
      ...(workflow.path ? { path: workflow.path } : {}),
      ...(workflow.resource ? { resource: workflow.resource } : {}),
      ...(workflow.version ? { version: workflow.version } : {}),
      ...(workflow.digest ? { digest: workflow.digest } : {}),
    };
  });
}

function defaultPrivacy(kind: ViewportContextProviderKind): ViewportContextProviderPrivacy {
  if (kind === 'repo-docs') return 'local_only';
  if (kind === 'viewport-vault') return 'control_plane_blind';
  if (kind === 'custom-cli' || kind === 'custom-mcp') return 'unknown';
  return 'third_party_terms';
}

function defaultCapabilities(
  kind: ViewportContextProviderKind,
): ViewportContextProviderCapability[] {
  if (kind === 'repo-docs') return ['search', 'get'];
  if (kind === 'viewport-vault') return ['search', 'get', 'propose', 'write_approved'];
  if (kind === 'custom-cli' || kind === 'custom-mcp') return ['search'];
  return ['search', 'get'];
}

function manifestContextProviders(
  configs: ParsedViewportConfig[],
): SessionContextProviderManifest[] {
  const providers: SessionContextProviderManifest[] = [];
  for (const config of configs) {
    for (const provider of config.contract.contextProviders) {
      if (providers.some((existing) => existing.id === provider.id)) continue;
      providers.push({ ...provider, resolution: 'requested_unverified' });
    }
  }
  return providers;
}

function manifestWorkflows(configs: ParsedViewportConfig[]): SessionWorkflowManifest[] {
  const workflows: SessionWorkflowManifest[] = [];
  for (const config of configs) {
    for (const workflow of config.contract.workflows) {
      if (workflows.some((existing) => existing.id === workflow.id)) continue;
      workflows.push({ ...workflow, resolution: 'requested_unverified' });
    }
  }
  return workflows;
}

function mergeContextResolution(configs: ParsedViewportConfig[]): ViewportContextResolution {
  for (const config of configs) {
    if (Object.keys(config.contract.contextResolution).length > 0) {
      return config.contract.contextResolution;
    }
  }
  return {};
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
