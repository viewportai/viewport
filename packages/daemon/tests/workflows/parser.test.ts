import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseWorkflow,
  parseWorkflowFile,
  validateWorkflowText,
  workflowNodeOrder,
} from '../../src/workflows/parser.js';

const validWorkflow = `
schema: viewport.workflow/v1
name: pr-review
title: PR Review
inputs:
  pr:
    type: string
    required: true
requires:
  agents:
    - codex
  tools:
    - git
nodes:
  inspect:
    type: shell
    command: git status --short
  review:
    type: prompt
    needs: [inspect]
    agent: codex
    prompt: Review {{ inputs.pr }}
`;

describe('workflow parser', () => {
  it('parses valid workflow yaml and produces a deterministic digest', () => {
    const first = parseWorkflow(validWorkflow, '/tmp/workflow.yaml');
    const second = parseWorkflow(validWorkflow, '/tmp/workflow.yaml');

    expect(first.definition.name).toBe('pr-review');
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.digest).toBe(second.digest);
    expect(workflowNodeOrder(first.definition)).toEqual(['inspect', 'review']);
  });

  it('rejects missing dependency nodes', () => {
    expect(() =>
      parseWorkflow(
        `
schema: viewport.workflow/v1
name: broken
nodes:
  review:
    type: prompt
    needs: [missing]
    prompt: test
`,
        '/tmp/workflow.yaml',
      ),
    ).toThrow(/depends on missing node/);
  });

  it('rejects unsupported node types', () => {
    expect(() =>
      parseWorkflow(
        `
schema: viewport.workflow/v1
name: broken
nodes:
  custom:
    type: magic
`,
        '/tmp/workflow.yaml',
      ),
    ).toThrow(/Invalid workflow/);
  });

  it('returns structured validation errors without throwing', () => {
    const result = validateWorkflowText('not: a workflow', '/tmp/workflow.yaml');

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toMatch(/Invalid workflow/);
  });

  it('rejects dependency cycles', () => {
    expect(() =>
      parseWorkflow(
        `
schema: viewport.workflow/v1
name: cycle
nodes:
  first:
    type: shell
    command: echo first
    needs: [second]
  second:
    type: shell
    command: echo second
    needs: [first]
`,
        '/tmp/workflow.yaml',
      ),
    ).toThrow(/dependency cycle/);
  });

  it('requires node output references to depend on the producing node', () => {
    expect(() =>
      parseWorkflow(
        `
schema: viewport.workflow/v1
name: output-reference
nodes:
  inspect:
    type: shell
    command: printf ok
  review:
    type: prompt
    prompt: Review {{ nodes.inspect.output }}
`,
        '/tmp/workflow.yaml',
      ),
    ).toThrow(/references inspect output but does not depend on it/);
  });

  it('accepts explicit node output dataflow references', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: output-reference
nodes:
  inspect:
    type: shell
    command: printf ok
  review:
    type: prompt
    needs: [inspect]
    prompt: Review {{ nodes.inspect.output }}
`,
      '/tmp/workflow.yaml',
    );

    expect(parsed.definition.nodes.review?.type).toBe('prompt');
  });

  it('parses workflows from disk with resolved source paths', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-parser-'));
    try {
      const workflowPath = path.join(dir, 'workflow.yaml');
      await fs.writeFile(workflowPath, validWorkflow, 'utf-8');

      const parsed = await parseWorkflowFile(workflowPath);

      expect(parsed.sourcePath).toBe(path.resolve(workflowPath));
      expect(parsed.definition.name).toBe('pr-review');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
