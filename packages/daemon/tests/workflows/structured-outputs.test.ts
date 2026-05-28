import { describe, expect, it } from 'vitest';
import {
  captureNodeStructuredOutputs,
  WorkflowStructuredOutputError,
} from '../../src/workflows/structured-outputs.js';
import type { WorkflowNode, WorkflowNodeRunState } from '../../src/workflows/types.js';

function makeShellNode(
  outputs: Record<
    string,
    {
      type: 'string' | 'number' | 'boolean' | 'json';
      requirement?: 'required' | 'optional' | 'unsupported';
      extract?: string;
    }
  >,
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
  it('passes through string outputs', async () => {
    const state = makeState('repo is dirty');
    await captureNodeStructuredOutputs(state, makeShellNode({ summary: { type: 'string' } }));
    expect(state.outputs).toEqual({ summary: 'repo is dirty' });
  });

  it('parses JSON outputs and falls back to raw text on failure', async () => {
    const okState = makeState('{"verdict":"ship","risks":2}');
    await captureNodeStructuredOutputs(okState, makeShellNode({ payload: { type: 'json' } }));
    expect(okState.outputs?.['payload']).toEqual({ verdict: 'ship', risks: 2 });

    const fallbackState = makeState('not json {lol}');
    await captureNodeStructuredOutputs(fallbackState, makeShellNode({ payload: { type: 'json' } }));
    expect(fallbackState.outputs?.['payload']).toBe('not json {lol}');
  });

  it('extracts named values from JSON output before coercion', async () => {
    const state = makeState('{"summary":"needs tests","count":2,"ok":"yes"}');
    await captureNodeStructuredOutputs(
      state,
      makeShellNode({
        summary: { type: 'string', extract: 'json.summary' },
        count: { type: 'number', extract: 'json.count' },
        ok: { type: 'boolean', extract: 'json.ok' },
      }),
    );

    expect(state.outputs).toEqual({
      summary: 'needs tests',
      count: 2,
      ok: true,
    });
  });

  it('coerces number outputs and yields null when unparseable', async () => {
    const ok = makeState('42');
    await captureNodeStructuredOutputs(ok, makeShellNode({ count: { type: 'number' } }));
    expect(ok.outputs?.['count']).toBe(42);

    const bad = makeState('not a number');
    await captureNodeStructuredOutputs(bad, makeShellNode({ count: { type: 'number' } }));
    expect(bad.outputs?.['count']).toBeNull();
  });

  it('coerces boolean outputs from common truthy strings', async () => {
    const truthy = makeState('yes');
    await captureNodeStructuredOutputs(truthy, makeShellNode({ ok: { type: 'boolean' } }));
    expect(truthy.outputs?.['ok']).toBe(true);

    const falsy = makeState('no');
    await captureNodeStructuredOutputs(falsy, makeShellNode({ ok: { type: 'boolean' } }));
    expect(falsy.outputs?.['ok']).toBe(false);
  });

  it('does nothing when the node has no declared outputs', async () => {
    const state = makeState('output text');
    await captureNodeStructuredOutputs(state, { type: 'shell', command: 'noop' });
    expect(state.outputs).toBeUndefined();
  });

  it('fails required malformed JSON outputs before exposing values', async () => {
    const state = makeState('not json {lol}');
    await expect(
      captureNodeStructuredOutputs(
        state,
        makeShellNode({ payload: { type: 'json', requirement: 'required' } }),
      ),
    ).rejects.toBeInstanceOf(WorkflowStructuredOutputError);

    expect(state.status).toBe('failed');
    expect(state.error).toContain('Required structured output payload is invalid');
    expect(state.outputs).toEqual({});
    expect(state.metadata?.['structuredOutputs']).toMatchObject({
      schema: 'viewport.structured_outputs/v1',
      outputs: {
        payload: {
          requirement: 'required',
          status: 'invalid',
          reason: 'malformed_json',
        },
      },
    });
  });

  it('records degraded receipts for unsupported optional structured outputs', async () => {
    const state = makeState('plain text');
    await captureNodeStructuredOutputs(
      state,
      makeShellNode({ payload: { type: 'json', requirement: 'unsupported' } }),
    );

    expect(state.outputs).toEqual({});
    expect(state.metadata?.['structuredOutputs']).toMatchObject({
      outputs: {
        payload: {
          requirement: 'unsupported',
          status: 'degraded',
          reason: 'structured_output_unsupported',
        },
      },
    });
  });
});
