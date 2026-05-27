/**
 * Layered configuration system for the Viewport daemon.
 *
 * Resolution order (later wins):
 *   built-in defaults → global config → directory overrides → session overrides
 *
 * Config file: ~/.viewport/config.json
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { SessionConfig } from './types.js';
import type { AgentRegistry } from './agent-registry.js';
import { ViewportConfigSchema } from './config-schema.js';
import type { RuntimeLaunchConfig } from '../cli/supervisor-protocol.js';
import { validateRelayRuntimeSecurity } from '../startup-relay-security.js';
import { resolveProfileAwareViewportHome } from './profiles.js';

// ---------------------------------------------------------------------------
// Built-in defaults — AGENT-AGNOSTIC framework defaults only.
//
// Tool names and permission lists come from AgentDefinition.defaults,
// NOT from here. This keeps the core free of agent-specific knowledge.
// ---------------------------------------------------------------------------

export const BUILT_IN_DEFAULTS: SessionConfig = {
  agent: 'claude',
  model: undefined,
  gitTracker: {
    enabled: true,
    commitOn: [], // Populated from agent definition
    ignore: ['.env', '.env.*', 'node_modules/**', 'dist/**', '.viewport/**'],
    autoSquashOnComplete: false,
    branchPrefix: 'viewport/session-',
    commitAuthor: 'Viewport Agent <noreply@example.test>',
    maxCommitsPerSession: 500,
    worktreeRoot: '.viewport/worktrees',
  },
  permissions: {
    autoApprove: [], // Populated from agent definition
    requireApproval: [], // Populated from agent definition
    deny: [],
  },
  executionMode: undefined,
  allowedTools: undefined,
  costCapUsd: undefined,
  trust: 'operator',
};

// ---------------------------------------------------------------------------
// Deep merge utility
// ---------------------------------------------------------------------------

/**
 * Deep merge objects. Arrays are replaced (not concatenated).
 * `undefined` values in source are skipped (don't overwrite with undefined).
 */
export function deepMerge<T>(...sources: Array<Partial<T> | undefined>): T {
  const result: Record<string, unknown> = {};

  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      if (isUnsafeMergeKey(key)) continue;
      if (value === undefined) continue;
      const existing = result[key];
      if (isPlainObject(existing) && isPlainObject(value)) {
        result[key] = deepMerge(existing, value);
      } else {
        result[key] = value;
      }
    }
  }

  return result as T;
}

function mergeWithDeletes<T>(base: T, update: Partial<T> | undefined): T {
  if (update === undefined) {
    return base;
  }

  const initial = isPlainObject(base) ? { ...base } : {};
  const result = initial as Record<string, unknown>;

  for (const [key, value] of Object.entries(update as Record<string, unknown>)) {
    if (isUnsafeMergeKey(key)) continue;
    if (value === undefined) {
      delete result[key];
      continue;
    }

    const existing = result[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = mergeWithDeletes(existing, value);
      continue;
    }

    result[key] = value;
  }

  return result as T;
}

function toRuntimeConfigForDaemonValidation(
  daemonConfig: NonNullable<ViewportConfig['daemon']>,
): RuntimeLaunchConfig {
  const relay = daemonConfig.relay ?? {};
  return {
    listen: daemonConfig.listen ?? '127.0.0.1:7070',
    host: '127.0.0.1',
    port: 7070,
    version: 'config-manager',
    profile: daemonConfig.profile ?? 'local',
    authEnabled: daemonConfig.authEnabled ?? true,
    detached: false,
    serverUrl: daemonConfig.server?.url,
    serverTlsVerify: daemonConfig.server?.tlsVerify ?? 'auto',
    serverCaCertPath: daemonConfig.server?.caCertPath,
    serverTlsPins: daemonConfig.server?.tlsPins,
    relayEnabled: relay.enabled ?? false,
    relayEndpoint: relay.endpoint,
    relayServerUrl: relay.serverUrl,
    relayWorkspaceId: relay.workspaceId,
    relayIssueToken: relay.issueToken,
    relayTlsVerify: relay.tlsVerify ?? 'auto',
    relayCaCertPath: relay.caCertPath,
    relayTlsPins: relay.tlsPins,
    relayTokenIssuer: relay.tokenIssuer,
    relayTokenAudience: relay.tokenAudience,
    relayTokenJwksUrl:
      relay.tokenJwksUrl ??
      (relay.serverUrl
        ? `${relay.serverUrl.replace(/\/+$/, '')}/api/.well-known/jwks.json`
        : undefined),
    relayTokenSigningKeys: relay.signingKeys,
    relayTokenClockSkewSec: relay.tokenClockSkewSec,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isUnsafeMergeKey(key: string): boolean {
  return key === '__proto__' || key === 'prototype' || key === 'constructor';
}

// ---------------------------------------------------------------------------
// Config file I/O
// ---------------------------------------------------------------------------

export interface ViewportConfig {
  /** Global defaults applied to all directories. */
  defaults?: Partial<SessionConfig>;
  /** Per-directory config overrides. Keyed by directory ID. */
  directories?: Record<string, { path: string; config?: Partial<SessionConfig> }>;
  /** Machine ID. */
  machineId?: string;
  /** Daemon runtime defaults (listen/profile/security/lifecycle options). */
  daemon?: {
    listen?: string;
    profile?: 'local' | 'lan' | 'relay';
    allowedHosts?: string[] | true;
    allowedOrigins?: string[] | true;
    authEnabled?: boolean;
    logFile?: string;
    server?: {
      url?: string;
      appUrl?: string;
      tlsVerify?: 'auto' | '0' | '1';
      caCertPath?: string;
      tlsPins?: string[];
      contextCandidateDecisionKeys?: Record<string, string>;
    };
    relay?: {
      enabled?: boolean;
      bindings?: Array<{
        enabled?: boolean;
        endpoint?: string;
        serverUrl?: string;
        workspaceId?: string;
        installId?: string;
        runtimeTargetId?: string;
        machineId?: string;
        machineName?: string;
        issueToken?: string;
        tlsVerify?: 'auto' | '0' | '1';
        caCertPath?: string;
        tlsPins?: string[];
        tokenIssuer?: string;
        tokenAudience?: string;
        tokenJwksUrl?: string;
        signingKeys?: Record<string, string>;
        tokenClockSkewSec?: number;
      }>;
      endpoint?: string;
      serverUrl?: string;
      workspaceId?: string;
      installId?: string;
      runtimeTargetId?: string;
      machineId?: string;
      machineName?: string;
      issueToken?: string;
      tlsVerify?: 'auto' | '0' | '1';
      caCertPath?: string;
      tlsPins?: string[];
      tokenIssuer?: string;
      tokenAudience?: string;
      tokenJwksUrl?: string;
      signingKeys?: Record<string, string>;
      tokenClockSkewSec?: number;
    };
    worker?: {
      lifecycle?: 'persistent' | 'ephemeral';
      transport?: 'polling' | 'relay' | 'inbound';
      serverUrl?: string;
      appUrl?: string;
      workspaceId?: string;
      managedExecutorId?: string;
      credential?: string;
      workspaceRoot?: string;
      logsDir?: string;
      cacheDir?: string;
      stateDir?: string;
      identityKeyPath?: string;
      publicKeyFingerprint?: string;
      capabilities?: {
        agents?: Array<{
          id: string;
          displayName?: string;
          tier?: 'sdk' | 'pty';
          available: boolean;
        }>;
      };
    };
  };
}

export function resolveViewportHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolveProfileAwareViewportHome(env);
}

/** Returns the path to the Viewport config directory. */
export function configDir(): string {
  return resolveViewportHome();
}

/** Returns the path to the Viewport config file. */
export function configFilePath(): string {
  return path.join(configDir(), 'config.json');
}

export interface ResourceOverrideConfigResolution {
  dir: string | null;
  source: 'explicit' | null;
}

export function resolveResourceOverrideConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResourceOverrideConfigResolution {
  const explicit = env['VIEWPORT_RESOURCE_OVERRIDE_DIR'] ?? env['VPD_RESOURCE_OVERRIDE_DIR'];
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    const resolved = path.resolve(explicit.trim());
    try {
      const configPath = path.join(resolved, 'config.json');
      if (
        fsSync.statSync(resolved).isDirectory() &&
        fsSync.statSync(configPath).isFile() &&
        isDaemonConfigFile(configPath)
      ) {
        return { dir: resolved, source: 'explicit' };
      }
    } catch {
      // Ignore explicit resource override directories that do not contain a config file.
    }
  }

  return { dir: null, source: null };
}

function isDaemonConfigFile(configPath: string): boolean {
  try {
    const raw = fsSync.readFileSync(configPath, 'utf8');
    return hasDaemonConfigShape(JSON.parse(raw));
  } catch {
    // Keep malformed daemon override behavior actionable: if the file is not
    // parseable, let loadConfigFromPath surface the exact JSON/schema error.
    return true;
  }
}

function hasDaemonConfigShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (hasRepoResourceConfigShape(value)) return false;

  return Boolean(
    value['daemon'] ||
    value['directories'] ||
    value['machineId'] ||
    hasSessionDefaultsShape(value['defaults']),
  );
}

function hasRepoResourceConfigShape(value: Record<string, unknown>): boolean {
  if (value['resources'] || value['scope'] || value['$schema']) return true;

  const defaults = value['defaults'];
  if (!isPlainObject(defaults)) return false;
  return Boolean(
    defaults['inboxRoute'] || defaults['visibility'] || defaults['contextCandidateReview'],
  );
}

function hasSessionDefaultsShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return Boolean(
    value['agent'] ||
    value['model'] ||
    value['sandboxMode'] ||
    value['approvalPolicy'] ||
    value['executionMode'] ||
    value['allowedTools'] ||
    value['gitTracker'] ||
    value['permissions'] ||
    value['costCapUsd'] ||
    value['trust'],
  );
}

export function resolveResourceOverrideConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return resolveResourceOverrideConfig(env).dir;
}

export function resourceOverrideConfigFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const dir = resolveResourceOverrideConfigDir(env);
  return dir ? path.join(dir, 'config.json') : null;
}

function migrateViewportConfig(raw: unknown): { config: unknown; migrated: boolean } {
  if (!isPlainObject(raw)) {
    return { config: raw, migrated: false };
  }

  let migrated = false;
  const daemon = raw['daemon'];
  if (isPlainObject(daemon)) {
    const relay = daemon['relay'];
    if (isPlainObject(relay)) {
      if ('enrollToken' in relay) {
        delete relay['enrollToken'];
        migrated = true;
      }
      if ('projectMachineBindingId' in relay) {
        if (!('runtimeTargetId' in relay) && typeof relay['projectMachineBindingId'] === 'string') {
          relay['runtimeTargetId'] = relay['projectMachineBindingId'];
        }
        delete relay['projectMachineBindingId'];
        migrated = true;
      }
    }
  }

  return { config: raw, migrated };
}

/** Load the config file, returning empty config if it doesn't exist. */
async function loadConfigFromPath(filePath: string): Promise<ViewportConfig> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Invalid viewport config JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const migrated = migrateViewportConfig(parsedRaw);
    const parsed = ViewportConfigSchema.safeParse(migrated.config);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Invalid viewport config schema at ${filePath}: ${detail}`);
    }

    if (migrated.migrated) {
      await saveConfigToPath(filePath, parsed.data as ViewportConfig);
    }

    return parsed.data as ViewportConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return {};
    }
    if (err instanceof Error) {
      throw err;
    }
    return {};
  }
}

/** Load only the global config file, returning empty config if it doesn't exist. */
export async function loadGlobalConfig(): Promise<ViewportConfig> {
  return loadConfigFromPath(configFilePath());
}

/** Load the effective daemon config (global plus optional resource override). */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ViewportConfig> {
  const globalConfig = await loadGlobalConfig();
  const overridePath = resourceOverrideConfigFilePath(env);
  if (!overridePath) {
    return globalConfig;
  }
  const resourceOverride = await loadConfigFromPath(overridePath);
  return deepMerge(globalConfig, resourceOverride);
}

/** Save the config file, creating the directory if needed. */
export async function saveConfig(config: ViewportConfig): Promise<void> {
  await saveConfigToPath(configFilePath(), config);
}

async function saveConfigToPath(filePath: string, config: ViewportConfig): Promise<void> {
  const targetDir = path.dirname(filePath);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  await fs.chmod(filePath, 0o600);
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the full SessionConfig for a directory, with optional session overrides.
 *
 * Resolution: builtInDefaults ← agentDefaults ← globalDefaults ← directoryConfig ← sessionOverrides
 *
 * Agent defaults inject agent-specific tool names and permissions without
 * polluting the framework-level built-in defaults.
 */
export function resolveConfig(
  agentDefaults?: Partial<SessionConfig>,
  globalDefaults?: Partial<SessionConfig>,
  directoryConfig?: Partial<SessionConfig>,
  sessionOverrides?: Partial<SessionConfig>,
): SessionConfig {
  return deepMerge<SessionConfig>(
    BUILT_IN_DEFAULTS,
    agentDefaults,
    globalDefaults,
    directoryConfig,
    sessionOverrides,
  );
}

// ---------------------------------------------------------------------------
// Config manager (stateful, owns the loaded config)
// ---------------------------------------------------------------------------

export class ConfigManager {
  private config: ViewportConfig = {};
  private globalConfig: ViewportConfig = {};
  private resourceOverrideConfig: ViewportConfig | null = null;
  private resourceOverridePath: string | null = null;
  private loaded = false;
  private agentRegistry: AgentRegistry | null = null;

  /** Load config from disk. Safe to call multiple times. */
  async load(): Promise<void> {
    this.globalConfig = await loadGlobalConfig();
    this.resourceOverridePath = resourceOverrideConfigFilePath();
    this.resourceOverrideConfig = this.resourceOverridePath
      ? await loadConfigFromPath(this.resourceOverridePath)
      : null;
    this.config = deepMerge(this.globalConfig, this.resourceOverrideConfig ?? {});
    this.loaded = true;
  }

  /** Set the agent registry for agent-aware config resolution. */
  setAgentRegistry(registry: AgentRegistry): void {
    this.agentRegistry = registry;
  }

  /** Get the raw viewport config. */
  getConfig(): ViewportConfig {
    this.ensureLoaded();
    return this.config;
  }

  getConfigPaths(): { globalPath: string; resourceOverridePath: string | null } {
    this.ensureLoaded();
    return {
      globalPath: configFilePath(),
      resourceOverridePath: this.resourceOverridePath,
    };
  }

  /** Resolve a full SessionConfig for a directory, with agent-specific defaults. */
  resolveSessionConfig(
    directoryId?: string,
    sessionOverrides?: Partial<SessionConfig>,
  ): SessionConfig {
    this.ensureLoaded();

    const directoryConfig = directoryId
      ? this.config.directories?.[directoryId]?.config
      : undefined;

    // Determine which agent this config is for
    const agentId =
      sessionOverrides?.agent ??
      directoryConfig?.agent ??
      this.config.defaults?.agent ??
      BUILT_IN_DEFAULTS.agent;

    // Get agent-specific defaults from the registry
    const agentDefaults = this.buildAgentDefaults(agentId);

    return resolveConfig(agentDefaults, this.config.defaults, directoryConfig, sessionOverrides);
  }

  /** Build a partial SessionConfig from agent definition defaults. */
  private buildAgentDefaults(agentId: string): Partial<SessionConfig> | undefined {
    if (!this.agentRegistry) return undefined;
    const def = this.agentRegistry.get(agentId);
    if (!def) return undefined;

    return {
      agent: def.id,
      gitTracker: {
        commitOn: def.defaults.commitOn,
      } as SessionConfig['gitTracker'],
      permissions: {
        autoApprove: def.defaults.autoApprove,
        requireApproval: def.defaults.requireApproval,
        deny: def.defaults.deny,
      },
    };
  }

  /** Get the machine ID. */
  getMachineId(): string {
    this.ensureLoaded();
    return this.config.machineId ?? os.hostname();
  }

  /** Get daemon runtime settings from config (if any). */
  getDaemonConfig():
    | {
        listen?: string;
        profile?: 'local' | 'lan' | 'relay';
        allowedHosts?: string[] | true;
        allowedOrigins?: string[] | true;
        authEnabled?: boolean;
        logFile?: string;
        server?: {
          url?: string;
          appUrl?: string;
          tlsVerify?: 'auto' | '0' | '1';
          caCertPath?: string;
          tlsPins?: string[];
          contextCandidateDecisionKeys?: Record<string, string>;
        };
        relay?: {
          enabled?: boolean;
          bindings?: Array<{
            enabled?: boolean;
            endpoint?: string;
            serverUrl?: string;
            workspaceId?: string;
            installId?: string;
            runtimeTargetId?: string;
            machineId?: string;
            machineName?: string;
            issueToken?: string;
            tlsVerify?: 'auto' | '0' | '1';
            caCertPath?: string;
            tlsPins?: string[];
            tokenIssuer?: string;
            tokenAudience?: string;
            tokenJwksUrl?: string;
            signingKeys?: Record<string, string>;
            tokenClockSkewSec?: number;
          }>;
          endpoint?: string;
          serverUrl?: string;
          workspaceId?: string;
          installId?: string;
          runtimeTargetId?: string;
          machineId?: string;
          machineName?: string;
          issueToken?: string;
          tlsVerify?: 'auto' | '0' | '1';
          caCertPath?: string;
          tlsPins?: string[];
          tokenIssuer?: string;
          tokenAudience?: string;
          tokenJwksUrl?: string;
          signingKeys?: Record<string, string>;
          tokenClockSkewSec?: number;
        };
        worker?: {
          lifecycle?: 'persistent' | 'ephemeral';
          transport?: 'polling' | 'relay' | 'inbound';
          serverUrl?: string;
          appUrl?: string;
          workspaceId?: string;
          managedExecutorId?: string;
          credential?: string;
          workspaceRoot?: string;
          logsDir?: string;
          cacheDir?: string;
          stateDir?: string;
          identityKeyPath?: string;
          publicKeyFingerprint?: string;
          capabilities?: {
            agents?: Array<{
              id: string;
              displayName?: string;
              tier?: 'sdk' | 'pty';
              available: boolean;
            }>;
          };
        };
      }
    | undefined {
    this.ensureLoaded();
    return this.config.daemon;
  }

  /** Merge daemon runtime settings into config. */
  async setDaemonConfig(daemonConfig: NonNullable<ViewportConfig['daemon']>): Promise<void> {
    this.ensureLoaded();
    const base =
      this.resourceOverridePath && this.resourceOverrideConfig
        ? (this.resourceOverrideConfig.daemon ?? {})
        : (this.globalConfig.daemon ?? {});
    const merged = mergeWithDeletes<NonNullable<ViewportConfig['daemon']>>(base, daemonConfig);
    validateRelayRuntimeSecurity(toRuntimeConfigForDaemonValidation(merged));

    if (this.resourceOverridePath) {
      const nextResourceConfig = {
        ...(this.resourceOverrideConfig ?? {}),
        daemon: merged,
      };
      this.resourceOverrideConfig = nextResourceConfig;
      await saveConfigToPath(this.resourceOverridePath, nextResourceConfig);
    } else {
      this.globalConfig = {
        ...this.globalConfig,
        daemon: merged,
      };
      await saveConfig(this.globalConfig);
    }

    this.config = deepMerge(this.globalConfig, this.resourceOverrideConfig ?? {});
  }

  /** Update global defaults. */
  async setDefaults(defaults: Partial<SessionConfig>): Promise<void> {
    this.ensureLoaded();
    this.config.defaults = deepMerge(this.config.defaults ?? {}, defaults);
    await saveConfig(this.config);
  }

  /** Register a directory with optional config. */
  async registerDirectory(
    directoryId: string,
    dirPath: string,
    config?: Partial<SessionConfig>,
  ): Promise<void> {
    this.ensureLoaded();
    if (!this.config.directories) {
      this.config.directories = {};
    }
    this.config.directories[directoryId] = { path: dirPath, config };
    await saveConfig(this.config);
  }

  /** Unregister a directory. */
  async unregisterDirectory(directoryId: string): Promise<void> {
    this.ensureLoaded();
    if (this.config.directories) {
      delete this.config.directories[directoryId];
      await saveConfig(this.config);
    }
  }

  /** Get all registered directories. */
  getDirectories(): Record<string, { path: string; config?: Partial<SessionConfig> }> {
    this.ensureLoaded();
    return this.config.directories ?? {};
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error('ConfigManager not loaded. Call load() first.');
    }
  }
}
