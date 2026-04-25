import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { ParsedWorkflow, WorkflowDefinition } from './types.js';

const InputDefinitionSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean']),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    description: z.string().optional(),
  })
  .strict();

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[a-zA-Z0-9._/-]+$/);

const OutputDefinitionSchema = z
  .object({
    type: z.enum(['string', 'number', 'boolean', 'json', 'file', 'artifact']),
    description: z.string().optional(),
  })
  .strict();

const ArtifactDefinitionSchema = z
  .object({
    path: z.string().trim().min(1),
    type: z.enum(['file', 'directory', 'patch', 'report', 'log']).optional(),
    description: z.string().optional(),
  })
  .strict();

const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    backoffSeconds: z.number().int().min(0).max(86_400).optional(),
    /**
     * Substrings (case-insensitive) classifying an error as transient. When
     * omitted, every error is retryable up to `maxAttempts`. When set, only
     * errors matching one of the patterns are retried; everything else fails
     * fast.
     */
    transient: z.array(z.string().min(1)).optional(),
    /**
     * Substrings (case-insensitive) classifying an error as fatal. A fatal
     * error skips all remaining attempts even when `maxAttempts > 1`. Wins
     * over `transient` if both lists match.
     */
    fatal: z.array(z.string().min(1)).optional(),
  })
  .strict();

const NodePolicySchema = z
  .object({
    onFailure: z.enum(['halt', 'continue', 'skip_dependents']).optional(),
    approvalRequired: z.boolean().optional(),
  })
  .strict();

const GateDefinitionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('check'),
      expression: z.string().trim().min(1),
      description: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('policy'),
      expression: z.string().trim().min(1),
      description: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('human_review'),
      prompt: z.string().trim().min(1),
      description: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('schedule'),
      waitUntil: z.string().trim().min(1),
      description: z.string().optional(),
    })
    .strict(),
]);

const EnvValueSchema = z
  .object({
    value: z.string().optional(),
    secret: identifierSchema.optional(),
  })
  .strict()
  .refine((entry) => Boolean(entry.value) !== Boolean(entry.secret), {
    message: 'Set exactly one of value or secret.',
  });

const RequiresSchema = z
  .object({
    agents: z.array(z.string().trim().min(1)).optional(),
    tools: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

const TriggerRuleSchema = z.enum(['all_success', 'all_done', 'one_success']);

const NodeBaseSchema = z.object({
  title: z.string().trim().min(1).optional(),
  needs: z.array(z.string().trim().min(1)).optional(),
  /**
   * JSONata expression. Evaluated against the run context before the node
   * runs. Falsy result skips the node. Parser only validates that the field
   * is a string; runtime catches expression errors at exec time.
   */
  when: z.string().trim().min(1).optional(),
  /** Join semantics when this node has multiple `needs`. */
  triggerRule: TriggerRuleSchema.optional(),
  timeoutSeconds: z.number().int().positive().max(86_400).optional(),
  retry: RetryPolicySchema.optional(),
  policy: NodePolicySchema.optional(),
  outputs: z.record(identifierSchema, OutputDefinitionSchema).optional(),
  artifacts: z.record(identifierSchema, ArtifactDefinitionSchema).optional(),
  env: z.record(identifierSchema, EnvValueSchema).optional(),
});

const PromptNodeSchema = NodeBaseSchema.extend({
  type: z.literal('prompt'),
  prompt: z.string().trim().min(1),
  agent: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
}).strict();

const ShellNodeSchema = NodeBaseSchema.extend({
  type: z.literal('shell'),
  command: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional(),
}).strict();

const ApprovalNodeSchema = NodeBaseSchema.extend({
  type: z.literal('approval'),
  prompt: z.string().trim().min(1),
  /**
   * When true, the approver's free-text message is captured as the node's
   * `output` so downstream nodes can reference it. Defaults to false — output
   * is a constant 'Approved' string and the message is only kept on the
   * approval audit record (`nodes.<id>.approval.message`).
   */
  captureResponse: z.boolean().optional(),
  /**
   * Run a follow-up shell command before failing when approval is denied. The
   * approver's rejection message is exposed to the command via the
   * `VIEWPORT_REJECT_MESSAGE` env var and through `{{ nodes.<id>.approval.message }}`
   * template references. Output of the follow-up is captured into the node's
   * audit record as `onRejectOutput` for the run timeline.
   */
  onReject: z
    .object({
      command: z.string().trim().min(1),
      cwd: z.string().trim().min(1).optional(),
      timeoutSeconds: z.number().int().positive().max(86_400).optional(),
    })
    .strict()
    .optional(),
}).strict();

const GateNodeSchema = NodeBaseSchema.extend({
  type: z.literal('gate'),
  gate: GateDefinitionSchema,
}).strict();

/**
 * Inline mini-node executed by a `loop` parent. Cannot declare its own
 * `needs`, `triggerRule`, or `when`. Shell only for the first cut — prompt
 * bodies need per-iteration session lifecycle and ship in a follow-up.
 */
const LoopBodySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('shell'),
      command: z.string().trim().min(1),
      cwd: z.string().trim().min(1).optional(),
      timeoutSeconds: z.number().int().positive().max(86_400).optional(),
    })
    .strict(),
]);

const LoopNodeSchema = NodeBaseSchema.extend({
  type: z.literal('loop'),
  foreach: z.string().trim().min(1).optional(),
  while: z.string().trim().min(1).optional(),
  until: z.string().trim().min(1).optional(),
  maxIterations: z.number().int().min(1).max(1000),
  body: LoopBodySchema,
})
  .strict()
  .superRefine((node, ctx) => {
    const modes = [node.foreach, node.while, node.until].filter(Boolean).length;
    if (modes !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Loop node must specify exactly one of foreach, while, or until.',
        path: [],
      });
    }
  });

/**
 * Inline mini-workflow executed by a `subflow` parent. Restricted to shell-only
 * nodes for the first cut so the daemon can run them sequentially without
 * pulling in session lifecycle complexity. Prompt-bodied subflows ship next.
 */
const SubflowChildShellSchema = z
  .object({
    type: z.literal('shell'),
    title: z.string().trim().min(1).optional(),
    needs: z.array(z.string().trim().min(1)).optional(),
    when: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1),
    cwd: z.string().trim().min(1).optional(),
    timeoutSeconds: z.number().int().positive().max(86_400).optional(),
    outputs: z.record(identifierSchema, OutputDefinitionSchema).optional(),
  })
  .strict();

const SubflowChildSchema = z.discriminatedUnion('type', [SubflowChildShellSchema]);

const SubflowNodeSchema = NodeBaseSchema.extend({
  type: z.literal('subflow'),
  /**
   * Inline child workflow definition. Currently only shell children are
   * supported — see SubflowChildSchema. Each child shares the parent's
   * directory, inputs, and run record but executes in its own topological
   * order. The aggregate output of the subflow node is the child terminal
   * outputs encoded as a JSON map keyed by child node id.
   */
  inline: z
    .object({
      nodes: z.record(z.string().trim().min(1), SubflowChildSchema),
    })
    .strict(),
  /**
   * Optional input map. Keys are visible to the child as `inputs.<key>` via
   * the same JSONata context the parent uses; values are JSONata expressions
   * resolved against the parent's run state at subflow start.
   */
  inputs: z.record(identifierSchema, z.string().trim().min(1)).optional(),
}).strict();

const WorkflowNodeSchema = z.discriminatedUnion('type', [
  PromptNodeSchema,
  ShellNodeSchema,
  ApprovalNodeSchema,
  GateNodeSchema,
  LoopNodeSchema,
  SubflowNodeSchema,
]);

const WorkflowDefinitionSchema = z
  .object({
    schema: z.literal('viewport.workflow/v1'),
    name: identifierSchema,
    title: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    inputs: z.record(z.string(), InputDefinitionSchema).optional(),
    requires: RequiresSchema.optional(),
    nodes: z.record(z.string().trim().min(1), WorkflowNodeSchema),
  })
  .strict();

export interface WorkflowValidationIssue {
  path: string;
  message: string;
}

export interface WorkflowValidationResult {
  ok: boolean;
  workflow?: ParsedWorkflow;
  issues: WorkflowValidationIssue[];
}

export async function parseWorkflowFile(filePath: string): Promise<ParsedWorkflow> {
  const sourcePath = path.resolve(filePath);
  const sourceText = await fs.readFile(sourcePath, 'utf-8');
  return parseWorkflow(sourceText, sourcePath);
}

export function validateWorkflowText(
  sourceText: string,
  sourcePath: string,
): WorkflowValidationResult {
  try {
    const workflow = parseWorkflow(sourceText, sourcePath);
    return { ok: true, workflow, issues: [] };
  } catch (error) {
    return {
      ok: false,
      issues: [
        { path: sourcePath, message: error instanceof Error ? error.message : String(error) },
      ],
    };
  }
}

export function parseWorkflow(sourceText: string, sourcePath: string): ParsedWorkflow {
  let raw: unknown;
  try {
    raw = YAML.parse(sourceText);
  } catch (error) {
    throw new Error(
      `Invalid workflow YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = WorkflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const issuePath = issue?.path.join('.') || '<root>';
    throw new Error(`Invalid workflow at ${issuePath}: ${issue?.message ?? 'schema mismatch'}`);
  }

  validateWorkflowGraph(parsed.data);
  const normalizedJson = stableJson(parsed.data);
  const digest = crypto.createHash('sha256').update(normalizedJson).digest('hex');

  return {
    definition: parsed.data,
    digest,
    sourcePath: path.resolve(sourcePath),
    sourceText,
    normalizedJson,
  };
}

export function workflowNodeOrder(definition: WorkflowDefinition): string[] {
  const pending = new Set(Object.keys(definition.nodes));
  const complete = new Set<string>();
  const ordered: string[] = [];

  while (pending.size > 0) {
    const ready = [...pending].filter((nodeId) => {
      const needs = definition.nodes[nodeId]?.needs ?? [];
      return needs.every((dependency) => complete.has(dependency));
    });

    if (ready.length === 0) {
      throw new Error('Workflow contains a dependency cycle');
    }

    ready.sort((a, b) => a.localeCompare(b));
    for (const nodeId of ready) {
      pending.delete(nodeId);
      complete.add(nodeId);
      ordered.push(nodeId);
    }
  }

  return ordered;
}

function validateWorkflowGraph(definition: WorkflowDefinition): void {
  const nodeIds = new Set(Object.keys(definition.nodes));
  if (nodeIds.size === 0) {
    throw new Error('Workflow must define at least one node');
  }

  for (const [nodeId, node] of Object.entries(definition.nodes)) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(nodeId)) {
      throw new Error(`Invalid workflow node id: ${nodeId}`);
    }
    for (const dependency of node.needs ?? []) {
      if (!nodeIds.has(dependency)) {
        throw new Error(`Workflow node ${nodeId} depends on missing node ${dependency}`);
      }
    }
  }

  workflowNodeOrder(definition);
  validateTemplateReferences(definition);
}

function validateTemplateReferences(definition: WorkflowDefinition): void {
  for (const [nodeId, node] of Object.entries(definition.nodes)) {
    const templates = nodeTemplates(node);
    if (templates.length === 0) continue;

    const dependencies = transitiveDependencies(definition, nodeId);
    for (const template of templates) {
      for (const reference of nodeReferences(template)) {
        if (!definition.nodes[reference.nodeId]) {
          throw new Error(`Workflow node ${nodeId} references missing node ${reference.nodeId}`);
        }
        if (!dependencies.has(reference.nodeId)) {
          throw new Error(
            `Workflow node ${nodeId} references ${reference.nodeId} output but does not depend on it`,
          );
        }

        if (reference.kind === 'output') {
          const upstream = definition.nodes[reference.nodeId];
          if (!upstream?.outputs?.[reference.name]) {
            throw new Error(
              `Workflow node ${nodeId} references undeclared output ${reference.nodeId}.${reference.name}`,
            );
          }
        }

        if (reference.kind === 'artifact') {
          const upstream = definition.nodes[reference.nodeId];
          if (!upstream?.artifacts?.[reference.name]) {
            throw new Error(
              `Workflow node ${nodeId} references undeclared artifact ${reference.nodeId}.${reference.name}`,
            );
          }
        }
      }
    }
  }
}

function nodeTemplates(node: WorkflowDefinition['nodes'][string]): string[] {
  if (node.type === 'prompt') return [node.prompt];
  if (node.type === 'shell')
    return [node.command, node.cwd].filter((value): value is string => typeof value === 'string');
  if (node.type === 'gate') {
    if (node.gate.type === 'check' || node.gate.type === 'policy') return [node.gate.expression];
    if (node.gate.type === 'human_review') return [node.gate.prompt];
    return [node.gate.waitUntil];
  }
  if (node.type === 'loop') {
    const templates: string[] = [];
    if (node.foreach) templates.push(node.foreach);
    if (node.while) templates.push(node.while);
    if (node.until) templates.push(node.until);
    if (node.body.type === 'shell') {
      templates.push(node.body.command);
      if (node.body.cwd) templates.push(node.body.cwd);
    }
    return templates;
  }
  if (node.type === 'subflow') {
    const templates: string[] = [];
    for (const value of Object.values(node.inputs ?? {})) {
      templates.push(value);
    }
    // Child node templates reference *child* node ids, not parent ids — they
    // resolve in a separate scope, so we don't validate their refs against
    // the parent dependency graph here. The runner enforces child references
    // at execution time.
    return templates;
  }
  return [node.prompt];
}

type WorkflowTemplateReference =
  | { kind: 'raw'; nodeId: string }
  | { kind: 'output'; nodeId: string; name: string }
  | { kind: 'artifact'; nodeId: string; name: string };

function nodeReferences(template: string): WorkflowTemplateReference[] {
  const references = new Map<string, WorkflowTemplateReference>();
  const rawPatterns = [
    /\{\{\s*nodes\.([A-Za-z0-9._/-]+)\.(?:output|status|sessionId|error)\s*\}\}/g,
    /\{\{\s*outputs\.([A-Za-z0-9._/-]+)\s*\}\}/g,
  ];

  for (const pattern of rawPatterns) {
    for (const match of template.matchAll(pattern)) {
      if (match[1]) references.set(`raw:${match[1]}`, { kind: 'raw', nodeId: match[1] });
    }
  }

  const namedPatterns: Array<[RegExp, 'output' | 'artifact']> = [
    [/\{\{\s*nodes\.([A-Za-z0-9._/-]+)\.outputs\.([A-Za-z0-9._/-]+)\s*\}\}/g, 'output'],
    [/\{\{\s*nodes\.([A-Za-z0-9._/-]+)\.artifacts\.([A-Za-z0-9._/-]+)\s*\}\}/g, 'artifact'],
    [/\{\{\s*artifacts\.([A-Za-z0-9._/-]+)\.([A-Za-z0-9._/-]+)\s*\}\}/g, 'artifact'],
  ];

  for (const [pattern, kind] of namedPatterns) {
    for (const match of template.matchAll(pattern)) {
      if (!match[1] || !match[2]) continue;
      if (kind === 'output') {
        references.set(`output:${match[1]}:${match[2]}`, {
          kind: 'output',
          nodeId: match[1],
          name: match[2],
        });
      } else {
        references.set(`artifact:${match[1]}:${match[2]}`, {
          kind: 'artifact',
          nodeId: match[1],
          name: match[2],
        });
      }
    }
  }

  return [...references.values()];
}

function transitiveDependencies(definition: WorkflowDefinition, nodeId: string): Set<string> {
  const result = new Set<string>();
  const visit = (current: string): void => {
    const node = definition.nodes[current];
    for (const dependency of node?.needs ?? []) {
      if (result.has(dependency)) continue;
      result.add(dependency);
      visit(dependency);
    }
  };
  visit(nodeId);
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
