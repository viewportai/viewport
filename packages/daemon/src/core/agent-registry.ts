/**
 * Agent Registry — the extensibility backbone of Viewport.
 *
 * Agent definitions describe how to detect, configure, and instantiate
 * each supported agent. The daemon core never imports agent-specific code
 * directly — it loads agents from the registry.
 *
 * Two tiers:
 *   - SDK adapters: deep integration (structured tool calls, permissions, tokens)
 *   - PTY adapters: broad compatibility (terminal I/O, spawn any CLI)
 */

import type { AgentAdapter, SessionDiscovery } from './interfaces.js';
import type { PermissionsConfig, GitTrackerConfig } from './types.js';

// ---------------------------------------------------------------------------
// Agent definition — the contract every agent must implement
// ---------------------------------------------------------------------------

export type AgentTier = 'sdk' | 'pty';

export interface AgentDefaults {
  /** Tool names that trigger git commits. */
  commitOn: string[];
  /** Tools that are safe to auto-approve. */
  autoApprove: string[];
  /** Tools that require user approval. */
  requireApproval: string[];
  /** Tools to always deny. */
  deny: string[];
}

export interface AgentCapabilities {
  /** Agent emits structured tool call events. */
  structuredToolCalls: boolean;
  /** Agent supports interactive permission callbacks. */
  permissionCallbacks: boolean;
  /** Agent reports token usage. */
  tokenUsage: boolean;
  /** Sessions can be resumed. */
  resume: boolean;
  /** Agent supports extended thinking / chain-of-thought streaming. */
  extendedThinking: boolean;
}

export interface AgentDetection {
  /** Check if the agent is installed / available on this machine. */
  check: () => Promise<boolean>;
  /** Human-readable description (shown in `vpd install`). */
  description: string;
}

/** Model info from agent SDKs (e.g. Claude's supportedModels()). */
export interface ModelInfo {
  /** Agent that can execute this model. */
  agentId?: string;
  /** Model identifier to use in API calls. */
  value: string;
  /** Human-readable display name. */
  displayName: string;
  /** Description of the model's capabilities. */
  description: string;
  /** Whether this model supports effort levels. */
  supportsEffort?: boolean;
  /** Available effort levels for this model. */
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'max')[];
  /** Whether this model supports adaptive thinking. */
  supportsAdaptiveThinking?: boolean;
}

export interface AgentDefinition {
  /** Unique identifier (e.g. 'claude', 'aider', 'codex'). */
  id: string;
  /** Display name for UIs. */
  displayName: string;
  /** Integration tier. */
  tier: AgentTier;
  /** Agent-specific tool defaults (merged into config resolution chain). */
  defaults: AgentDefaults;
  /** Declared capabilities — UI adapts based on these. */
  capabilities: AgentCapabilities;
  /** Detection: how to check if this agent is available. */
  detection: AgentDetection;
  /** Factory: create an adapter. Returns null if unavailable. */
  createAdapter: () => Promise<AgentAdapter | null>;
  /** Factory: create a discovery provider (for agents that persist session history). */
  createDiscovery?: () => Promise<SessionDiscovery | null>;
  /** Directories this agent uses for session storage (for file watching). */
  watchDirs?: () => string[];
  /** Fetch available models from the agent's SDK. Returns empty array if not supported. */
  fetchModels?: () => Promise<ModelInfo[]>;
}

// ---------------------------------------------------------------------------
// Agent registry — holds registered definitions
// ---------------------------------------------------------------------------

export class AgentRegistry {
  private definitions = new Map<string, AgentDefinition>();
  private cachedModels: ModelInfo[] | null = null;

  /** Register an agent definition. */
  register(definition: AgentDefinition): void {
    this.definitions.set(definition.id, definition);
  }

  /** Get an agent definition by ID. */
  get(agentId: string): AgentDefinition | undefined {
    return this.definitions.get(agentId);
  }

  /** Get all registered definitions. */
  getAll(): AgentDefinition[] {
    return [...this.definitions.values()];
  }

  /** Get agent IDs. */
  getIds(): string[] {
    return [...this.definitions.keys()];
  }

  /** Check which registered agents are available on this machine. */
  async detectAvailable(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    const checks = this.getAll().map(async (def) => {
      try {
        const available = await def.detection.check();
        results.set(def.id, available);
      } catch {
        results.set(def.id, false);
      }
    });
    await Promise.all(checks);
    return results;
  }

  /**
   * Resolve agent-specific permissions defaults.
   * Returns a PermissionsConfig from the agent's registered defaults,
   * used as the base layer in config resolution.
   */
  resolveAgentPermissions(agentId: string): PermissionsConfig | undefined {
    const def = this.definitions.get(agentId);
    if (!def) return undefined;
    return {
      autoApprove: def.defaults.autoApprove,
      requireApproval: def.defaults.requireApproval,
      deny: def.defaults.deny,
    };
  }

  /**
   * Resolve agent-specific git tracker defaults.
   * Returns partial GitTrackerConfig with commitOn from the agent's defaults.
   */
  resolveAgentGitConfig(agentId: string): Partial<GitTrackerConfig> | undefined {
    const def = this.definitions.get(agentId);
    if (!def) return undefined;
    return {
      commitOn: def.defaults.commitOn,
    };
  }

  /** Get capabilities for a specific agent (for hello message). */
  getCapabilities(agentId: string): AgentCapabilities | undefined {
    return this.definitions.get(agentId)?.capabilities;
  }

  /** Get all directories that registered agents want watched. */
  getAllWatchDirs(): string[] {
    const dirs: string[] = [];
    for (const def of this.definitions.values()) {
      if (def.watchDirs) {
        dirs.push(...def.watchDirs());
      }
    }
    return dirs;
  }

  /**
   * Fetch available models from all registered agents that support it.
   * Results are cached — call invalidateModelCache() to refresh.
   */
  async fetchAllModels(): Promise<ModelInfo[]> {
    if (this.cachedModels) return this.cachedModels;

    const allModels: ModelInfo[] = [];
    for (const def of this.definitions.values()) {
      if (def.fetchModels) {
        try {
          const models = await def.fetchModels();
          allModels.push(
            ...models.map((model) => ({ ...model, agentId: model.agentId ?? def.id })),
          );
        } catch {
          // Agent's model fetch failed — non-fatal
        }
      }
    }
    this.cachedModels = allModels;
    return allModels;
  }

  /** Get cached models (synchronous — returns empty if not yet fetched). */
  getCachedModels(): ModelInfo[] {
    return this.cachedModels ?? [];
  }

  /** Invalidate the model cache (e.g. on reconnect). */
  invalidateModelCache(): void {
    this.cachedModels = null;
  }

  /** Serialize all agents for the hello message. */
  toHelloPayload(): AgentInfo[] {
    return this.getAll().map((def) => ({
      id: def.id,
      displayName: def.displayName,
      tier: def.tier,
      available: true, // Only registered agents that passed detection are in the registry at runtime
      capabilities: def.capabilities,
    }));
  }
}

/** Serialized agent info for the wire protocol (hello message). */
export interface AgentInfo {
  id: string;
  displayName: string;
  tier: AgentTier;
  available: boolean;
  capabilities: AgentCapabilities;
}
