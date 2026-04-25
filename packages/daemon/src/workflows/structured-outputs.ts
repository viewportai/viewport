import type { WorkflowNode, WorkflowNodeRunState, WorkflowOutputDefinition } from './types.js';

/**
 * After a node finishes running, populate `state.outputs` based on the node's
 * declared output schema and the captured `state.output` text.
 *
 * Coercion rules per declared `type`:
 *   - `string` → the captured text passthrough.
 *   - `json` → JSON.parse on the trimmed text. Falls back to the raw text if
 *     parsing fails (so JSONata refs still see *something*; the run is not
 *     hard-failed for output coercion problems).
 *   - `number` → Number(text); NaN becomes null.
 *   - `boolean` → loose-truthy parse (`true`, `1`, `yes`, `pass`).
 *   - `file` / `artifact` → the path the node declared, if any. The artifact
 *     collector will populate `run.artifacts` for the actual file content.
 *
 * Future phases will add per-output `extract:` declarations (regex, JSONPath,
 * jq) so a node can pluck specific values out of its bulk output text.
 */
export function captureNodeStructuredOutputs(
  state: WorkflowNodeRunState,
  node: WorkflowNode,
): void {
  if (!node.outputs || Object.keys(node.outputs).length === 0) return;

  const text = state.output ?? '';
  const collected: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(node.outputs)) {
    collected[name] = coerceOutputValue(text, definition);
  }
  state.outputs = collected;
}

function coerceOutputValue(text: string, definition: WorkflowOutputDefinition): unknown {
  switch (definition.type) {
    case 'string':
      return text;
    case 'json': {
      const trimmed = text.trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        return text;
      }
    }
    case 'number': {
      const value = Number(text.trim());
      return Number.isFinite(value) ? value : null;
    }
    case 'boolean': {
      const normalized = text.trim().toLowerCase();
      return ['true', '1', 'yes', 'y', 'pass', 'passed', 'ok'].includes(normalized);
    }
    case 'file':
    case 'artifact':
      // The artifact-collector populates run.artifacts with the resolved path;
      // the structured output here exposes the bulk text for now.
      return text || null;
    default:
      return text;
  }
}
