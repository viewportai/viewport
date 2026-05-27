import { describe, expect, it } from 'vitest';
import { WorkflowRunPlatformSync } from '../../src/workflows/platform-sync.js';
import type { ConfigManager } from '../../src/core/config.js';
import type { WorkflowRunRecord } from '../../src/workflows/types.js';

describe('WorkflowRunPlatformSync', () => {
  it('syncs run state to the runtime workflow API with only new events', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const sync = new WorkflowRunPlatformSync(configManager(), async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const run = workflowRun();
    run.dataCapturePolicy = {
      transcripts: 'excerpt',
      logs: 'content',
      artifacts: 'local_reference',
    };

    await sync.sync(run);
    run.events.push({
      id: 'event-2',
      runId: run.id,
      timestamp: 1_800,
      type: 'node-completed',
      nodeId: 'inspect',
      message: 'Inspect completed',
      data: { exitCode: 0 },
    });
    await sync.sync(run);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      'https://getviewport.test/api/runtime/workspaces/project-1/workflow-runs/platform-run-1/sync',
    );
    expect(calls[0]?.body).toMatchObject({
      credential: 'issue-token',
      runtime_target_id: 'binding-1',
      runtime_run_id: 'runtime-run-1',
      status: 'running',
      started_at: '1970-01-01T00:00:01.500Z',
    });
    expect(calls[0]?.body).not.toHaveProperty('context_receipts_snapshot');
    expect(calls[0]?.body).not.toHaveProperty('project_machine_binding_id');
    expect(calls[0]?.body['events']).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      nodes: [
        {
          node_key: 'inspect',
          output_snapshot: {
            summary: 'git status',
            changedFiles: 1,
          },
          transcript_excerpt: [
            {
              role: 'assistant',
              text: 'Inspected the repository.',
            },
          ],
          metadata: {
            agent: 'codex',
            model: 'gpt-5.4',
            provider: 'openai',
            exitCode: 0,
            inlineAgents: {
              reviewer: {
                status: 'completed',
                output: 'reviewer output',
              },
            },
          },
        },
      ],
    });
    expect(calls[1]?.body['events']).toHaveLength(1);
    expect((calls[1]?.body['events'] as Array<Record<string, unknown>>)[0]?.['type']).toBe(
      'node-completed',
    );
    expect((calls[1]?.body['events'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      runtime_event_id: 'event-2',
    });
  });

  it('syncs durable contract records for local platform-linked runs', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const sync = new WorkflowRunPlatformSync(configManager(), async (_url, init) => {
      calls.push({
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const run = workflowRun();
    run.status = 'completed';
    run.completedAt = 2_000;
    run.nodes.inspect.status = 'completed';
    run.nodes.inspect.completedAt = 2_000;
    run.nodes.inspect.output = 'Found case-sensitive discount lookup and proposed a PR.';
    run.nodes.inspect.approval = {
      prompt: 'Approve GitHub PR side effect?',
      requestedAt: 1_900,
      resolvedAt: 1_950,
      approved: true,
      decision: 'approve',
      executionGrant: {
        schema: 'viewport.execution_grant/v1',
        digest: 'sha256:approved-execution-grant',
        proposal_key: 'github.open_pr',
        approval_decision_key: 'approve-open-pr',
        issued_at: '2026-05-17T10:00:00.000Z',
      },
    };
    run.nodes.inspect.metadata = {
      ...run.nodes.inspect.metadata,
      action: {
        adapter: 'github',
        action: 'open_pr',
        proposalKey: 'github.open_pr',
        status: 'awaiting_approval',
        idempotencyKey: 'jira:PAY-1842:github.open_pr',
        digest: 'sha256:action-proposal-pay1842-open-pr',
        evidenceRefs: ['node:inspect:output'],
        input: {
          repository: 'acme/payments-api',
          title: 'Fix PAY-1842 discount normalization',
        },
      },
    };
    run.contextReceipts = [
      {
        schema: 'viewport.context_receipt/v1',
        package: 'payments.domain-rules',
        requested: 'context://vault/payments',
        resolvedVersion: '2026.05.17',
        provider: 'viewport-vault',
        digest: 'sha256:context-receipt-payments-domain-rules',
        freshness: 'resolved_at_run',
        usedBy: {
          runId: 'runtime-run-1',
          nodeId: 'inspect',
          providerId: 'payments-vault',
          itemId: 'payments.domain-rules',
        },
        resolvedAt: '2026-05-17T10:00:00.000Z',
      },
    ];
    run.events.push({
      id: 'event-action-executed',
      runId: run.id,
      timestamp: 2_000,
      type: 'action-executed',
      nodeId: 'inspect',
      message: 'GitHub PR opened',
      data: {
        action: {
          adapter: 'github',
          action: 'open_pr',
          proposalKey: 'github.open_pr',
          idempotencyKey: 'jira:PAY-1842:github.open_pr',
          digest: 'sha256:action-proposal-pay1842-open-pr',
          execution_grant: {
            digest: 'sha256:approved-execution-grant',
            approval_decision_key: 'approve-open-pr',
          },
          response: {
            number: 4821,
            htmlUrl: 'https://github.com/acme/payments-api/pull/4821',
          },
          provider_reconciliation: {
            status: 'verified',
            method: 'read_after_write',
            checkedAt: '2026-05-17T10:01:00.000Z',
            checkedBy: 'vpd.provider_adapter',
            providerReference: 'https://github.com/acme/payments-api/pull/4821',
            providerUrl: 'https://github.com/acme/payments-api/pull/4821',
            targetDigest: 'sha256:target',
            payloadDigest: 'sha256:payload',
          },
        },
      },
    });

    await sync.sync(run);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body['evidence_packets']).toEqual([
      expect.objectContaining({
        evidence_key: 'node:inspect:output',
        node_key: 'inspect',
        kind: 'command_output',
        digest: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(calls[0]?.body['action_proposals']).toEqual([
      expect.objectContaining({
        proposal_key: 'github.open_pr',
        adapter: 'github',
        action: 'open_pr',
        proposal_digest: 'sha256:action-proposal-pay1842-open-pr',
      }),
    ]);
    expect(calls[0]?.body['execution_receipts']).toEqual([
      expect.objectContaining({
        receipt_key: 'execution:event-action-executed',
        proposal_key: 'github.open_pr',
        approval_decision_key: 'approve-open-pr',
        provider_reference: '4821',
        provider_url: 'https://github.com/acme/payments-api/pull/4821',
        provider_reconciliation: expect.objectContaining({
          status: 'verified',
          method: 'read_after_write',
          checkedBy: 'vpd.provider_adapter',
        }),
        payload: expect.objectContaining({
          execution_grant: expect.objectContaining({
            digest: 'sha256:approved-execution-grant',
          }),
        }),
      }),
    ]);
    expect(calls[0]?.body['audit_receipts']).toEqual([
      expect.objectContaining({
        receipt_key: 'audit:event-action-executed',
        event_type: 'action-executed',
        actor_type: 'runner',
      }),
    ]);
    expect(calls[0]?.body['context_receipts_snapshot']).toEqual([
      expect.objectContaining({
        schema: 'viewport.context_receipt/v1',
        package: 'payments.domain-rules',
        usedBy: expect.objectContaining({
          runId: 'runtime-run-1',
          nodeId: 'inspect',
        }),
      }),
    ]);
  });

  it('skips sync when the run is not linked to a platform run', async () => {
    const calls: unknown[] = [];
    const sync = new WorkflowRunPlatformSync(configManager(), async () => {
      calls.push(true);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const run = workflowRun();
    delete run.platformRunId;

    await sync.sync(run);

    expect(calls).toHaveLength(0);
  });

  it('syncs normalized aggregate usage from daemon agent ledgers', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    const sync = new WorkflowRunPlatformSync(configManager(), async (_url, init) => {
      calls.push({
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const run = workflowRun();
    run.nodes.inspect.metadata = {
      ...(run.nodes.inspect.metadata ?? {}),
      usage: {
        available: true,
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        totalCostUsd: 0.0125,
      },
    };

    await sync.sync(run);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body['usage']).toMatchObject({
      schema: 'viewport.usage_ledger/v1',
      available: true,
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      cost_usd: 0.0125,
      cost_source: 'runner_local',
      billable_to_workspace: false,
    });
    expect(calls[0]?.body['output_snapshot']).toMatchObject({
      usage: expect.objectContaining({
        total_tokens: 150,
        cost_usd: 0.0125,
      }),
    });
    expect(calls[0]?.body['nodes']).toEqual([
      expect.objectContaining({
        node_key: 'inspect',
        usage: expect.objectContaining({
          input_tokens: 120,
          output_tokens: 30,
          total_tokens: 150,
          cost_usd: 0.0125,
        }),
        metadata: expect.objectContaining({
          usage: expect.objectContaining({
            input_tokens: 120,
            output_tokens: 30,
            total_tokens: 150,
            cost_usd: 0.0125,
          }),
        }),
      }),
    ]);
  });

  it('syncs workflow runs that only carry canonical resource runtime fields', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const sync = new WorkflowRunPlatformSync(configManager(), async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const run = workflowRun();
    run.resourceId = 'project-1';
    run.runtimeTargetId = 'binding-1';

    await sync.sync(run);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://getviewport.test/api/runtime/workspaces/project-1/workflow-runs/platform-run-1/sync',
    );
    expect(calls[0]?.body).toMatchObject({
      credential: 'issue-token',
      runtime_target_id: 'binding-1',
      runtime_run_id: 'runtime-run-1',
    });
    expect(calls[0]?.body).not.toHaveProperty('project_machine_binding_id');
  });

  it('uses the relay binding for the workflow resource instead of the legacy default workspace', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const sync = new WorkflowRunPlatformSync(
      {
        getDaemonConfig: () => ({
          server: { url: 'https://fallback.getviewport.test', tlsVerify: 'auto' },
          relay: {
            workspaceId: 'personal-workspace',
            issueToken: 'personal-token',
            bindings: [
              {
                workspaceId: 'personal-workspace',
                serverUrl: 'https://api.getviewport.test',
                issueToken: 'personal-token',
              },
              {
                workspaceId: 'project-1',
                runtimeTargetId: 'binding-1',
                serverUrl: 'https://api.getviewport.test',
                issueToken: 'project-token',
              },
            ],
          },
        }),
      } as ConfigManager,
      async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );

    await sync.sync(workflowRun());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.getviewport.test/api/runtime/workspaces/project-1/workflow-runs/platform-run-1/sync',
    );
    expect(calls[0]?.body).toMatchObject({
      credential: 'project-token',
      runtime_target_id: 'binding-1',
    });
  });

  it('emits a privacy-preserving review packet for terminal review workflows', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sync = new WorkflowRunPlatformSync(configManager(), async (_url, init) => {
      calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const run = workflowRun();
    run.status = 'completed';
    run.completedAt = 2_000;
    run.updatedAt = 2_000;
    run.nodes.inspect.status = 'completed';
    run.nodes.inspect.completedAt = 2_000;
    run.nodes.inspect.output = 'raw private review transcript and local diff details';
    run.events.push({
      id: 'event-2',
      runId: run.id,
      timestamp: 2_000,
      type: 'run-completed',
      message: 'Workflow run completed',
    });

    await sync.sync(run);

    const packet = calls[0]?.['review_packet'] as Record<string, unknown>;
    expect(packet).toMatchObject({
      source_key: 'daemon-workflow-readiness',
      title: 'Pull request review readiness packet',
      status: 'published',
      decision: 'needs_review',
      risk_level: 'low',
      published_at: '1970-01-01T00:00:02.000Z',
    });
    expect(packet['summary']).toBe('Pull request review completed with 1/1 nodes complete.');
    expect(packet['checks']).toEqual([
      {
        key: 'inspect',
        title: 'Inspect',
        type: 'shell',
        status: 'completed',
        exitCode: 0,
      },
    ]);
    expect(packet['proof_items']).toEqual([
      {
        kind: 'node',
        node: 'inspect',
        title: 'Inspect',
        status: 'completed',
        completedAt: '1970-01-01T00:00:02.000Z',
      },
      {
        kind: 'artifact',
        node: 'inspect',
        name: 'report',
        type: 'report',
        digest: 'sha256:report',
      },
    ]);
    expect(JSON.stringify(packet)).not.toContain('raw private review transcript');
    expect(JSON.stringify(packet)).not.toContain('/repo');
    expect(JSON.stringify(packet)).not.toContain('/repo/artifacts/report.md');
    expect(JSON.stringify(packet)).not.toContain('binding-1');
    expect(JSON.stringify(packet)).not.toContain('machine-1');
    expect(packet['metadata']).toMatchObject({
      generatedBy: 'vpd',
      privacy: {
        rawTranscriptIncluded: false,
        rawLogContentIncluded: false,
        rawArtifactBytesIncluded: false,
      },
    });
  });

  it('redacts failed-node command output from generated review packet findings', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sync = new WorkflowRunPlatformSync(configManager(), async (_url, init) => {
      calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const run = workflowRun();
    run.status = 'failed';
    run.completedAt = 2_000;
    run.updatedAt = 2_000;
    run.nodes.inspect.status = 'failed';
    run.nodes.inspect.error = 'Command failed with stderr: secret stderr from local command';

    await sync.sync(run);

    const packet = calls[0]?.['review_packet'] as Record<string, unknown>;
    expect(packet).toMatchObject({
      status: 'failed',
      decision: 'changes_requested',
      risk_level: 'high',
    });
    expect(packet['findings']).toEqual([
      {
        severity: 'high',
        node: 'inspect',
        title: 'Inspect',
        message: 'Node inspect failed. Inspect the local run for redacted command output.',
      },
    ]);
    expect(JSON.stringify(packet)).not.toContain('secret stderr');
  });

  it('does not auto-publish review packets for blocked approval polling snapshots', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sync = new WorkflowRunPlatformSync(configManager(), async (_url, init) => {
      calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const run = workflowRun();
    run.status = 'blocked';
    run.nodes.inspect.status = 'blocked';

    await sync.sync(run);

    expect(calls[0]).not.toHaveProperty('review_packet');
  });

  it('redacts transcript excerpts, log content, and artifact paths when capture policy requires it', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sync = new WorkflowRunPlatformSync(configManager(), async (_url, init) => {
      calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const run = workflowRun();
    run.dataCapturePolicy = {
      transcripts: 'none',
      logs: 'metadata',
      artifacts: 'metadata',
    };
    run.events = [
      {
        id: 'event-log',
        runId: run.id,
        timestamp: 1_000,
        type: 'node-log',
        nodeId: 'inspect',
        message: 'secret stdout',
        data: { source: 'shell', stream: 'stdout', chunk: 'secret stdout' },
      },
    ];

    await sync.sync(run);

    expect(calls[0]?.['data_capture_policy']).toEqual({
      transcripts: 'none',
      logs: 'metadata',
      artifacts: 'metadata',
    });
    expect(
      (calls[0]?.['nodes'] as Array<Record<string, unknown>>)[0]?.['transcript_excerpt'],
    ).toBeNull();
    expect((calls[0]?.['artifacts'] as Array<Record<string, unknown>>)[0]?.['path']).toBe('report');
    expect((calls[0]?.['events'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      message: 'Node log content redacted by workflow data capture policy.',
      payload: {
        source: 'shell',
        stream: 'stdout',
        redacted: true,
        reason: 'workflow_data_capture_policy',
      },
    });
  });

  it('defaults to privacy-first platform sync capture', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sync = new WorkflowRunPlatformSync(configManager(), async (_url, init) => {
      calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const run = workflowRun();
    run.events = [
      {
        id: 'event-log',
        runId: run.id,
        timestamp: 1_000,
        type: 'node-log',
        nodeId: 'inspect',
        message: 'secret stdout',
        data: { source: 'shell', stream: 'stdout', chunk: 'secret stdout' },
      },
    ];

    await sync.sync(run);

    expect(calls[0]?.['data_capture_policy']).toEqual({
      transcripts: 'none',
      logs: 'metadata',
      artifacts: 'metadata',
    });
    expect(
      (calls[0]?.['nodes'] as Array<Record<string, unknown>>)[0]?.['transcript_excerpt'],
    ).toBeNull();
    expect((calls[0]?.['artifacts'] as Array<Record<string, unknown>>)[0]?.['path']).toBe('report');
    expect((calls[0]?.['events'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      message: 'Node log content redacted by workflow data capture policy.',
      payload: {
        source: 'shell',
        stream: 'stdout',
        redacted: true,
        reason: 'workflow_data_capture_policy',
      },
    });
  });

  it('redacts context node bodies from platform sync while preserving receipts', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sync = new WorkflowRunPlatformSync(configManager(), async (_url, init) => {
      calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const run = workflowRun();
    run.nodes = {
      attach_context: {
        id: 'attach_context',
        type: 'context',
        title: 'Attach context',
        status: 'completed',
        output:
          '{"query":"PAY-1842 private payment bug","items":[{"title":"docs/private-runbook.md","body":"secret payment runbook"}]}',
        outputs: {
          query: 'PAY-1842 private payment bug',
          itemCount: 1,
          items: [
            {
              id: '/repo/docs/private-runbook.md',
              provider_id: 'payments-vault',
              provider: 'viewport-vault',
              title: 'docs/private-runbook.md',
              body: 'secret payment runbook',
            },
          ],
        },
      },
    };
    run.contextReceipts = [
      {
        schema: 'viewport.context_receipt/v1',
        package: 'payments-vault',
        requested: 'context://vault/payments',
        resolvedVersion: '2026.05.17',
        provider: 'viewport-vault',
        digest: 'sha256:context',
        freshness: 'resolved_at_run',
        usedBy: {
          runId: run.id,
          nodeId: 'attach_context',
          providerId: 'payments-vault',
          alias: null,
        },
        resolvedAt: '2026-05-17T10:00:00.000Z',
      },
    ];
    run.events = [
      {
        id: 'event-context-output',
        runId: run.id,
        timestamp: 1_000,
        type: 'node-output',
        nodeId: 'attach_context',
        message: 'Context node attach_context resolved 1 item',
        data: {
          query: 'PAY-1842 private payment bug',
          providerCount: 1,
          itemCount: 1,
          items: [
            {
              id: '/repo/docs/private-runbook.md',
              provider_id: 'payments-vault',
              provider: 'viewport-vault',
              title: 'docs/private-runbook.md',
              body: 'secret payment runbook',
            },
          ],
        },
      },
    ];

    await sync.sync(run);

    const payload = calls[0]!;
    expect(JSON.stringify(payload)).not.toContain('PAY-1842');
    expect(JSON.stringify(payload)).not.toContain('secret payment runbook');
    expect(JSON.stringify(payload)).not.toContain('docs/private-runbook.md');
    expect(JSON.stringify(payload)).not.toContain('/repo/docs/private-runbook.md');
    expect(payload['output_snapshot']).toMatchObject({
      attach_context: 'Context node output redacted by workflow data capture policy.',
    });
    expect((payload['nodes'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      node_key: 'attach_context',
      output: 'Context node output redacted by workflow data capture policy.',
      output_snapshot: {
        redacted: true,
        itemCount: 1,
      },
    });
    expect((payload['events'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      message: 'Context node output metadata redacted by workflow data capture policy.',
      payload: {
        redacted: true,
        providerCount: 1,
        itemCount: 1,
      },
    });
    expect(payload['evidence_packets']).toEqual([]);
    expect(payload['context_receipts_snapshot']).toEqual(run.contextReceipts);
  });

  it('retries queued sync with the latest run snapshot after a transient failure', async () => {
    const calls: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const sync = new WorkflowRunPlatformSync(
      configManager(),
      async (_url, init) => {
        callCount += 1;
        calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
            status: 503,
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      { retryDelaysMs: [0] },
    );

    const run = workflowRun();
    sync.schedule(run);
    run.status = 'completed';
    run.completedAt = 2_000;
    run.nodes.inspect.status = 'completed';
    run.nodes.inspect.output = 'final output';
    run.events.push({
      id: 'event-2',
      runId: run.id,
      timestamp: 2_000,
      type: 'node-completed',
      nodeId: 'inspect',
      message: 'Inspect completed',
    });
    sync.schedule(run);

    await sync.flushPending();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.['status']).toBe('running');
    expect(calls[1]).toMatchObject({
      status: 'completed',
      completed_at: '1970-01-01T00:00:02.000Z',
      output_snapshot: { inspect: 'final output' },
    });
    expect(calls[1]?.['events']).toHaveLength(2);
  });

  it('keeps retrying the latest run after the configured retry list is exhausted', async () => {
    const calls: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const sync = new WorkflowRunPlatformSync(
      configManager(),
      async (_url, init) => {
        callCount += 1;
        calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        if (callCount === 1) {
          return new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
            status: 503,
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      { retryDelaysMs: [], exhaustedRetryDelayMs: 0 },
    );

    const run = workflowRun();
    sync.schedule(run);

    await waitForCondition(() => calls.length === 2);

    expect(calls[0]?.['status']).toBe('running');
    expect(calls[1]?.['status']).toBe('running');
  });

  it('does not keep retrying permanent platform sync rejections', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const sync = new WorkflowRunPlatformSync(
      configManager(),
      async (_url, init) => {
        calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response(JSON.stringify({ reason: 'RUNTIME_TARGET_MISMATCH' }), {
          status: 403,
        });
      },
      { retryDelaysMs: [0], exhaustedRetryDelayMs: 0 },
    );

    const run = workflowRun();
    sync.schedule(run);
    await sync.flushPending();

    expect(calls).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
  });

  it('applies runtime approval commands returned by platform sync and sends the resumed snapshot', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const commands: unknown[] = [];
    const run = workflowRun();
    run.status = 'blocked';
    run.nodes.inspect.status = 'blocked';
    const sync = new WorkflowRunPlatformSync(
      configManager(),
      async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        calls.push(body);
        return new Response(
          JSON.stringify({
            data: { id: 'platform-run-1' },
            runtime_commands:
              body['status'] === 'blocked'
                ? [
                    {
                      id: 'plan-review:plan-1:inspect:1',
                      type: 'workflow.approval_decision',
                      workflow_run_id: 'runtime-run-1',
                      workflow_node_id: 'inspect',
                      approved: true,
                      message: 'Approved by reviewer.',
                      actor: { id: 1, name: 'Reviewer' },
                    },
                  ]
                : [],
          }),
          { status: 200 },
        );
      },
      {
        blockedPollDelayMs: 0,
        onRuntimeCommand: async (command) => {
          commands.push(command);
          run.status = 'running';
          run.nodes.inspect.status = 'running';
          sync.schedule(run);
        },
      },
    );

    sync.schedule(run);
    await waitForCondition(() => calls.length === 2);
    await sync.flushPending();

    expect(commands).toEqual([
      {
        id: 'plan-review:plan-1:inspect:1',
        type: 'workflow.approval_decision',
        workflow_run_id: 'runtime-run-1',
        workflow_node_id: 'inspect',
        approved: true,
        message: 'Approved by reviewer.',
        actor: { id: 1, name: 'Reviewer' },
        feedback: null,
      },
    ]);
    expect(calls.map((call) => call['status'])).toEqual(['blocked', 'running']);
  });

  it('polls blocked platform-linked runs while waiting for a review command', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const run = workflowRun();
    run.status = 'blocked';
    run.nodes.inspect.status = 'blocked';
    const sync = new WorkflowRunPlatformSync(
      configManager(),
      async (_url, init) => {
        calls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        if (calls.length === 2) {
          run.status = 'running';
          run.nodes.inspect.status = 'running';
          sync.schedule(run);
        }
        return new Response(JSON.stringify({ data: { id: 'platform-run-1' } }), { status: 200 });
      },
      { blockedPollDelayMs: 0 },
    );

    sync.schedule(run);
    await waitForCondition(() => calls.length >= 3);
    await sync.flushPending();

    expect(calls.map((call) => call['status'])).toEqual(['blocked', 'blocked', 'running']);
  });

  it('does not mark runtime commands processed until the runner applies them', async () => {
    const commands: string[] = [];
    const run = workflowRun();
    run.status = 'blocked';
    run.nodes.inspect.status = 'blocked';
    const sync = new WorkflowRunPlatformSync(
      configManager(),
      async () =>
        new Response(
          JSON.stringify({
            data: { id: 'platform-run-1' },
            runtime_commands: [
              {
                id: 'plan-review:pending',
                type: 'workflow.approval_decision',
                workflow_node_id: 'inspect',
                approved: true,
              },
            ],
          }),
          { status: 200 },
        ),
      {
        blockedPollDelayMs: 0,
        onRuntimeCommand: async (command) => {
          commands.push(command.id);
          if (commands.length === 1) return false;
          run.status = 'running';
          run.nodes.inspect.status = 'running';
          sync.schedule(run);
          return true;
        },
      },
    );

    sync.schedule(run);
    await waitForCondition(() => commands.length === 2);
    await sync.flushPending();

    expect(commands).toEqual(['plan-review:pending', 'plan-review:pending']);
  });
});

function configManager(): ConfigManager {
  return {
    getDaemonConfig: () => ({
      server: { url: 'https://getviewport.test', tlsVerify: 'auto' },
      relay: {
        serverUrl: 'https://getviewport.test',
        workspaceId: 'project-1',
        runtimeTargetId: 'binding-1',
        issueToken: 'issue-token',
      },
    }),
  } as ConfigManager;
}

function workflowRun(): WorkflowRunRecord {
  return {
    id: 'runtime-run-1',
    workflowName: 'team/pr-review',
    workflowTitle: 'Pull request review',
    sourceType: 'viewport_snapshot',
    digest: 'sha256:run',
    schema: 'viewport.workflow/v1',
    yamlSnapshot: 'schema: viewport.workflow/v1\nname: team/pr-review\nnodes: {}\n',
    directoryId: 'dir-1',
    directoryPath: '/repo',
    resourceId: 'project-1',
    runtimeTargetId: 'binding-1',
    platformRunId: 'platform-run-1',
    machineId: 'machine-1',
    initiation: 'browser',
    status: 'running',
    inputs: {},
    preflight: { ok: true, issues: [] },
    nodes: {
      inspect: {
        id: 'inspect',
        type: 'shell',
        title: 'Inspect',
        status: 'running',
        output: 'git status',
        outputs: {
          summary: 'git status',
          changedFiles: 1,
        },
        transcriptExcerpt: [
          {
            role: 'assistant',
            text: 'Inspected the repository.',
          },
        ],
        exitCode: 0,
        metadata: {
          agent: 'codex',
          provider: 'openai',
          model: 'gpt-5.4',
        },
        inlineAgents: {
          reviewer: {
            id: 'reviewer',
            status: 'completed',
            output: 'reviewer output',
          },
        },
      },
    },
    artifacts: [
      {
        id: 'artifact-1',
        runId: 'runtime-run-1',
        nodeId: 'inspect',
        name: 'report',
        kind: 'report',
        path: '/repo/artifacts/report.md',
        digest: 'sha256:report',
        createdAt: 1_000,
      },
    ],
    events: [
      {
        id: 'event-1',
        runId: 'runtime-run-1',
        timestamp: 1_000,
        type: 'node-started',
        nodeId: 'inspect',
        message: 'Inspect started',
      },
    ],
    createdAt: 1_000,
    startedAt: 1_500,
    updatedAt: 1_000,
  };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}
