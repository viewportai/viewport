import { describe, expect, it } from 'vitest';
import { captureNodeStructuredOutputs } from '../../src/workflows/structured-outputs.js';
import type { WorkflowNode, WorkflowNodeRunState } from '../../src/workflows/types.js';

function makeShellNode(
  outputs: Record<string, { type: 'string' | 'number' | 'boolean' | 'json' }>,
): WorkflowNode {
  return {
    type: 'shell',
    command: 'noop',
    outputs,
  };
}

function makeState(output: string): WorkflowNodeRunState {
  return { id: 'collect', type: 'shell', status: 'completed', output };
}

describe('structured outputs', () => {
  it('passes through string outputs', () => {
    const state = makeState('repo is dirty');
    captureNodeStructuredOutputs(state, makeShellNode({ summary: { type: 'string' } }));
    expect(state.outputs).toEqual({ summary: 'repo is dirty' });
  });

  it('parses JSON outputs and falls back to raw text on failure', () => {
    const okState = makeState('{"verdict":"ship","risks":2}');
    captureNodeStructuredOutputs(okState, makeShellNode({ payload: { type: 'json' } }));
    expect(okState.outputs?.['payload']).toEqual({ verdict: 'ship', risks: 2 });

    const fallbackState = makeState('not json {lol}');
    captureNodeStructuredOutputs(fallbackState, makeShellNode({ payload: { type: 'json' } }));
    expect(fallbackState.outputs?.['payload']).toBe('not json {lol}');
  });

  it('coerces number outputs and yields null when unparseable', () => {
    const ok = makeState('42');
    captureNodeStructuredOutputs(ok, makeShellNode({ count: { type: 'number' } }));
    expect(ok.outputs?.['count']).toBe(42);

    const bad = makeState('not a number');
    captureNodeStructuredOutputs(bad, makeShellNode({ count: { type: 'number' } }));
    expect(bad.outputs?.['count']).toBeNull();
  });

  it('coerces boolean outputs from common truthy strings', () => {
    const truthy = makeState('yes');
    captureNodeStructuredOutputs(truthy, makeShellNode({ ok: { type: 'boolean' } }));
    expect(truthy.outputs?.['ok']).toBe(true);

    const falsy = makeState('no');
    captureNodeStructuredOutputs(falsy, makeShellNode({ ok: { type: 'boolean' } }));
    expect(falsy.outputs?.['ok']).toBe(false);
  });

  it('does nothing when the node has no declared outputs', () => {
    const state = makeState('output text');
    captureNodeStructuredOutputs(state, { type: 'shell', command: 'noop' });
    expect(state.outputs).toBeUndefined();
  });
});
