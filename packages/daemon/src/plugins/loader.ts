/**
 * Plugin loader — discovers and loads agent plugins from:
 *   1. ~/.viewport/plugins/  (user-installed plugins)
 *   2. node_modules/ (project-local plugins)
 *
 * Plugins are npm packages that export an AgentDefinition.
 * Convention: @viewport/agent-* or viewport-agent-*
 *
 * Each plugin's package.json must have a "viewport" field:
 *   { "viewport": { "type": "agent", "agentId": "my-agent" } }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../core/config.js';
import { logger } from '../core/output.js';
import type { AgentDefinition } from '../core/agent-registry.js';

// ---------------------------------------------------------------------------
// Plugin metadata
// ---------------------------------------------------------------------------

export interface PluginManifest {
  /** Package name. */
  name: string;
  /** Package version. */
  version: string;
  /** Viewport plugin metadata. */
  viewport: {
    type: 'agent';
    agentId: string;
  };
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  definition: AgentDefinition;
  path: string;
}

const SAFE_PLUGIN_AGENT_ID = /^[A-Za-z0-9._-]+$/;

function isPathWithin(parentDir: string, targetPath: string): boolean {
  const parent = path.resolve(parentDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  if (relative === '') return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

// ---------------------------------------------------------------------------
// Plugin directories
// ---------------------------------------------------------------------------

/** Get the global plugins directory. */
export function pluginsDir(): string {
  return path.join(configDir(), 'plugins');
}

// ---------------------------------------------------------------------------
// Plugin discovery
// ---------------------------------------------------------------------------

/**
 * Scan a directory for Viewport plugin packages.
 * Returns plugin manifests found in package.json files.
 */
async function scanForPlugins(
  dir: string,
): Promise<Array<{ manifest: PluginManifest; dir: string }>> {
  const found: Array<{ manifest: PluginManifest; dir: string }> = [];

  try {
    const entries = await fs.readdir(dir);

    for (const entry of entries) {
      const entryPath = path.join(dir, entry);

      // Handle scoped packages (@viewport/agent-*)
      if (entry.startsWith('@')) {
        try {
          const scopedEntries = await fs.readdir(entryPath);
          for (const scopedEntry of scopedEntries) {
            const scopedPath = path.join(entryPath, scopedEntry);
            const manifest = await readPluginManifest(scopedPath);
            if (manifest) {
              found.push({ manifest, dir: scopedPath });
            }
          }
        } catch {
          // Not a directory or unreadable
        }
        continue;
      }

      // Handle unscoped packages (viewport-agent-*)
      if (entry.startsWith('viewport-agent-') || entry.startsWith('@viewport')) {
        const manifest = await readPluginManifest(entryPath);
        if (manifest) {
          found.push({ manifest, dir: entryPath });
        }
      }
    }
  } catch {
    // Directory doesn't exist — not an error
  }

  return found;
}

/**
 * Read and validate a plugin's package.json.
 */
async function readPluginManifest(pkgDir: string): Promise<PluginManifest | null> {
  try {
    const pkgPath = path.join(pkgDir, 'package.json');
    const raw = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;

    // Must have viewport metadata
    const viewport = pkg['viewport'] as Record<string, unknown> | undefined;
    if (!viewport || viewport['type'] !== 'agent' || typeof viewport['agentId'] !== 'string') {
      return null;
    }
    const agentId = viewport['agentId'].trim();
    if (!SAFE_PLUGIN_AGENT_ID.test(agentId)) {
      return null;
    }

    return {
      name: typeof pkg['name'] === 'string' ? pkg['name'] : 'unknown',
      version: typeof pkg['version'] === 'string' ? pkg['version'] : '0.0.0',
      viewport: {
        type: 'agent',
        agentId,
      },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plugin loading
// ---------------------------------------------------------------------------

/**
 * Load a single plugin from its directory.
 * The plugin must export an AgentDefinition as default or named 'definition'.
 */
async function loadPlugin(manifest: PluginManifest, pkgDir: string): Promise<LoadedPlugin | null> {
  try {
    // Resolve the main entry point
    const pkgPath = path.join(pkgDir, 'package.json');
    const raw = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const main = (pkg['main'] as string) ?? 'index.js';
    const entryPath = path.resolve(pkgDir, main);
    const resolvedPkgDir = await fs.realpath(pkgDir).catch(() => path.resolve(pkgDir));
    const resolvedEntryPath = await fs.realpath(entryPath).catch(() => entryPath);
    if (!isPathWithin(resolvedPkgDir, resolvedEntryPath)) {
      logger.warn(`Plugin ${manifest.name}: invalid main entry path (outside package dir)`);
      return null;
    }

    // Dynamic import
    const mod = await import(entryPath);
    const definition: AgentDefinition | undefined =
      mod.definition ?? mod.default?.definition ?? mod.default;

    if (!definition || typeof definition.id !== 'string') {
      logger.warn(`Plugin ${manifest.name}: no valid AgentDefinition exported`);
      return null;
    }

    if (definition.id !== manifest.viewport.agentId) {
      logger.warn(
        `Plugin ${manifest.name}: AgentDefinition id '${definition.id}' does not match manifest agentId '${manifest.viewport.agentId}'`,
      );
      return null;
    }

    // Validate the definition has required fields
    if (!definition.displayName || !definition.tier || !definition.createAdapter) {
      logger.warn(`Plugin ${manifest.name}: incomplete AgentDefinition`);
      return null;
    }

    return { manifest, definition, path: pkgDir };
  } catch (err) {
    logger.warn(`Plugin ${manifest.name}: failed to load — ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover and load all agent plugins.
 * Scans:
 *   1. ~/.viewport/plugins/
 *   2. Current project's node_modules/ (optional)
 */
export async function loadPluginAgents(options?: { projectDir?: string }): Promise<LoadedPlugin[]> {
  const scanDirs = [pluginsDir(), path.join(pluginsDir(), 'node_modules')];

  // Optionally scan project-local node_modules
  if (options?.projectDir) {
    scanDirs.push(path.join(options.projectDir, 'node_modules'));
  }

  const allFound: Array<{ manifest: PluginManifest; dir: string }> = [];

  for (const dir of scanDirs) {
    const found = await scanForPlugins(dir);
    allFound.push(...found);
  }

  // Deduplicate by agentId (first one wins)
  const seen = new Set<string>();
  const unique = allFound.filter((f) => {
    if (seen.has(f.manifest.viewport.agentId)) return false;
    seen.add(f.manifest.viewport.agentId);
    return true;
  });

  // Load each plugin
  const loaded: LoadedPlugin[] = [];
  for (const { manifest, dir } of unique) {
    const plugin = await loadPlugin(manifest, dir);
    if (plugin) {
      loaded.push(plugin);
    }
  }

  return loaded;
}

/**
 * List installed plugins (without loading them).
 */
export async function listPlugins(): Promise<PluginManifest[]> {
  const scanDirs = [pluginsDir(), path.join(pluginsDir(), 'node_modules')];
  const manifests: PluginManifest[] = [];

  for (const dir of scanDirs) {
    const found = await scanForPlugins(dir);
    manifests.push(...found.map((f) => f.manifest));
  }

  return manifests;
}
