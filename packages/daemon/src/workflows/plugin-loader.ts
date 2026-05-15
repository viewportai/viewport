import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { configDir } from '../core/config.js';
import { logger } from '../core/logger.js';
import { registerNodeExecutor, type BuiltinNodeExecutor } from './node-registry.js';
import type { WorkflowNode } from './types.js';

const log = logger.child({ component: 'plugin-loader' });

/**
 * Plugin manifest schema, mirrored from `@viewportai/workflow-sdk`. The
 * daemon doesn't take a workspace dependency on the SDK so plugin authors
 * can ship their plugins independently of daemon releases — but the
 * manifest contract is the same.
 */
const PluginManifestSchema = z
  .object({
    plugins: z
      .array(
        z
          .object({
            name: z.string().min(1),
            module: z.string().min(1),
            enabled: z.boolean().optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const RESERVED_NODE_TYPES = new Set<WorkflowNode['type']>([
  'agent',
  'prompt',
  'shell',
  'approval',
  'context',
  'condition',
  'artifact',
  'action',
  'gate',
  'loop',
  'subflow',
  'plan',
]);

interface LoadedPlugin {
  name: string;
  nodes: number;
  expressions: number;
}

export interface PluginLoadResult {
  loaded: LoadedPlugin[];
  errors: Array<{ name: string; message: string }>;
}

/**
 * Read `~/.viewport/plugins.json`, dynamic-import each plugin module, and
 * register its node executors into the runtime registry. Failures during
 * plugin import never block the daemon — they're collected into the result
 * and surfaced via the daemon's structured logger.
 *
 * Each plugin module's default export must look like:
 *   { name: string; version: string; nodes?: NodeDefinition[]; expressions?: ExpressionDefinition[] }
 *
 * That shape comes from `@viewportai/workflow-sdk`'s `definePlugin()`. The
 * daemon doesn't enforce the SDK is the source — anything matching the
 * shape works — but the SDK is the supported way to author it.
 */
export async function loadPlugins(): Promise<PluginLoadResult> {
  const result: PluginLoadResult = { loaded: [], errors: [] };
  const manifestPath = path.join(configDir(), 'plugins.json');

  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      log.debug('No plugin manifest found at ' + manifestPath);
      return result;
    }
    log.error({ err: error, manifestPath }, 'Failed to read plugin manifest');
    return result;
  }

  let manifest: z.infer<typeof PluginManifestSchema>;
  try {
    manifest = PluginManifestSchema.parse(JSON.parse(raw));
  } catch (error) {
    log.error({ err: error, manifestPath }, 'Invalid plugin manifest schema');
    return result;
  }

  for (const entry of manifest.plugins) {
    if (entry.enabled === false) continue;
    try {
      const moduleSpecifier = path.isAbsolute(entry.module)
        ? entry.module
        : path.resolve(configDir(), entry.module);
      const imported = (await import(moduleSpecifier)) as { default?: unknown };
      const plugin = imported.default;
      if (!isPluginShape(plugin)) {
        throw new Error('Plugin default export does not match the expected WorkflowPlugin shape');
      }
      const counts = registerPluginNodes(entry.name, plugin);
      result.loaded.push({ name: entry.name, ...counts });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn({ plugin: entry.name, message }, 'Skipping plugin (load failed)');
      result.errors.push({ name: entry.name, message });
    }
  }

  if (result.loaded.length > 0) {
    log.info(
      { loaded: result.loaded.map((entry) => entry.name) },
      `Loaded ${result.loaded.length} workflow plugin(s)`,
    );
  }
  return result;
}

interface PluginShape {
  name: string;
  version?: string;
  nodes?: Array<{ type: string; execute: BuiltinNodeExecutor }>;
  expressions?: Array<{ name: string; evaluate: (...args: unknown[]) => unknown }>;
}

function isPluginShape(value: unknown): value is PluginShape {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== 'string') return false;
  if (
    candidate.nodes !== undefined &&
    (!Array.isArray(candidate.nodes) ||
      candidate.nodes.some((node) => !isNodeDefinitionShape(node)))
  ) {
    return false;
  }
  return true;
}

function isNodeDefinitionShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  return typeof node.type === 'string' && typeof node.execute === 'function';
}

function registerPluginNodes(
  pluginName: string,
  plugin: PluginShape,
): { nodes: number; expressions: number } {
  let nodes = 0;
  let expressions = 0;
  for (const definition of plugin.nodes ?? []) {
    if (RESERVED_NODE_TYPES.has(definition.type as WorkflowNode['type'])) {
      log.warn(
        { plugin: pluginName, type: definition.type },
        'Plugin tried to claim a reserved node type — skipping',
      );
      continue;
    }
    registerNodeExecutor(definition.type, definition.execute);
    nodes += 1;
  }
  // Custom expressions are accepted at the manifest layer for forward
  // compatibility but the JSONata runtime does not yet expose a binding
  // surface for them. Track them as loaded so plugin authors can verify
  // their manifest is being read.
  expressions = (plugin.expressions ?? []).length;
  return { nodes, expressions };
}
