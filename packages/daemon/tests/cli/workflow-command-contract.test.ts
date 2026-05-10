import { describe, expect, it } from 'vitest';
import { buildWorkflowRunJsonOutput } from '../../src/cli/workflow-commands.js';

describe('workflow CLI JSON contract', () => {
  it('exposes a stable agent-facing workflow run shape', () => {
    const output = buildWorkflowRunJsonOutput({
      id: 'run_demo',
      workflowName: 'review-pr',
      workflowTitle: 'Review pull request',
      digest: 'sha256:workflowdigest',
      status: 'blocked',
      sourceType: 'local_file',
      sourcePath: '/repo/.viewport/workflows/review-pr.yaml',
      resourceManifest: {
        schema: 'viewport.session_resource_manifest/v1',
        manifestDigest: 'sha256:manifestdigest',
        workingDirectory: '/repo',
        configSources: [
          { path: '/repo/.viewport/config.yaml', digest: 'sha256:config', version: 1 },
        ],
        resources: {
          contexts: [],
          workflows: [],
          plans: [],
          agentProfiles: [],
        },
        contract: {
          contextProviders: [
            {
              id: 'repo_docs',
              provider: 'repo-docs',
              required: true,
              privacy: 'local_only',
              capabilities: ['search', 'get'],
              sourceConfigPath: '/repo/.viewport/config.yaml',
              resolution: 'requested_unverified',
            },
          ],
          contextResolution: {},
          workflows: [],
        },
        conflicts: [],
        warnings: [],
      },
      nodes: {
        inspect: {
          id: 'inspect',
          type: 'shell',
          title: 'Inspect changes',
          status: 'completed',
          outputs: { summary_digest: 'sha256:summary' },
          startedAt: 1,
          completedAt: 2,
        },
        plan_review: {
          id: 'plan_review',
          type: 'approval',
          title: 'Plan review',
          status: 'blocked',
          approval: {
            prompt: 'Approve the plan?',
            requestedAt: 3,
          },
        },
      },
    });

    expect(output).toMatchObject({
      schema_version: 'viewport.cli.workflow_run/v1',
      command: 'workflow run',
      ok: false,
      run_id: 'run_demo',
      workflow: {
        id: 'review-pr',
        name: 'Review pull request',
        digest: 'sha256:workflowdigest',
        source: 'local_file',
        path: '/repo/.viewport/workflows/review-pr.yaml',
      },
      status: 'blocked',
      manifest_digest: 'sha256:manifestdigest',
      resource_manifest: {
        schema: 'viewport.session_resource_manifest/v1',
        manifest_digest: 'sha256:manifestdigest',
        config_files: ['/repo/.viewport/config.yaml'],
        providers: [
          {
            id: 'repo_docs',
            provider: 'repo-docs',
            privacy: 'local_only',
            capabilities: ['search', 'get'],
            status: 'requested_unverified',
          },
        ],
        warnings: [],
        conflicts: [],
      },
      steps: [
        {
          id: 'inspect',
          type: 'shell',
          name: 'Inspect changes',
          status: 'completed',
          outputs: { summary_digest: 'sha256:summary' },
        },
        {
          id: 'plan_review',
          type: 'approval',
          name: 'Plan review',
          status: 'blocked',
          approval: {
            prompt: 'Approve the plan?',
            requested_at: 3,
          },
        },
      ],
      run: {
        id: 'run_demo',
      },
    });
  });
});
