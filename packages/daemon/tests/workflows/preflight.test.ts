import { describe, expect, it } from 'vitest';
import { parseWorkflow } from '../../src/workflows/parser.js';
import { preflightWorkflow } from '../../src/workflows/preflight.js';

describe('workflow preflight', () => {
  it('blocks missing agents before execution', async () => {
    const workflow = parseWorkflow(
      `
schema: viewport.workflow/v1
name: needs-agent
requires:
  agents: [claude]
nodes:
  review:
    type: prompt
    agent: claude
    prompt: Review
`,
      '/tmp/workflow.yaml',
    );

    const result = await preflightWorkflow(workflow.definition, {
      availableAgents: () => ['codex'],
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.kind === 'agent')).toBe(true);
  });

  it('blocks prompt nodes that request unavailable agents', async () => {
    const workflow = parseWorkflow(
      `
schema: viewport.workflow/v1
name: node-agent
nodes:
  review:
    type: prompt
    agent: claude
    prompt: Review
`,
      '/tmp/workflow.yaml',
    );

    const result = await preflightWorkflow(workflow.definition, {
      availableAgents: () => ['codex'],
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        kind: 'agent',
        name: 'claude',
      }),
    ]);
  });

  it('blocks inline prompt agents that request unavailable agents', async () => {
    const workflow = parseWorkflow(
      `
schema: viewport.workflow/v1
name: inline-agent
nodes:
  supervisor:
    type: prompt
    agent: claude
    prompt: Synthesize
    agents:
      tester:
        agent: codex
        prompt: Suggest tests
`,
      '/tmp/workflow.yaml',
    );

    const result = await preflightWorkflow(workflow.definition, {
      availableAgents: () => ['claude'],
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        kind: 'agent',
        name: 'codex',
      }),
    ]);
  });

  it('accepts approval nodes as executable gates', async () => {
    const workflow = parseWorkflow(
      `
schema: viewport.workflow/v1
name: approval-proof
nodes:
  gate:
    type: approval
    prompt: Approve release
`,
      '/tmp/workflow.yaml',
    );

    const result = await preflightWorkflow(workflow.definition, {
      availableAgents: () => [],
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('checks required shell tools and rejects unsafe tool names', async () => {
    const workflow = parseWorkflow(
      `
schema: viewport.workflow/v1
name: tools-proof
requires:
  tools:
    - sh
    - "bad tool"
nodes:
  proof:
    type: shell
    command: echo ok
`,
      '/tmp/workflow.yaml',
    );

    const result = await preflightWorkflow(workflow.definition, {
      availableAgents: () => [],
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        kind: 'tool',
        name: 'bad tool',
      }),
    ]);
  });
});
