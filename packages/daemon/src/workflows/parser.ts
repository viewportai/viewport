import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { WORKFLOW_SCHEMA_VERSION, WorkflowDefinitionSchema } from './workflow-schema.js';
import type { ParsedWorkflow, WorkflowContextReference, WorkflowDefinition } from './types.js';

export { WORKFLOW_SCHEMA_VERSION };

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
    if (node.type === 'condition') {
      for (const branchNodeId of [...(node.then ?? []), ...(node.else ?? [])]) {
        if (!nodeIds.has(branchNodeId)) {
          throw new Error(
            `Workflow condition node ${nodeId} references missing node ${branchNodeId}`,
          );
        }
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
          const declaredOutputs = {
            ...(upstream?.outputs ?? {}),
            ...(upstream?.outputSchema ?? {}),
          };
          if (
            !declaredOutputs[declaredReferenceName(reference.name, declaredOutputs)] &&
            !isBuiltinOutputReference(upstream, reference.name)
          ) {
            throw new Error(
              `Workflow node ${nodeId} references undeclared output ${reference.nodeId}.${reference.name}`,
            );
          }
        }

        if (reference.kind === 'artifact') {
          const upstream = definition.nodes[reference.nodeId];
          if (!upstream?.artifacts?.[declaredReferenceName(reference.name, upstream.artifacts)]) {
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
  if (node.type === 'agent') {
    return [node.prompt, node.session?.title, node.handoff?.artifact, node.handoff?.summary].filter(
      (value): value is string => typeof value === 'string',
    );
  }
  if (node.type === 'prompt') {
    return [
      node.prompt,
      node.cwd,
      ...(node.requiredFiles ?? []),
      ...Object.values(node.agents ?? {}).map((agent) => agent.prompt),
    ].filter((value): value is string => typeof value === 'string');
  }
  if (node.type === 'shell')
    return [node.command, node.cwd].filter((value): value is string => typeof value === 'string');
  if (node.type === 'checkout') {
    return [
      node.repository,
      node.remote,
      node.ref,
      node.branch,
      node.path,
      node.credentialRef,
    ].filter((value): value is string => typeof value === 'string');
  }
  if (node.type === 'git_publish') {
    return [
      node.repository,
      node.cwd,
      node.branch,
      node.message,
      node.credentialRef,
      ...(node.paths ?? []),
    ].filter((value): value is string => typeof value === 'string');
  }
  if (node.type === 'approval') {
    const templates = [node.prompt];
    if (node.onReject) {
      if ('command' in node.onReject) {
        templates.push(node.onReject.command);
        if (node.onReject.cwd) templates.push(node.onReject.cwd);
      } else {
        templates.push(node.onReject.prompt);
      }
    }
    return templates;
  }
  if (node.type === 'gate') {
    if (node.gate.type === 'check' || node.gate.type === 'policy') return [node.gate.expression];
    if (node.gate.type === 'human_review') return [node.gate.prompt];
    return [node.gate.waitUntil];
  }
  if (node.type === 'context') {
    return [node.query, ...(node.refs ?? []).map(workflowContextRef)].filter(
      (value): value is string => typeof value === 'string',
    );
  }
  if (node.type === 'context_update') {
    return [
      node.targetRef,
      node.title,
      node.summary,
      node.patch?.text,
      node.patch?.digest,
      node.idempotencyKey,
    ].filter((value): value is string => typeof value === 'string');
  }
  if (node.type === 'condition') {
    return [node.expression, ...(node.then ?? []), ...(node.else ?? [])];
  }
  if (node.type === 'artifact') {
    return [node.name, node.from, node.path, node.description].filter(
      (value): value is string => typeof value === 'string',
    );
  }
  if (node.type === 'action') {
    return [
      node.adapter,
      node.action,
      node.proposalKey,
      node.idempotencyKey,
      ...Object.values(node.with ?? {}).map((value) => (typeof value === 'string' ? value : '')),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  }
  if (node.type === 'loop') {
    const templates: string[] = [];
    if (node.foreach) templates.push(node.foreach);
    if (node.while) templates.push(node.while);
    if (node.until) templates.push(node.until);
    if (node.body.type === 'shell') {
      templates.push(node.body.command);
      if (node.body.cwd) templates.push(node.body.cwd);
    } else {
      templates.push(node.body.prompt);
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
  return [];
}

function isBuiltinOutputReference(
  node: WorkflowDefinition['nodes'][string] | undefined,
  name: string,
): boolean {
  if (!node) return false;
  if (node.type === 'checkout') {
    return ['repository', 'path', 'ref', 'branch', 'commit'].includes(name);
  }
  if (node.type === 'git_publish') {
    return ['repository', 'branch', 'commit', 'pushed', 'changed'].includes(name);
  }
  return false;
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

function declaredReferenceName(
  referenceName: string,
  declared: Record<string, unknown> | undefined,
): string {
  if (!declared) return referenceName;
  if (Object.hasOwn(declared, referenceName)) return referenceName;
  return referenceName.split('.')[0] ?? referenceName;
}

function workflowContextRef(entry: string | WorkflowContextReference): string {
  return typeof entry === 'string'
    ? entry
    : (entry.ref ?? entry.source ?? entry.package ?? entry.artifact ?? '');
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
