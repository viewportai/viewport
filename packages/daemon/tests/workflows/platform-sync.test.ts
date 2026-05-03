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
      project_machine_binding_id: 'binding-1',
      runtime_run_id: 'runtime-run-1',
      status: 'running',
      started_at: '1970-01-01T00:00:01.500Z',
    });
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
        return new Response(JSON.stringify({ reason: 'PROJECT_MACHINE_BINDING_MISMATCH' }), {
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
});

function configManager(): ConfigManager {
  return {
    getDaemonConfig: () => ({
      server: { url: 'https://getviewport.test', tlsVerify: 'auto' },
      relay: {
        serverUrl: 'https://getviewport.test',
        workspaceId: 'project-1',
        projectMachineBindingId: 'binding-1',
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
    projectId: 'project-1',
    projectMachineBindingId: 'binding-1',
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
