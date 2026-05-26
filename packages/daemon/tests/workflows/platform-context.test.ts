import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolvePromptNodeContext } from '../../src/workflows/context-node-resolver.js';
import { contextProviderAdapterFor, supportedContextProviderKinds } from '../../src/context-providers/registry.js';
import type { WorkflowPlatformContextClient } from '../../src/workflows/platform-context-client.js';
import type { WorkflowRunRecord } from '../../src/workflows/types.js';
import type { SessionContextProviderManifest } from '../../src/config-resolution/index.js';

describe('platform-governed customer-managed context', () => {
  it('resolves snippets locally from a Viewport-issued policy and reports digest receipts only', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-platform-context-'));
    try {
      await fs.mkdir(path.join(projectDir, '.viewport'), { recursive: true });
      await fs.mkdir(path.join(projectDir, 'docs', 'runbooks'), { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'docs', 'runbooks', 'support.md'),
        'PRIVATE_EDGE_CONTEXT: check duplicate delivery before changing retry backoff.',
        'utf8',
      );

      const reported: Array<Record<string, unknown>> = [];
      const platformContextClient = {
        async resolveNodePolicy() {
          return {
            schema: 'viewport.node_context_resolution/v1',
            node_id: 'draft_plan',
            query: 'retry backoff duplicate delivery',
            source_policies: [
              {
                schema: 'viewport.context_source_policy/v1',
                policy_receipt_id: 'ctxrec_policy_1',
                node_id: 'draft_plan',
                context_source_id: 'ctx_support_runbook',
                context_source_name: 'Support runbook',
                provider_type: 'git',
                external_ref: 'git://viewportai/vp-example-docs/docs/runbooks/support.md',
                source_url:
                  'https://github.com/viewportai/vp-example-docs/blob/main/docs/runbooks/support.md',
                execution_mode: 'customer_managed_context_worker',
                content_storage: 'none_metadata_only',
                query: 'retry backoff duplicate delivery',
                max_snippets: 3,
                receipt_requirements: {
                  plaintext_snippets_required: false,
                  required_fields: [
                    'source_ref',
                    'citation_url',
                    'snippet_digest',
                    'retrieval_query_digest',
                    'selected_at',
                    'node_id',
                  ],
                },
              },
            ],
            warnings: [],
          };
        },
        async reportCustomerManagedReceipt(input: {
          nodeId: string;
          query: string;
          policy: { policy_receipt_id: string; context_source_id: string };
          items: Array<{ id: string; body: string; digest?: string }>;
        }) {
          reported.push({
            nodeId: input.nodeId,
            query_digest: digest(input.query),
            policy: input.policy,
            snippet_count: input.items.length,
            citations: input.items.map((item) => ({
              citation_id: item.id,
              snippet_digest: digest(item.body),
              content_digest: item.digest ?? digest(item.body),
            })),
          });
        },
      } as unknown as WorkflowPlatformContextClient;

      const run = workflowRun(projectDir);
      const selected = await resolvePromptNodeContext({
        run,
        nodeId: 'draft_plan',
        workflowContext: [{ ref: 'ctx_support_runbook' }],
        prompt: 'Draft a plan for retry backoff duplicate delivery.',
        platformContextClient,
      });

      expect(selected.promptBlock).toContain('PRIVATE_EDGE_CONTEXT');
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({
        nodeId: 'draft_plan',
        query_digest: digest('Draft a plan for retry backoff duplicate delivery.'),
        policy: expect.objectContaining({
          policy_receipt_id: 'ctxrec_policy_1',
          context_source_id: 'ctx_support_runbook',
        }),
      });
      expect(JSON.stringify(reported)).not.toContain('PRIVATE_EDGE_CONTEXT');
      expect(run.contextReceipts).toEqual([
        expect.objectContaining({
          provider: 'repo-docs',
          requested: 'ctx_support_runbook',
          digest: expect.stringMatching(/^sha256:/),
          usedBy: expect.objectContaining({
            nodeId: 'draft_plan',
            providerId: 'ctx_support_runbook',
          }),
        }),
      ]);
      expect(JSON.stringify(run.contextReceipts)).not.toContain('PRIVATE_EDGE_CONTEXT');
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('renders workflow input templates before selecting node context providers', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-platform-context-template-'));
    try {
      await fs.mkdir(path.join(projectDir, '.viewport'), { recursive: true });
      await fs.mkdir(path.join(projectDir, 'docs', 'runbooks'), { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'docs', 'runbooks', 'support.md'),
        'TEMPLATED_EDGE_CONTEXT: render context refs before provider selection.',
        'utf8',
      );

      const run = {
        ...workflowRun(projectDir),
        inputs: {
          support_context: 'ctx_support_runbook',
          support_context_label: 'Support runbook',
          context_update_target: 'git://viewportai/vp-example-docs/docs/runbooks/support.md',
        },
      };
      const selected = await resolvePromptNodeContext({
        run,
        nodeId: 'draft_plan',
        workflowContext: [{ ref: '{{ inputs.support_context }}' }],
        nodeContext: {
          include: [
            {
              source: '{{ inputs.support_context }}',
              as: '{{ inputs.support_context_label }}',
              required: true,
            },
          ],
          write_targets: [
            {
              kind: 'repo_pr',
              ref: '{{ inputs.context_update_target }}',
            },
          ],
        },
        prompt: 'Draft a plan using rendered context.',
      });

      expect(selected.promptBlock).toContain('TEMPLATED_EDGE_CONTEXT');
      expect(selected.basis.refs).toEqual([
        expect.objectContaining({
          ref: 'ctx_support_runbook',
          as: 'Support runbook',
          required: true,
        }),
      ]);
      expect(selected.basis.writeTargets).toEqual([
        expect.objectContaining({
          kind: 'repo_pr',
          ref: 'git://viewportai/vp-example-docs/docs/runbooks/support.md',
        }),
      ]);
      expect(JSON.stringify(selected.basis)).not.toContain('{{');
      expect(run.contextReceipts).toEqual([
        expect.objectContaining({
          requested: 'ctx_support_runbook',
          usedBy: expect.objectContaining({
            nodeId: 'draft_plan',
            alias: 'Support runbook',
          }),
        }),
      ]);
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('registers Notion and Confluence as customer-hosted local adapters that fail closed without runner credentials', async () => {
    expect(supportedContextProviderKinds()).toEqual(
      expect.arrayContaining(['notion', 'confluence']),
    );

    const notion = contextProviderAdapterFor(provider('notion', 'notion://page/test-page'));
    const confluence = contextProviderAdapterFor(
      provider('confluence', 'confluence://space/PAY/page/12345'),
    );

    await expect(notion?.search?.({
      provider: provider('notion', 'notion://page/test-page'),
      query: 'retry',
      actorName: 'edge-runner',
    })).rejects.toThrow(/requires NOTION_TOKEN/);
    await expect(confluence?.search?.({
      provider: provider('confluence', 'confluence://space/PAY/page/12345'),
      query: 'retry',
      actorName: 'edge-runner',
    })).rejects.toThrow(/requires CONFLUENCE_BASE_URL/);

    await expect(notion?.applyApprovedUpdate?.({
      provider: provider('notion', 'notion://page/test-page'),
      proposalId: 'ctxprop_1',
      actorName: 'edge-runner',
      patch: {
        mode: 'append',
        text: 'Approved update',
        patchDigest: digest('Approved update'),
      },
    })).rejects.toThrow(/requires NOTION_TOKEN/);
    await expect(confluence?.applyApprovedUpdate?.({
      provider: provider('confluence', 'confluence://space/PAY/page/12345'),
      proposalId: 'ctxprop_2',
      actorName: 'edge-runner',
      patch: {
        mode: 'append',
        text: 'Approved update',
        patchDigest: digest('Approved update'),
      },
    })).rejects.toThrow(/requires CONFLUENCE_BASE_URL/);
  });

  it('blocks local context resolution outside the workflow authority contract', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-platform-context-deny-'));
    try {
      await fs.mkdir(path.join(projectDir, '.viewport'), { recursive: true });
      await fs.mkdir(path.join(projectDir, 'docs', 'runbooks'), { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'docs', 'runbooks', 'support.md'),
        'PRIVATE_EDGE_CONTEXT: this must not be selected for an unauthorized node.',
        'utf8',
      );

      const run = {
        ...workflowRun(projectDir),
        workflowAuthorityContract: {
          schema_version: 'viewport.workflow_execution_authority/v1',
          digest: 'sha256:authority',
          context_sources: {
            read: [{ ref: 'context://allowed-only' }],
          },
        },
      };

      await expect(
        resolvePromptNodeContext({
          run,
          nodeId: 'draft_plan',
          workflowContext: [{ ref: 'ctx_support_runbook' }],
          prompt: 'Draft a plan using support context.',
        }),
      ).rejects.toThrow(/does not allow context source ctx_support_runbook/);
      expect(JSON.stringify(run.contextReceipts ?? [])).not.toContain('PRIVATE_EDGE_CONTEXT');
      expect(run.events).toContainEqual(
        expect.objectContaining({
          type: 'node-context-blocked',
          nodeId: 'draft_plan',
          data: expect.objectContaining({
            workflow_authority_denial: expect.objectContaining({
              reason: 'context_source_not_allowed',
              contextSource: 'ctx_support_runbook',
            }),
          }),
        }),
      );
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});

function workflowRun(projectDir: string): WorkflowRunRecord {
  return {
    id: 'runtime-run-1',
    workflowName: 'support-proof',
    sourceType: 'local_file',
    sourcePath: path.join(projectDir, 'workflow.yaml'),
    digest: 'sha256:workflow',
    schema: 'viewport.workflow/v1',
    yamlSnapshot: 'schema: viewport.workflow/v1\nname: support-proof\nnodes: {}\n',
    directoryId: 'dir-1',
    directoryPath: projectDir,
    resourceId: 'workspace-1',
    runtimeTargetId: 'runner-1',
    platformRunId: 'platform-run-1',
    machineId: 'vps-edge-runner',
    resourceManifest: {
      schema: 'viewport.session_resource_manifest/v1',
      manifestDigest: 'sha256:manifest',
      workingDirectory: projectDir,
      configSources: [],
      resources: {
        contexts: [],
        contextPackages: [],
        workflows: [],
        plans: [],
        agentProfiles: [],
      },
      contract: {
        contextProviders: [
          {
            id: 'ctx_support_runbook',
            provider: 'repo-docs',
            required: false,
            privacy: 'local_only',
            capabilities: ['search'],
            sourceConfigPath: path.join(projectDir, '.viewport', 'config.yaml'),
            ref: 'git://viewportai/vp-example-docs/docs/runbooks/support.md',
            paths: ['docs/runbooks/support.md'],
            resolution: 'requested_unverified',
          },
        ],
        contextResolution: {},
        workflows: [],
        contextPackages: [],
        riskyPathRules: [],
      },
      conflicts: [],
      warnings: [],
    },
    initiation: 'cli',
    status: 'running',
    inputs: {},
    preflight: { ok: true, issues: [] },
    nodes: {},
    artifacts: [],
    events: [],
    createdAt: 1_000,
    startedAt: 1_000,
    updatedAt: 1_000,
  };
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function provider(kind: 'notion' | 'confluence', ref: string): SessionContextProviderManifest {
  return {
    id: `${kind}_proof`,
    provider: kind,
    required: false,
    privacy: 'customer_hosted',
    capabilities: ['search', 'get', 'write_approved'],
    sourceConfigPath: '/tmp/.viewport/config.yaml',
    ref,
    resolution: 'requested_unverified',
  };
}
