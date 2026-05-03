import { describe, expect, it } from 'vitest';
import {
  buildExpressionContext,
  evaluateConditionExpression,
  evaluateExpression,
  renderTemplateString,
  WorkflowExpressionError,
} from '../../src/workflows/expression.js';
import type { WorkflowRunRecord } from '../../src/workflows/types.js';

function makeRun(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  const now = Date.now();
  return {
    id: 'run-1',
    workflowName: 'expression-fixture',
    sourceType: 'viewport_snapshot',
    digest: 'digest',
    schema: 'viewport.workflow/v1',
    yamlSnapshot: '',
    directoryId: 'dir-1',
    directoryPath: '/tmp/expression',
    machineId: 'machine-1',
    initiation: 'cli',
    status: 'running',
    inputs: { focus: 'reliability', threshold: 3 },
    preflight: { ok: true, issues: [] },
    nodes: {
      classify: {
        id: 'classify',
        type: 'shell',
        status: 'completed',
        output: '{"type":"BUG","priority":"P0"}',
        outputs: { result: { type: 'BUG', priority: 'P0' } },
      },
      review: {
        id: 'review',
        type: 'prompt',
        status: 'completed',
        output: 'Review complete: 2 issues found',
        outputs: { findings: 'Review complete: 2 issues found' },
      },
    },
    artifacts: [],
    events: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('expression', () => {
  it('builds a context with inputs and node outputs', () => {
    const context = buildExpressionContext(makeRun());
    expect(context.inputs.focus).toBe('reliability');
    expect(context.nodes.classify?.outputs).toMatchObject({ result: { type: 'BUG' } });
    expect(context.nodes.review?.output).toContain('issues found');
  });

  it('evaluates JSONata expressions over the run context', async () => {
    const context = buildExpressionContext(makeRun());
    expect(await evaluateExpression('inputs.focus', context)).toBe('reliability');
    expect(await evaluateExpression('nodes.classify.outputs.result.type', context)).toBe('BUG');
    expect(await evaluateExpression('nodes.classify.outputs.result.priority = "P0"', context)).toBe(
      true,
    );
  });

  it('exposes structured workflow inputs to JSONata expressions', async () => {
    const context = buildExpressionContext(
      makeRun({
        inputs: {
          integration_event: {
            provider: 'github',
            payload: { number: 42, labels: ['needs-review'] },
          },
        },
      }),
    );

    expect(await evaluateExpression('inputs.integration_event.provider', context)).toBe('github');
    expect(await evaluateExpression('inputs.integration_event.payload.number', context)).toBe(42);
    expect(await evaluateExpression('inputs.integration_event.payload.labels[0]', context)).toBe(
      'needs-review',
    );
  });

  it('treats unmatched paths as falsy in conditions', async () => {
    const context = buildExpressionContext(makeRun());
    expect(await evaluateConditionExpression('nodes.missing.outputs.type', context)).toBe(false);
    expect(await evaluateConditionExpression('inputs.focus = "reliability"', context)).toBe(true);
    expect(await evaluateConditionExpression('inputs.threshold > 5', context)).toBe(false);
    expect(await evaluateConditionExpression('inputs.threshold > 0', context)).toBe(true);
  });

  it('renders templates by interpolating JSONata results', async () => {
    const context = buildExpressionContext(makeRun());
    const result = await renderTemplateString(
      'Focus: {{ inputs.focus }} - Type: {{ nodes.classify.outputs.result.type }}',
      context,
    );
    expect(result).toBe('Focus: reliability - Type: BUG');
  });

  it('JSON-stringifies object/array results inside templates', async () => {
    const context = buildExpressionContext(makeRun());
    const result = await renderTemplateString(
      'Classification payload: {{ nodes.classify.outputs }}',
      context,
    );
    expect(result).toContain('"type":"BUG"');
    expect(result).toContain('"priority":"P0"');
  });

  it('annotates expression errors with the offending expression', async () => {
    const context = buildExpressionContext(makeRun());
    await expect(evaluateExpression('nodes..bad', context)).rejects.toBeInstanceOf(
      WorkflowExpressionError,
    );
  });
});
