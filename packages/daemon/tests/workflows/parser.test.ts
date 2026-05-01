import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseWorkflow,
  parseWorkflowFile,
  validateWorkflowText,
  WORKFLOW_SCHEMA_VERSION,
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

  it('exports the schema version used by workflow documents', () => {
    expect(WORKFLOW_SCHEMA_VERSION).toBe('viewport.workflow/v1');
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

  it('accepts mature workflow schema fields without losing deterministic parsing', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: rich-schema
nodes:
  collect:
    type: shell
    command: npm test
    timeoutSeconds: 120
    retry:
      maxAttempts: 2
      backoffSeconds: 5
    env:
      CI_TOKEN:
        secret: github/ci-token
    outputs:
      summary:
        type: string
        description: Short test summary.
    artifacts:
      report:
        path: artifacts/test-report.md
        type: report
  review:
    type: prompt
    needs: [collect]
    agent: codex
    provider: openai
    model: gpt-5.4
    policy:
      onFailure: halt
      approvalRequired: true
    prompt: Review {{ nodes.collect.outputs.summary }} and {{ artifacts.collect.report }}.
`,
      '/tmp/workflow.yaml',
    );

    expect(parsed.definition.nodes.collect?.outputs?.summary?.type).toBe('string');
    expect(parsed.definition.nodes.review?.type).toBe('prompt');
  });

  it('accepts integration and secret capability requirements', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: integration-workflow
requires:
  integrations:
    - github
  secrets:
    - github/token
nodes:
  inspect:
    type: shell
    command: git status --short
`,
      '/tmp/workflow.yaml',
    );

    expect(parsed.definition.requires?.integrations).toEqual(['github']);
    expect(parsed.definition.requires?.secrets).toEqual(['github/token']);
  });

  it('accepts workflow-scoped prompt hook rules', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: hook-rules
nodes:
  review:
    type: prompt
    agent: codex
    prompt: Review the diff.
    hooks:
      PreToolUse:
        record: true
      PostToolUseFailure:
        record: true
      PermissionRequest:
        tools:
          Bash:
            behavior: deny
            message: Bash commands require a different workflow.
        default:
          behavior: allow
`,
      '/tmp/workflow.yaml',
    );

    const review = parsed.definition.nodes.review;
    expect(review?.type).toBe('prompt');
    if (review?.type === 'prompt') {
      expect(review.hooks?.PermissionRequest).toBeDefined();
      expect(review.hooks?.PreToolUse?.record).toBe(true);
    }
  });

  it('requires explicit dataflow edges for nested prompt templates', () => {
    expect(() =>
      parseWorkflow(
        `
schema: viewport.workflow/v1
name: nested-dataflow
nodes:
  inspect:
    type: shell
    command: echo ok
  loop_review:
    type: loop
    foreach: "[1]"
    maxIterations: 1
    body:
      type: prompt
      prompt: Review {{ nodes.inspect.output }}
`,
        '/tmp/workflow.yaml',
      ),
    ).toThrow(/does not depend/);

    expect(() =>
      parseWorkflow(
        `
schema: viewport.workflow/v1
name: reject-dataflow
nodes:
  inspect:
    type: shell
    command: echo ok
  approve:
    type: approval
    prompt: Approve
    onReject:
      prompt: Explain {{ nodes.inspect.output }}
`,
        '/tmp/workflow.yaml',
      ),
    ).toThrow(/does not depend/);
  });

  it('rejects workflow hook rules that cannot make a permission decision', () => {
    expect(() =>
      parseWorkflow(
        `
schema: viewport.workflow/v1
name: bad-hook-rules
nodes:
  review:
    type: prompt
    prompt: Review the diff.
    hooks:
      PermissionRequest: {}
`,
        '/tmp/workflow.yaml',
      ),
    ).toThrow(/Set default or tools/);
  });

  it('accepts inline supervisor agent definitions on prompt nodes', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: inline-agents
nodes:
  inspect:
    type: shell
    command: printf ok
    outputs:
      summary:
        type: string
  supervisor:
    type: prompt
    needs: [inspect]
    agent: claude
    inlineAgentFailurePolicy: continue
    prompt: Synthesize the inline agent findings.
    agents:
      reviewer:
        title: Reviewer
        agent: codex
        model: gpt-5.4
        prompt: Review {{ nodes.inspect.outputs.summary }}.
      tester:
        prompt: Design tests for {{ nodes.inspect.output }}.
`,
      '/tmp/workflow.yaml',
    );

    const supervisor = parsed.definition.nodes.supervisor;
    expect(supervisor?.type).toBe('prompt');
    if (supervisor?.type === 'prompt') {
      expect(Object.keys(supervisor.agents ?? {})).toEqual(['reviewer', 'tester']);
      expect(supervisor.agents?.reviewer?.agent).toBe('codex');
      expect(supervisor.inlineAgentFailurePolicy).toBe('continue');
    }
  });

  it('accepts check, policy, human review, and schedule gates', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: gate-schema
nodes:
  check_context:
    type: gate
    gate:
      type: check
      expression: "{{ inputs.ready }}"
  policy_gate:
    type: gate
    needs: [check_context]
    gate:
      type: policy
      expression: "true"
  review_gate:
    type: gate
    needs: [policy_gate]
    gate:
      type: human_review
      prompt: Approve release summary.
  timed_gate:
    type: gate
    needs: [review_gate]
    gate:
      type: schedule
      waitUntil: "2000-01-01T00:00:00.000Z"
`,
      '/tmp/workflow.yaml',
    );

    expect(parsed.definition.nodes.check_context?.type).toBe('gate');
    expect(workflowNodeOrder(parsed.definition)).toEqual([
      'check_context',
      'policy_gate',
      'review_gate',
      'timed_gate',
    ]);
  });

  it('requires named outputs and artifacts to be declared', () => {
    expect(() =>
      parseWorkflow(
        `
schema: viewport.workflow/v1
name: undeclared-dataflow
nodes:
  collect:
    type: shell
    command: npm test
  review:
    type: prompt
    needs: [collect]
    prompt: Review {{ nodes.collect.outputs.summary }} and {{ artifacts.collect.report }}.
`,
        '/tmp/workflow.yaml',
      ),
    ).toThrow(/undeclared output/);
  });

  it('allows nested reads from declared structured JSON outputs', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: nested-structured-dataflow
nodes:
  collect:
    type: shell
    command: collect
    outputs:
      payload:
        type: json
  review:
    type: prompt
    needs: [collect]
    prompt: Review {{ nodes.collect.outputs.payload.repo }} at {{ nodes.collect.outputs.payload.meta.priority }}.
`,
      '/tmp/workflow.yaml',
    );

    expect(parsed.definition.nodes.review?.type).toBe('prompt');
  });

  it('rejects env entries that mix literal values and secret references', () => {
    expect(() =>
      parseWorkflow(
        `
schema: viewport.workflow/v1
name: bad-env
nodes:
  collect:
    type: shell
    command: npm test
    env:
      BAD:
        value: literal
        secret: secret/name
`,
        '/tmp/workflow.yaml',
      ),
    ).toThrow(/Set exactly one/);
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
