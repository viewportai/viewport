import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './core/output.js';
import type { Daemon } from './core/daemon.js';
import { AgentRegistry } from './core/agent-registry.js';
import { decodeProjectDir } from './discovery/jsonl-reader.js';
import { BUILT_IN_AGENTS } from './agents/built-in.js';
import { loadPluginAgents } from './plugins/loader.js';
import { customCommandAgentFromEnv } from './agents/custom-command.js';

export async function loadAgents(daemon: Daemon): Promise<AgentRegistry> {
  const registry = new AgentRegistry();

  for (const def of BUILT_IN_AGENTS) {
    registry.register(def);
  }

  const customCommandAgent = customCommandAgentFromEnv();
  if (customCommandAgent) {
    registry.register(customCommandAgent);
  }

  try {
    const plugins = await loadPluginAgents({ projectDir: process.cwd() });
    for (const plugin of plugins) {
      registry.register(plugin.definition);
      logger.log(`Plugin ${plugin.manifest.name}: loaded (${plugin.definition.id})`);
    }
  } catch (err) {
    logger.warn('Plugin load failed:', err);
  }

  daemon.configManager.setAgentRegistry(registry);

  const availability = await registry.detectAvailable();

  for (const def of registry.getAll()) {
    const available = availability.get(def.id) ?? false;
    const discoveryIndependent = def.id === 'codex';
    let discoveryRegistered = false;
    if (def.createDiscovery && (available || discoveryIndependent)) {
      try {
        const discovery = await def.createDiscovery();
        if (discovery) {
          daemon.registerDiscovery(discovery);
          discoveryRegistered = true;
        }
      } catch (err) {
        logger.error(`  Failed to create discovery for ${def.id}:`, err);
      }
    }

    if (!available) {
      logger.log(`Agent ${def.displayName}: not available (${def.detection.description})`);
      if (def.id === 'codex' && discoveryRegistered) {
        logger.log(
          '  Codex discovery is active; install @openai/codex-sdk@latest (or @openai/codex@latest) to enable launching/resuming sessions.',
        );
      }
      continue;
    }

    logger.log(`Agent ${def.displayName}: available`);

    try {
      const adapter = await def.createAdapter();
      if (adapter) {
        daemon.registerAdapter(adapter);
      }
    } catch (err) {
      logger.error(`  Failed to create adapter for ${def.id}:`, err);
    }
  }

  return registry;
}

export function decodeAutoRegisterEntry(entry: string): string {
  return entry.startsWith('-') ? decodeProjectDir(entry) : decodeProjectDir(`-${entry}`);
}

export async function autoRegisterDirectories(
  daemon: Daemon,
  registry: AgentRegistry,
): Promise<void> {
  const watchDirs = registry.getAllWatchDirs();

  for (const watchDir of watchDirs) {
    try {
      const entries = await fs.readdir(watchDir);
      for (const entry of entries) {
        const projectDir = path.join(watchDir, entry);
        try {
          const stat = await fs.stat(projectDir);
          if (!stat.isDirectory()) continue;

          const candidate = decodeAutoRegisterEntry(entry);

          try {
            await fs.access(candidate);
          } catch {
            continue;
          }

          if (!daemon.directoryManager.getByPath(candidate)) {
            await daemon.directoryManager.register(candidate);
            logger.log(`Auto-registered: ${candidate}`);
          }
        } catch {
          // Skip invalid entries.
        }
      }
    } catch {
      // Watch dir doesn't exist — not an error.
    }
  }
}
