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

const RequiresSchema = z
  .object({
    agents: z.array(z.string().trim().min(1)).optional(),
    tools: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

const NodeBaseSchema = z.object({
  title: z.string().trim().min(1).optional(),
  needs: z.array(z.string().trim().min(1)).optional(),
});

const PromptNodeSchema = NodeBaseSchema.extend({
  type: z.literal('prompt'),
  prompt: z.string().trim().min(1),
  agent: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
}).strict();

const ShellNodeSchema = NodeBaseSchema.extend({
  type: z.literal('shell'),
  command: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional(),
  timeoutSeconds: z.number().int().positive().max(86_400).optional(),
}).strict();

const ApprovalNodeSchema = NodeBaseSchema.extend({
  type: z.literal('approval'),
  prompt: z.string().trim().min(1),
}).strict();

const WorkflowNodeSchema = z.discriminatedUnion('type', [
  PromptNodeSchema,
  ShellNodeSchema,
  ApprovalNodeSchema,
]);

const WorkflowDefinitionSchema = z
  .object({
    schema: z.literal('viewport.workflow/v1'),
    name: z
      .string()
      .trim()
      .min(1)
      .regex(/^[a-zA-Z0-9._/-]+$/),
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
