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

  it('accepts structured argv shell nodes', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: argv-shell
nodes:
  proof:
    type: shell
    argv:
      - npm
      - test
      - "--"
      - "{{ inputs.target }}"
`,
      '/tmp/workflow.yaml',
    );

    const proof = parsed.definition.nodes.proof;
    expect(proof?.type).toBe('shell');
    if (proof?.type === 'shell') {
      expect(proof.argv).toEqual(['npm', 'test', '--', '{{ inputs.target }}']);
      expect(proof.command).toBeUndefined();
    }
  });

  it('requires shell nodes to set command or argv, but not both', () => {
    expect(() =>
      parseWorkflow(
        `
schema: viewport.workflow/v1
name: missing-shell-command
nodes:
  proof:
    type: shell
`,
        '/tmp/workflow.yaml',
      ),
    ).toThrow(/must set command or argv/);

    expect(() =>
      parseWorkflow(
        `
schema: viewport.workflow/v1
name: duplicate-shell-command
nodes:
  proof:
    type: shell
    command: npm test
    argv:
      - npm
      - test
`,
        '/tmp/workflow.yaml',
      ),
    ).toThrow(/must set command or argv, not both/);
  });

  it('accepts Slack source-accepted and inbox notification config objects', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: slack-notification-proof
notifications:
  sourceAccepted:
    enabled: true
    provider: slack
    credential_ref: slack/support
    delivery: source_thread
    template: "Viewport accepted {{ run.url }}"
    onFailure: continue
  inbox:
    slack:
      enabled: true
      credential_ref: slack/support
      delivery:
        - source_thread
        - channel
      events:
        - inbox.approval_needed
        - inbox.plan_review_requested
      channel: C0123456789
      template: "{{ item.title }} needs review: {{ item.url }}"
nodes:
  proof:
    type: shell
    command: echo ok
`,
      '/tmp/workflow.yaml',
    );

    expect(parsed.definition.notifications?.sourceAccepted).toMatchObject({
      enabled: true,
      provider: 'slack',
      credential_ref: 'slack/support',
    });
    expect(parsed.definition.notifications?.inbox).toMatchObject({
      slack: {
        delivery: ['source_thread', 'channel'],
        channel: 'C0123456789',
      },
    });
  });

  it('accepts stable action proposal keys for brokered provider actions', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: linear-brokered-comment
nodes:
  post_comment:
    type: action
    adapter: linear
    action: comment_issue
    proposalKey: linear.comment_issue
    requiresApproval: true
    idempotencyKey: linear:{{ inputs.issue_id }}:comment
    with:
      issue_id: "{{ inputs.issue_id }}"
      body: "Viewport proof comment"
`,
      '/tmp/workflow.yaml',
    );

    expect(parsed.definition.nodes.post_comment?.type).toBe('action');
    if (parsed.definition.nodes.post_comment?.type !== 'action') return;
    expect(parsed.definition.nodes.post_comment.proposalKey).toBe('linear.comment_issue');
    expect(workflowNodeOrder(parsed.definition)).toEqual(['post_comment']);
  });

  it('accepts json workflow inputs with structured defaults', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: integration-context
inputs:
  integration_event:
    type: json
    required: true
    default:
      provider: github
      payload:
        number: 42
        labels:
          - needs-review
nodes:
  proof:
    type: shell
    command: echo ok
`,
      '/tmp/workflow.yaml',
    );

    expect(parsed.definition.inputs?.integration_event?.type).toBe('json');
    expect(parsed.definition.inputs?.integration_event?.default).toMatchObject({
      provider: 'github',
      payload: { number: 42, labels: ['needs-review'] },
    });
  });

  it('accepts declarative context handles on workflow documents', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: context-aware-review
context:
  - context://team/release-standards
  - ref: context://resource/nonblocking-notes
    as: notes
    required: false
    refresh: before_run
nodes:
  proof:
    type: shell
    command: echo ok
`,
      '/tmp/workflow.yaml',
    );

    expect(parsed.definition.context?.[0]).toBe('context://team/release-standards');
    expect(parsed.definition.context?.[1]).toMatchObject({
      ref: 'context://resource/nonblocking-notes',
      as: 'notes',
      required: false,
      refresh: 'before_run',
    });
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

  it('rejects condition branches that reference missing nodes', () => {
    expect(() =>
      parseWorkflow(
        `
schema: viewport.workflow/v1
name: broken-condition
nodes:
  choose:
    type: condition
    expression: inputs.kind = "bug"
    then: [fix_bug]
    else: [missing_docs]
  fix_bug:
    type: shell
    needs: [choose]
    command: printf fixed
`,
        '/tmp/workflow.yaml',
      ),
    ).toThrow(/condition node choose references missing node missing_docs/);
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

  it('accepts the production workflow contract used by hosted workflow definitions', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: payments/jira-bug-autofix
title: Jira bug autofix
description: Route a Jira bug to a private runner, produce PR evidence, gate side effects, and audit the result.
triggers:
  - type: webhook
    title: Jira bug created
    provider: jira
    route: payments-jira
    eventTypes:
      - issue_created
    signature:
      algorithm: hmac-sha256
      header: X-Viewport-Signature
      timestampHeader: X-Viewport-Timestamp
      toleranceSeconds: 300
    map:
      issue_key: payload.issue.key
      summary: payload.issue.fields.summary
runner:
  kind: self_hosted_runner
  target: self_hosted
  labels:
    - payments-vps
  capabilities:
    - agent.prompt
    - files.write
    - shell
    - network.egress
  leaseSeconds: 900
policies:
  run:
    allowed:
      - team:payments
    requireOnlineRunner: true
  approve:
    allowed:
      - team:payments-reviewers
    minApprovals: 1
  sideEffects:
    requireApproval: true
    allowedAdapters:
      - github
      - jira
  budget:
    maxTokens: 100000
    maxCostUsd: 25
    approvalThresholds:
      tokens: 75000
      costUsd: 10
notifications:
  inbox:
    - approval_requested
    - run_failed
  email:
    - run_failed
dataCapture:
  logs: compact
  artifacts: true
  contextEvidence: true
  approvalPackets: true
context:
  - ref: context://team/payment-guidelines
    as: payment_guidelines
    refresh: before_run
nodes:
  attach_context:
    type: context
    query: Find payment checkout rules relevant to {{ inputs.summary }}
  investigate:
    type: agent
    needs:
      - attach_context
    agent: codex
    model: gpt-5.5
    prompt: Investigate {{ inputs.issue_key }} and propose the smallest safe fix.
    outputs:
      finding:
        type: string
  tests:
    type: shell
    needs:
      - investigate
    command: npm test -- discount
  review_gate:
    type: approval
    needs:
      - tests
    prompt: Approve PR creation and Jira side effects for {{ inputs.issue_key }}?
  create_pr:
    type: action
    needs:
      - review_gate
    adapter: github
    action: pull_request.create
    requiresApproval: true
    idempotencyKey: pr:{{ inputs.issue_key }}
    with:
      title: Fix {{ inputs.issue_key }}
  jira_update:
    type: action
    needs:
      - create_pr
    adapter: jira
    action: issue.transition
    requiresApproval: true
    idempotencyKey: jira:{{ inputs.issue_key }}
`,
      '/tmp/workflow.yaml',
    );

    expect(parsed.definition.triggers?.[0]?.type).toBe('webhook');
    expect(parsed.definition.runner?.kind).toBe('self_hosted_runner');
    expect(parsed.definition.policies?.sideEffects?.allowedAdapters).toEqual(['github', 'jira']);
    expect(parsed.definition.policies?.budget?.maxTokens).toBe(100000);
    expect(parsed.definition.policies?.budget?.approvalThresholds?.costUsd).toBe(10);
    expect(parsed.definition.notifications?.inbox).toContain('approval_requested');
    expect(parsed.definition.dataCapture?.approvalPackets).toBe(true);
    expect(parsed.definition.nodes.investigate?.type).toBe('agent');
    expect(parsed.definition.nodes.create_pr?.type).toBe('action');
    expect(workflowNodeOrder(parsed.definition)).toEqual([
      'attach_context',
      'investigate',
      'tests',
      'review_gate',
      'create_pr',
      'jira_update',
    ]);
  });

  it('accepts the shared Jira autofix golden workflow fixture', async () => {
    const workflowPath = path.resolve('tests/fixtures/workflows/jira-autofix-golden.yaml');
    const parsed = parseWorkflow(await fs.readFile(workflowPath, 'utf-8'), workflowPath);

    expect(parsed.definition.name).toBe('payments/jira-autofix');
    expect(parsed.definition.runner?.target).toBe('self_hosted');
    expect(parsed.definition.requires?.agents).toEqual(['codex']);
    expect(parsed.definition.requires?.integrations).toEqual(['github', 'jira']);
    expect(parsed.definition.nodes.open_pr?.type).toBe('action');
    expect(parsed.definition.nodes.open_pr?.policy?.reason).toBe(
      'Payment code changes require a human reviewer before a PR is opened.',
    );
    expect(parsed.definition.nodes.update_jira?.type).toBe('action');
    expect(workflowNodeOrder(parsed.definition)).toEqual([
      'gather_context',
      'investigate',
      'tests',
      'open_pr',
      'update_jira',
    ]);
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

  it('accepts executor requirements and explicit capability requests', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: executor-contract
executor:
  targets:
    - local_private
    - managed
  defaultTarget: local_private
  capabilities:
    - shell
    - worktree
    - agent.prompt
capabilityRequests:
  - type: network_egress
    host: api.github.com
    reason: Read pull request metadata without embedding credentials in YAML.
  - type: secret
    ref: github/token
    reason: Authenticate GitHub API requests through a runtime secret handle.
  - type: write_scope
    path: reports/
    reason: Persist workflow-generated review summaries.
nodes:
  inspect:
    type: shell
    command: git status --short
`,
      '/tmp/workflow.yaml',
    );

    expect(parsed.definition.executor?.defaultTarget).toBe('local_private');
    expect(parsed.definition.executor?.capabilities).toContain('agent.prompt');
    expect(parsed.definition.capabilityRequests?.[0]).toMatchObject({
      type: 'network_egress',
      host: 'api.github.com',
    });
  });

  it('rejects mismatched executor defaults and secrets embedded in capability requests', () => {
    expect(() =>
      parseWorkflow(
        `
schema: viewport.workflow/v1
name: bad-executor-contract
executor:
  targets:
    - local_private
  defaultTarget: managed
nodes:
  inspect:
    type: shell
    command: git status --short
`,
        '/tmp/workflow.yaml',
      ),
    ).toThrow(/defaultTarget/);

    expect(() =>
      parseWorkflow(
        `
schema: viewport.workflow/v1
name: bad-capability-request
capabilityRequests:
  - type: secret
    ref: github/token
    value: raw-secret
    reason: This should use a secret handle only.
nodes:
  inspect:
    type: shell
    command: git status --short
`,
        '/tmp/workflow.yaml',
      ),
    ).toThrow(/Unrecognized key/);
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
        executionMode: review
        allowedTools:
          - Read
        timeoutSeconds: 120
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
      expect(supervisor.agents?.reviewer?.executionMode).toBe('review');
      expect(supervisor.agents?.reviewer?.allowedTools).toEqual(['Read']);
      expect(supervisor.agents?.reviewer?.timeoutSeconds).toBe(120);
      expect(supervisor.inlineAgentFailurePolicy).toBe('continue');
    }
  });

  it('accepts a codex claude codex ping pong handoff workflow', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: team/ping-pong
inputs:
  feature:
    type: string
nodes:
  codex_backend:
    type: agent
    agent: codex
    model: gpt-5.5
    prompt: Build backend contract for {{ inputs.feature }}.
    handoff:
      artifact: backend-contract.md
  claude_ui:
    type: agent
    needs: [codex_backend]
    agent: claude
    model: sonnet
    prompt: Use backend handoff {{ nodes.codex_backend.output }} and build the UI.
    handoff:
      artifact: ui-implementation.md
  codex_review:
    type: agent
    needs: [claude_ui]
    agent: codex
    model: gpt-5.5
    prompt: Review UI {{ nodes.claude_ui.output }} against backend {{ nodes.codex_backend.output }}.
  human_gate:
    type: approval
    needs: [codex_review]
    prompt: Approve ping pong result for {{ inputs.feature }}?
`,
      '/tmp/workflow.yaml',
    );

    expect(workflowNodeOrder(parsed.definition)).toEqual([
      'codex_backend',
      'claude_ui',
      'codex_review',
      'human_gate',
    ]);
    expect(parsed.definition.nodes.claude_ui?.type).toBe('agent');
    if (parsed.definition.nodes.claude_ui?.type === 'agent') {
      expect(parsed.definition.nodes.claude_ui.handoff?.artifact).toBe('ui-implementation.md');
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

  it('parses prompt effort as first-class runtime config', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: prompt-effort
nodes:
  plan:
    type: prompt
    agent: claude
    model: opus
    effort: high
    prompt: Draft the plan.
`,
      '/tmp/workflow.yaml',
    );

    expect(parsed.definition.nodes.plan?.type).toBe('prompt');
    expect(parsed.definition.nodes.plan?.effort).toBe('high');
  });

  it('parses prompt execution mode and allowed tools as runtime config', () => {
    const parsed = parseWorkflow(
      `
schema: viewport.workflow/v1
name: prompt-execution-mode-proof
nodes:
  draft_plan:
    type: prompt
    agent: claude
    model: sonnet
    executionMode: plan
    allowedTools: []
    prompt: Draft a plan.
  inspect:
    type: prompt
    needs: [draft_plan]
    agent: claude
    executionMode: read_only
    allowedTools:
      - Read
      - Grep
      - Glob
    prompt: Inspect only.
  execute:
    type: agent
    needs: [inspect]
    agent: claude
    executionMode: implement
    allowedTools:
      - Edit
    prompt: Implement the change.
  report:
    type: prompt
    needs: [execute]
    agent: claude
    executionMode: review
    outputSchema:
      findings:
        type: json
        requirement: required
        extract: json.findings
        outputSchema:
          type: array
    prompt: Return JSON findings.
`,
      '/tmp/workflow.yaml',
    );

    const draftPlan = parsed.definition.nodes.draft_plan;
    const inspect = parsed.definition.nodes.inspect;
    expect(draftPlan?.type).toBe('prompt');
    expect(inspect?.type).toBe('prompt');
    if (draftPlan?.type !== 'prompt' || inspect?.type !== 'prompt') return;
    expect(draftPlan.executionMode).toBe('plan');
    expect(draftPlan.allowedTools).toEqual([]);
    expect(inspect.executionMode).toBe('read_only');
    expect(inspect.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    const execute = parsed.definition.nodes.execute;
    expect(execute?.type).toBe('agent');
    if (execute?.type === 'agent') {
      expect(execute.executionMode).toBe('implement');
      expect(execute.allowedTools).toEqual(['Edit']);
    }
    const report = parsed.definition.nodes.report;
    expect(report?.type).toBe('prompt');
    if (report?.type === 'prompt') {
      expect(report.outputSchema?.findings).toMatchObject({
        type: 'json',
        requirement: 'required',
        extract: 'json.findings',
        outputSchema: { type: 'array' },
      });
    }
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
