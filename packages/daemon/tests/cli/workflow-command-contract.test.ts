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
      workflowContract: {
        id: 'review-pr',
        sourceConfigPath: '/repo/.viewport/config.yaml',
        declaredPath: '.viewport/workflows/review-pr.yaml',
        status: 'verified',
        actualDigest: 'sha256:workflowdigest',
        digestStatus: 'unpinned',
      },
      resourceManifest: {
        schema: 'viewport.session_resource_manifest/v1',
        manifestDigest: 'sha256:manifestdigest',
        workingDirectory: '/repo',
        configSources: [
          { path: '/repo/.viewport/config.yaml', digest: 'sha256:config', version: 1 },
        ],
        resources: {
          contexts: [
            {
              id: 'ctx_platform_arch',
              required: true,
              sourceConfigPath: '/repo/.viewport/config.yaml',
              resolution: 'requested_unverified',
            },
          ],
          workflows: [
            {
              id: 'review-pr',
              required: true,
              sourceConfigPath: '/repo/.viewport/config.yaml',
              resolution: 'requested_unverified',
            },
          ],
          plans: [
            {
              id: 'plan_release_template',
              required: false,
              sourceConfigPath: '/repo/.viewport/config.yaml',
              resolution: 'requested_unverified',
            },
          ],
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
            {
              id: 'platform_arch',
              provider: 'viewport-vault',
              required: true,
              privacy: 'control_plane_blind',
              capabilities: ['search', 'get', 'propose', 'write_approved'],
              sourceConfigPath: '/repo/.viewport/config.yaml',
              resolution: 'requested_unverified',
              vault: 'ctx_platform_arch',
            },
          ],
          contextResolution: {
            order: ['repo_docs', 'platform_arch'],
            strategy: 'provider_order',
            sizeBudgetBytes: 65536,
            proposeFallbackProvider: 'platform_arch',
          },
          workflows: [
            {
              id: 'review-pr',
              path: '.viewport/workflows/review-pr.yaml',
              required: true,
              sourceConfigPath: '/repo/.viewport/config.yaml',
              resolution: 'requested_unverified',
            },
          ],
          riskyPathRules: [
            {
              id: 'auth-touch',
              path: 'apps/api/Auth/**',
              require: ['reviewer:security'],
              checks: ['npm run test -- session-rotation'],
              sourceConfigPath: '/repo/.viewport/config.yaml',
            },
          ],
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
      workflow_contract: {
        id: 'review-pr',
        status: 'verified',
        digest_status: 'unpinned',
        actual_digest: 'sha256:workflowdigest',
        source_config_path: '/repo/.viewport/config.yaml',
        declared_path: '.viewport/workflows/review-pr.yaml',
      },
      manifest_digest: 'sha256:manifestdigest',
      resource_manifest: {
        schema: 'viewport.session_resource_manifest/v1',
        manifest_digest: 'sha256:manifestdigest',
        working_directory: '/repo',
        config_files: ['/repo/.viewport/config.yaml'],
        resources: {
          contexts: [
            {
              id: 'ctx_platform_arch',
              required: true,
              sourceConfigPath: '/repo/.viewport/config.yaml',
              resolution: 'requested_unverified',
            },
          ],
          workflows: [
            {
              id: 'review-pr',
              required: true,
              sourceConfigPath: '/repo/.viewport/config.yaml',
              resolution: 'requested_unverified',
            },
          ],
          plans: [
            {
              id: 'plan_release_template',
              required: false,
              sourceConfigPath: '/repo/.viewport/config.yaml',
              resolution: 'requested_unverified',
            },
          ],
          agentProfiles: [],
        },
        providers: [
          {
            id: 'repo_docs',
            provider: 'repo-docs',
            privacy: 'local_only',
            capabilities: ['search', 'get'],
            status: 'requested_unverified',
            required: true,
            source_config_path: '/repo/.viewport/config.yaml',
          },
          {
            id: 'platform_arch',
            provider: 'viewport-vault',
            privacy: 'control_plane_blind',
            capabilities: ['search', 'get', 'propose', 'write_approved'],
            status: 'requested_unverified',
            required: true,
            vault: 'ctx_platform_arch',
            source_config_path: '/repo/.viewport/config.yaml',
          },
        ],
        context_resolution: {
          order: ['repo_docs', 'platform_arch'],
          strategy: 'provider_order',
          sizeBudgetBytes: 65536,
          proposeFallbackProvider: 'platform_arch',
        },
        workflows: [
          {
            id: 'review-pr',
            required: true,
            status: 'requested_unverified',
            source_config_path: '/repo/.viewport/config.yaml',
            path: '.viewport/workflows/review-pr.yaml',
          },
        ],
        approvals: [
          {
            id: 'auth-touch',
            path: 'apps/api/Auth/**',
            require: ['reviewer:security'],
            checks: ['npm run test -- session-rotation'],
            source_config_path: '/repo/.viewport/config.yaml',
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
