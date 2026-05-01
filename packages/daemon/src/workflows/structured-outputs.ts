import jsonata from 'jsonata';
import type { WorkflowNode, WorkflowNodeRunState, WorkflowOutputDefinition } from './types.js';

/**
 * After a node finishes running, populate `state.outputs` based on the node's
 * declared output schema and the captured `state.output` text.
 *
 * Each output can optionally declare `extract: <jsonata>`. Extractors evaluate
 * against `{ output, json }`, where `output` is the bulk text and `json` is the
 * parsed bulk output when valid. Without `extract`, the whole bulk text is used.
 *
 * Coercion rules per declared `type`:
 *   - `string` → strings passthrough; objects/arrays stringify as JSON.
 *   - `json` → extracted values passthrough; otherwise JSON.parse on text.
 *   - `number` → Number(text); NaN becomes null.
 *   - `boolean` → loose-truthy parse (`true`, `1`, `yes`, `pass`).
 *   - `file` / `artifact` → the path the node declared, if any. The artifact
 *     collector will populate `run.artifacts` for the actual file content.
 */
export async function captureNodeStructuredOutputs(
  state: WorkflowNodeRunState,
  node: WorkflowNode,
): Promise<void> {
  if (!node.outputs || Object.keys(node.outputs).length === 0) return;

  const text = state.output ?? '';
  const parsedJson = parseJson(text);
  const collected: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(node.outputs)) {
    const source = await outputSource(text, parsedJson, definition);
    collected[name] = coerceOutputValue(source, definition);
  }
  state.outputs = collected;
}

async function outputSource(
  text: string,
  parsedJson: unknown,
  definition: WorkflowOutputDefinition,
): Promise<unknown> {
  if (!definition.extract) return text;

  try {
    return await jsonata(definition.extract).evaluate({
      output: text,
      json: parsedJson,
    });
  } catch {
    return null;
  }
}

function coerceOutputValue(value: unknown, definition: WorkflowOutputDefinition): unknown {
  switch (definition.type) {
    case 'string':
      return stringifyValue(value);
    case 'json': {
      if (definition.extract) return value ?? null;
      const parsed = parseJson(stringifyValue(value));
      return parsed === undefined ? stringifyValue(value) : parsed;
    }
    case 'number': {
      const number = Number(stringifyValue(value).trim());
      return Number.isFinite(number) ? number : null;
    }
    case 'boolean': {
      const normalized = stringifyValue(value).trim().toLowerCase();
      return ['true', '1', 'yes', 'y', 'pass', 'passed', 'ok'].includes(normalized);
    }
    case 'file':
    case 'artifact':
      // The artifact-collector populates run.artifacts with the resolved path;
      // the structured output here exposes the bulk text for now.
      return stringifyValue(value) || null;
    default:
      return stringifyValue(value);
  }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
