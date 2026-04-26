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
    });
    expect(calls[0]?.body['events']).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      nodes: [
        {
          node_key: 'inspect',
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
    updatedAt: 1_000,
  };
}
