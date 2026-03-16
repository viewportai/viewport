/**
 * Layered configuration system for the Viewport daemon.
 *
 * Resolution order (later wins):
 *   built-in defaults → global config → directory overrides → session overrides
 *
 * Config file: ~/.viewport/config.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { SessionConfig } from './types.js';
import type { AgentRegistry } from './agent-registry.js';
import { ViewportConfigSchema } from './config-schema.js';
import type { RuntimeLaunchConfig } from '../cli/supervisor-protocol.js';
import { validateRelayRuntimeSecurity } from '../startup-relay-security.js';

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
    relayEnabled: relay.enabled ?? false,
    relayEndpoint: relay.endpoint,
    relayServerUrl: relay.serverUrl,
    relayWorkspaceId: relay.workspaceId,
    relayEnrollToken: relay.enrollToken,
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
  /** Relay URL for remote access. */
  relayUrl?: string;
  /** Machine token for relay auth. */
  relayToken?: string;
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
    relay?: {
      enabled?: boolean;
      endpoint?: string;
      publicEndpoint?: string;
      serverUrl?: string;
      workspaceId?: string;
      enrollToken?: string;
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
  };
}

export function resolveViewportHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['VIEWPORT_HOME'] ?? env['VPD_HOME'];
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return path.resolve(explicit.trim());
  }
  return path.join(os.homedir(), '.viewport');
}

/** Returns the path to the Viewport config directory. */
export function configDir(): string {
  return resolveViewportHome();
}

/** Returns the path to the Viewport config file. */
export function configFilePath(): string {
  return path.join(configDir(), 'config.json');
}

/** Load the config file, returning empty config if it doesn't exist. */
export async function loadConfig(): Promise<ViewportConfig> {
  try {
    const raw = await fs.readFile(configFilePath(), 'utf-8');
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Invalid viewport config JSON at ${configFilePath()}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = ViewportConfigSchema.safeParse(parsedRaw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Invalid viewport config schema at ${configFilePath()}: ${detail}`);
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

/** Save the config file, creating the directory if needed. */
export async function saveConfig(config: ViewportConfig): Promise<void> {
  const dir = configDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(configFilePath(), JSON.stringify(config, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
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
  private loaded = false;
  private agentRegistry: AgentRegistry | null = null;

  /** Load config from disk. Safe to call multiple times. */
  async load(): Promise<void> {
    this.config = await loadConfig();
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

  /** Get the relay URL (if configured). */
  getRelayUrl(): string | undefined {
    this.ensureLoaded();
    return this.config.relayUrl;
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
        relay?: {
          enabled?: boolean;
          endpoint?: string;
          publicEndpoint?: string;
          serverUrl?: string;
          workspaceId?: string;
          enrollToken?: string;
          issueToken?: string;
          tlsVerify?: 'auto' | '0' | '1';
          caCertPath?: string;
          tlsPins?: string[];
          tokenIssuer?: string;
          tokenAudience?: string;
          signingKeys?: Record<string, string>;
          tokenClockSkewSec?: number;
        };
      }
    | undefined {
    this.ensureLoaded();
    return this.config.daemon;
  }

  /** Merge daemon runtime settings into config. */
  async setDaemonConfig(daemonConfig: NonNullable<ViewportConfig['daemon']>): Promise<void> {
    this.ensureLoaded();
    const merged = deepMerge<NonNullable<ViewportConfig['daemon']>>(
      this.config.daemon ?? {},
      daemonConfig,
    );
    validateRelayRuntimeSecurity(toRuntimeConfigForDaemonValidation(merged));
    this.config.daemon = merged;
    await saveConfig(this.config);
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
