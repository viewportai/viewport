/**
 * @viewportai/workflow-sdk
 *
 * The plugin SDK for Viewport workflows. A plugin is a small npm package that
 * registers one or more custom **node types** or **JSONata expressions** with
 * the daemon's workflow runtime. Plugins are the supported extension surface
 * — they ship as separate packages, are discovered by the daemon at boot via
 * `~/.viewport/plugins.json`, and never need to fork the daemon.
 *
 * Two primary entry points:
 *
 *   defineNode(...)        Register a node type. The runtime invokes the
 *                          provided `execute` function whenever a workflow
 *                          declares a node with the matching `type`.
 *   defineExpression(...)  Register a JSONata function authors can call inside
 *                          `{{ ... }}` templates and `when` / `triggerRule`
 *                          expressions.
 *
 * Loading
 * -------
 * The daemon loads plugins by reading `~/.viewport/plugins.json`:
 *   {
 *     "plugins": [
 *       { "name": "viewport-mcp", "module": "./plugins/viewport-mcp/index.js" }
 *     ]
 *   }
 * Each `module` resolves to a file whose default export is a `WorkflowPlugin`.
 * The daemon never auto-installs plugins; users opt in by editing the file
 * (or having a setup CLI write it for them).
 */

import { z, type ZodTypeAny } from 'zod';

export const WORKFLOW_PLUGIN_CONTRACT_VERSION = 'viewport.workflow-plugin/v1' as const;

/**
 * Lifecycle status a custom node can return from its execute hook. Mirrors
 * the daemon's WorkflowNodeStatus union exactly so the SDK doesn't need to
 * import from the daemon.
 */
export type WorkflowNodeStatus =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'skipped';

/**
 * Read-only context the runtime hands every node execution. Plugin authors
 * should treat this as the contract — additional fields may be added; never
 * removed without a major version bump of this SDK.
 */
export interface WorkflowNodeContext {
  /** Node identifier inside the workflow document. */
  readonly nodeId: string;
  /** Stable run identifier for this execution. Useful for logging / WAL. */
  readonly runId: string;
  /** Resolved workflow inputs (merged defaults + caller-provided values). */
  readonly inputs: Readonly<Record<string, string | number | boolean>>;
  /** Absolute path on disk where the workflow is running (the workspace root). */
  readonly directoryPath: string;
  /** Lookup table of upstream node states this node `needs`. */
  readonly nodes: Readonly<Record<string, WorkflowNodeView>>;
  /**
   * Render a `{{ <jsonata> }}` template against the run context. Custom node
   * authors should always go through this rather than concatenating values
   * themselves so legacy aliases (`outputs.X`, `artifacts.X.Y`) keep working.
   */
  render: (template: string) => Promise<string>;
  /**
   * Evaluate a raw JSONata expression. Returns whatever JSONata produces — a
   * string, number, boolean, array, or object.
   */
  evaluate: (expression: string) => Promise<unknown>;
  /** Append a structured event to the run timeline. */
  emitEvent: (event: { type: string; message: string; data?: Record<string, unknown> }) => void;
}

/** Shape exposed to plugins for upstream node access. */
export interface WorkflowNodeView {
  readonly status: WorkflowNodeStatus;
  readonly output: string | null;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly error: string | null;
}

/**
 * What a custom node returns when it finishes. Plugins can choose to expose
 * structured outputs alongside the bulk text; the runtime persists both.
 *
 *   { status: 'completed', output: '...', outputs: { count: 42 } }
 *   { status: 'failed', error: 'Permission denied' }
 *   { status: 'blocked' }   // long-running, e.g. waiting for human input
 */
export type WorkflowNodeResult =
  | { status: 'completed'; output?: string; outputs?: Record<string, unknown> }
  | { status: 'failed'; error: string }
  | { status: 'blocked'; output?: string; reason?: string };

/**
 * Definition for a custom workflow node. The `schema` is a Zod schema that
 * validates the YAML config block authors write; the runtime parses YAML →
 * runs the schema → calls `execute(config, ctx)`.
 *
 * Example:
 *   defineNode({
 *     type: 'http_request',
 *     schema: z.object({ url: z.string().url(), method: z.enum(['GET','POST']).optional() }),
 *     async execute(config, ctx) {
 *       const url = await ctx.render(config.url);
 *       const response = await fetch(url, { method: config.method ?? 'GET' });
 *       return { status: 'completed', output: await response.text() };
 *     },
 *   });
 */
export interface NodeDefinition<Schema extends ZodTypeAny = ZodTypeAny> {
  /** Unique node `type` identifier; cannot collide with built-ins. */
  type: string;
  /** Optional human-readable description shown in the editor's Add menu. */
  description?: string;
  /** Zod schema for the YAML configuration block authors write under this type. */
  schema: Schema;
  /** Execute the node. Plugins must not throw — return a failed result instead. */
  execute: (
    config: z.infer<Schema>,
    ctx: WorkflowNodeContext,
  ) => Promise<WorkflowNodeResult>;
}

export function defineNode<Schema extends ZodTypeAny>(
  definition: NodeDefinition<Schema>,
): NodeDefinition<Schema> {
  if (BUILTIN_NODE_TYPES.has(definition.type)) {
    throw new Error(
      `Node type '${definition.type}' is reserved by the runtime — pick another name.`,
    );
  }
  return definition;
}

const BUILTIN_NODE_TYPES = new Set([
  'prompt',
  'shell',
  'approval',
  'gate',
  'loop',
  'subflow',
]);

/**
 * Definition for a custom JSONata function. Authors call it inside template
 * expressions like `{{ slugify($inputs.title) }}`.
 *
 * Example:
 *   defineExpression({
 *     name: 'slugify',
 *     evaluate: (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
 *   });
 */
export interface ExpressionDefinition {
  name: string;
  description?: string;
  evaluate: (...args: unknown[]) => unknown | Promise<unknown>;
}

export function defineExpression(definition: ExpressionDefinition): ExpressionDefinition {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(definition.name)) {
    throw new Error(
      `Invalid expression name '${definition.name}' — must be a valid JSONata identifier.`,
    );
  }
  return definition;
}

/**
 * The default export shape for a plugin module. The daemon imports the
 * module at boot and reads `nodes` and `expressions` arrays.
 *
 * Example plugin:
 *
 *   import { definePlugin, defineNode, defineExpression } from '@viewportai/workflow-sdk';
 *
 *   export default definePlugin({
 *     name: 'viewport-http',
 *     version: '1.0.0',
 *     nodes: [defineNode({ ... })],
 *     expressions: [defineExpression({ ... })],
 *   });
 */
export interface WorkflowPlugin {
  name: string;
  version: string;
  contract?: typeof WORKFLOW_PLUGIN_CONTRACT_VERSION;
  description?: string;
  nodes?: NodeDefinition[];
  expressions?: ExpressionDefinition[];
}

export function definePlugin(plugin: WorkflowPlugin): WorkflowPlugin {
  if (!/^[a-z][a-z0-9-]+$/.test(plugin.name)) {
    throw new Error(
      `Invalid plugin name '${plugin.name}' — use lowercase letters, digits, and dashes.`,
    );
  }
  return plugin;
}

/**
 * Schema for `~/.viewport/plugins.json`. Exposed so the daemon can validate
 * the file with the same contract plugin authors see.
 */
export const PluginManifestSchema = z
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

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
