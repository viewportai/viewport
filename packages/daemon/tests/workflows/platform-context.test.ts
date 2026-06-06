import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolvePromptNodeContext } from '../../src/workflows/context-node-resolver.js';
import {
  contextProviderAdapterFor,
  supportedContextProviderKinds,
} from '../../src/context-providers/registry.js';
import {
  WorkflowPlatformContextClient,
  type PlatformSessionCollaborationMailboxRetrieval,
  type PlatformSessionMemoryRetrieval,
} from '../../src/workflows/platform-context-client.js';
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
      run.resourceManifest!.contract.contextProviders = [];
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
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'viewport-platform-context-template-'),
    );
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

  it('materializes direct Git context refs even when the local manifest has no provider entry', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-direct-git-context-'));
    try {
      await fs.mkdir(path.join(projectDir, '.viewport'), { recursive: true });
      await fs.mkdir(path.join(projectDir, 'docs', 'runbooks'), { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'docs', 'runbooks', 'support.md'),
        'DIRECT_GIT_CONTEXT: direct workflow refs should materialize without a local manifest provider.',
        'utf8',
      );

      const run = workflowRun(projectDir);
      run.resourceManifest!.contract.contextProviders = [];
      const selected = await resolvePromptNodeContext({
        run,
        nodeId: 'draft_plan',
        workflowContext: [
          {
            ref: 'git://viewportai/vp-example-docs/docs/runbooks/support.md',
            required: true,
          },
        ],
        prompt: 'Draft a plan using direct Git context.',
      });

      expect(selected.promptBlock).toContain('DIRECT_GIT_CONTEXT');
      expect(selected.basis.selectedItems).toHaveLength(1);
      expect(run.contextReceipts).toEqual([
        expect.objectContaining({
          provider: 'repo-docs',
          requested: 'git://viewportai/vp-example-docs/docs/runbooks/support.md',
          digest: expect.stringMatching(/^sha256:/),
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

    await expect(
      notion?.search?.({
        provider: provider('notion', 'notion://page/test-page'),
        query: 'retry',
        actorName: 'edge-runner',
      }),
    ).rejects.toThrow(/requires NOTION_TOKEN/);
    await expect(
      confluence?.search?.({
        provider: provider('confluence', 'confluence://space/PAY/page/12345'),
        query: 'retry',
        actorName: 'edge-runner',
      }),
    ).rejects.toThrow(/requires CONFLUENCE_BASE_URL/);

    await expect(
      notion?.applyApprovedUpdate?.({
        provider: provider('notion', 'notion://page/test-page'),
        proposalId: 'ctxprop_1',
        actorName: 'edge-runner',
        patch: {
          mode: 'append',
          text: 'Approved update',
          patchDigest: digest('Approved update'),
        },
      }),
    ).rejects.toThrow(/requires NOTION_TOKEN/);
    await expect(
      confluence?.applyApprovedUpdate?.({
        provider: provider('confluence', 'confluence://space/PAY/page/12345'),
        proposalId: 'ctxprop_2',
        actorName: 'edge-runner',
        patch: {
          mode: 'append',
          text: 'Approved update',
          patchDigest: digest('Approved update'),
        },
      }),
    ).rejects.toThrow(/requires CONFLUENCE_BASE_URL/);
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

  it('retrieves Product20 session memory through the runtime lease endpoint', async () => {
    const run = {
      ...workflowRun('/workspace/product20'),
      resourceId: 'workspace-product20',
      runtimeTargetId: 'runtime-target-1',
      platformRunId: 'workflow-run-1',
      inputs: {
        viewport: {
          workflow: {
            product20_policy_pin: {
              agent_session_id: 'agent-session-1',
            },
          },
        },
      },
    };
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new WorkflowPlatformContextClient(
      {
        getDaemonConfig() {
          return {
            relay: {
              bindings: [
                {
                  workspaceId: 'workspace-product20',
                  serverUrl: 'https://api.getviewport.test',
                  issueToken: 'vpdt_runtime_issue_token',
                  runtimeTargetId: 'runtime-target-1',
                  enabled: true,
                },
              ],
            },
          };
        },
      } as never,
      (async (url: string | URL | Request, init?: RequestInit & { body?: string }) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });

        return new Response(
          JSON.stringify({
            data: {
              schema: 'viewport.agent_session_memory_retrieval/v1',
              receipt: {
                id: 'receipt-memory-1',
                receipt_type: 'context.memory_retrieval',
              },
              retrieval: {
                schema: 'viewport.session_memory_retrieval/v1',
                access_model: {
                  learned_state_expands_access: false,
                  raw_memory_plaintext_returned: false,
                },
                query: {
                  digest: digest('payments rollback'),
                  raw_query_returned: false,
                },
                results: [
                  {
                    context_source_id: 'ctx_payments',
                    memory_entry_digest: digest('payments rollback checklist'),
                    plaintext_returned: false,
                  },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }) as never,
    );

    const result = (await client.retrieveSessionMemory({
      run,
      query: 'payments rollback',
      limit: 3,
      contextSourceIds: ['ctx_payments'],
    })) as PlatformSessionMemoryRetrieval;

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://api.getviewport.test/api/runtime/workspaces/workspace-product20/workflow-runs/workflow-run-1/agent-sessions/agent-session-1/memory-retrieval',
    );
    expect(requests[0]?.body).toEqual({
      credential: 'vpdt_runtime_issue_token',
      runtime_target_id: 'runtime-target-1',
      query: 'payments rollback',
      limit: 3,
      context_source_ids: ['ctx_payments'],
    });
    expect(result.schema).toBe('viewport.agent_session_memory_retrieval/v1');
    expect(result.receipt).toMatchObject({ receipt_type: 'context.memory_retrieval' });
    expect(result.retrieval).toMatchObject({
      schema: 'viewport.session_memory_retrieval/v1',
      access_model: expect.objectContaining({
        learned_state_expands_access: false,
        raw_memory_plaintext_returned: false,
      }),
    });
    expect(JSON.stringify(requests)).not.toContain('payments rollback checklist');
    expect(JSON.stringify(result)).not.toContain('sk_');
  });

  it('retrieves Product20 session memory through first-class run session ids', async () => {
    const run = {
      ...workflowRun('/workspace/product20'),
      resourceId: 'workspace-product20',
      runtimeTargetId: 'runtime-target-1',
      platformRunId: 'workflow-run-1',
      agentSessionId: 'agent-session-first-class',
      inputs: {},
    };
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new WorkflowPlatformContextClient(
      {
        getDaemonConfig() {
          return {
            relay: {
              bindings: [
                {
                  workspaceId: 'workspace-product20',
                  serverUrl: 'https://api.getviewport.test',
                  issueToken: 'vpdt_runtime_issue_token',
                  runtimeTargetId: 'runtime-target-1',
                  enabled: true,
                },
              ],
            },
          };
        },
      } as never,
      (async (url: string | URL | Request, init?: RequestInit & { body?: string }) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });

        return new Response(
          JSON.stringify({
            data: {
              schema: 'viewport.agent_session_memory_retrieval/v1',
              receipt: {
                id: 'receipt-memory-first-class',
                receipt_type: 'context.memory_retrieval',
              },
              retrieval: {
                schema: 'viewport.session_memory_retrieval/v1',
                query: {
                  digest: digest('session scoped context'),
                  raw_query_returned: false,
                },
                access_model: {
                  raw_memory_plaintext_returned: false,
                  learned_state_expands_access: false,
                },
                results: [],
              },
            },
          }),
          { status: 200 },
        );
      }) as never,
    );

    const result = await client.retrieveSessionMemory({
      run,
      query: 'session scoped context',
      limit: 3,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://api.getviewport.test/api/runtime/workspaces/workspace-product20/workflow-runs/workflow-run-1/agent-sessions/agent-session-first-class/memory-retrieval',
    );
    expect(requests[0]?.body).toMatchObject({
      credential: 'vpdt_runtime_issue_token',
      runtime_target_id: 'runtime-target-1',
      query: 'session scoped context',
      limit: 3,
    });
    expect(result?.schema).toBe('viewport.agent_session_memory_retrieval/v1');
  });

  it('retrieves Product20 session memory through a run-scoped runtime context target', async () => {
    const run = {
      ...workflowRun('/workspace/product20'),
      resourceId: 'workspace-product20',
      runtimeTargetId: 'runtime-target-1',
      platformRunId: 'workflow-run-1',
      agentSessionId: 'agent-session-runtime-target',
      inputs: {
        viewport: {
          runtimeContextTarget: {
            schema: 'viewport.runtime_context_target/v1',
            serverUrl: 'https://api.getviewport.test',
            workspaceId: 'workspace-product20',
            runtimeTargetId: 'runtime-target-1',
            credential: 'vpclaim_runtime_context_target',
          },
        },
      },
    };
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new WorkflowPlatformContextClient(
      {
        getDaemonConfig() {
          return null;
        },
      } as never,
      (async (url: string | URL | Request, init?: RequestInit & { body?: string }) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });

        return new Response(
          JSON.stringify({
            data: {
              schema: 'viewport.agent_session_memory_retrieval/v1',
              receipt: {
                id: 'receipt-memory-runtime-target',
                receipt_type: 'context.memory_retrieval',
              },
              retrieval: {
                schema: 'viewport.session_memory_retrieval/v1',
                query: {
                  digest: digest('runtime target context'),
                  raw_query_returned: false,
                },
                access_model: {
                  raw_memory_plaintext_returned: false,
                  learned_state_expands_access: false,
                },
                results: [],
              },
            },
          }),
          { status: 200 },
        );
      }) as never,
    );

    const result = await client.retrieveSessionMemory({
      run,
      query: 'runtime target context',
      limit: 2,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://api.getviewport.test/api/runtime/workspaces/workspace-product20/workflow-runs/workflow-run-1/agent-sessions/agent-session-runtime-target/memory-retrieval',
    );
    expect(requests[0]?.body).toMatchObject({
      credential: 'vpclaim_runtime_context_target',
      runtime_target_id: 'runtime-target-1',
      query: 'runtime target context',
      limit: 2,
    });
    expect(result?.schema).toBe('viewport.agent_session_memory_retrieval/v1');
    expect(JSON.stringify(result)).not.toContain('vpclaim_runtime_context_target');
  });

  it('prefers the run-scoped Product20 context target over stale daemon bindings', async () => {
    const run = {
      ...workflowRun('/workspace/product20'),
      resourceId: 'workspace-product20',
      runtimeTargetId: 'runtime-target-1',
      platformRunId: 'workflow-run-1',
      agentSessionId: 'agent-session-runtime-target',
      inputs: {
        viewport: {
          runtimeContextTarget: {
            schema: 'viewport.runtime_context_target/v1',
            serverUrl: 'https://api.getviewport.test',
            workspaceId: 'workspace-product20',
            runtimeTargetId: 'runtime-target-1',
            credential: 'vpclaim_runtime_context_target',
          },
        },
      },
    };
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new WorkflowPlatformContextClient(
      {
        getDaemonConfig() {
          return {
            relay: {
              bindings: [
                {
                  workspaceId: 'workspace-product20',
                  serverUrl: 'https://stale-sync-target.getviewport.test',
                  issueToken: 'vpdt_stale_workspace_token',
                  runtimeTargetId: 'different-runtime-target',
                  enabled: true,
                },
              ],
            },
          };
        },
      } as never,
      (async (url: string | URL | Request, init?: RequestInit & { body?: string }) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        });

        return new Response(
          JSON.stringify({
            data: {
              schema: 'viewport.agent_session_memory_retrieval/v1',
              receipt: {
                id: 'receipt-memory-runtime-target',
                receipt_type: 'context.memory_retrieval',
              },
              retrieval: {
                schema: 'viewport.session_memory_retrieval/v1',
                query: {
                  digest: digest('runtime target context'),
                  raw_query_returned: false,
                },
                access_model: {
                  raw_memory_plaintext_returned: false,
                  learned_state_expands_access: false,
                },
                results: [],
              },
            },
          }),
          { status: 200 },
        );
      }) as never,
    );

    const result = await client.retrieveSessionMemory({
      run,
      query: 'runtime target context',
      limit: 2,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://api.getviewport.test/api/runtime/workspaces/workspace-product20/workflow-runs/workflow-run-1/agent-sessions/agent-session-runtime-target/memory-retrieval',
    );
    expect(requests[0]?.body).toMatchObject({
      credential: 'vpclaim_runtime_context_target',
      runtime_target_id: 'runtime-target-1',
    });
    expect(result?.schema).toBe('viewport.agent_session_memory_retrieval/v1');
    expect(JSON.stringify(requests)).not.toContain('vpdt_stale_workspace_token');
    expect(JSON.stringify(requests)).not.toContain('stale-sync-target');
  });

  it('injects Product20 session memory metadata into prompt context without raw memory plaintext', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-session-memory-context-'));
    try {
      const run = {
        ...workflowRun(projectDir),
        resourceId: 'workspace-product20',
        runtimeTargetId: 'runtime-target-1',
        platformRunId: 'workflow-run-1',
        inputs: {
          viewport: {
            workflow: {
              product20_policy_pin: {
                agent_session_id: 'agent-session-1',
              },
            },
          },
        },
      };
      const retrievalCalls: Array<Record<string, unknown>> = [];
      const platformContextClient = {
        async resolveNodePolicy() {
          return null;
        },
        async retrieveSessionMemory(input: Record<string, unknown>) {
          retrievalCalls.push(input);
          return {
            schema: 'viewport.agent_session_memory_retrieval/v1',
            receipt: {
              id: 'receipt-memory-1',
              digest: 'sha256:receipt-memory-1',
              receipt_type: 'context.memory_retrieval',
            },
            retrieval: {
              schema: 'viewport.session_memory_retrieval/v1',
              working_set: {
                receipt_id: 'receipt-working-set-1',
              },
              query: {
                digest: digest('payments rollback'),
                raw_query_returned: false,
              },
              access_model: {
                learned_state_expands_access: false,
                raw_memory_plaintext_returned: false,
              },
              results: [
                {
                  id: 'memory-result-1',
                  context_source_id: 'ctx_payments',
                  memory_entry_digest: digest('raw payment memory that must stay server-side'),
                  title: 'Payments rollback rule',
                  score: 0.91,
                  body: 'RAW_PAYMENT_MEMORY_SHOULD_NOT_ENTER_DAEMON_PROMPT',
                  retrieved_for_team: {
                    id: 'team-payments',
                    name: 'Payments',
                  },
                },
              ],
            },
          } satisfies PlatformSessionMemoryRetrieval;
        },
      } as unknown as WorkflowPlatformContextClient;

      const selected = await resolvePromptNodeContext({
        run,
        nodeId: 'review',
        workflowContext: [],
        nodeContext: {
          include: [
            {
              source: 'session_memory',
              as: 'payments-memory',
              required: true,
              maxItems: 2,
            },
          ],
          query: 'payments rollback',
        },
        prompt: 'Review payments rollback.',
        platformContextClient,
      });

      expect(retrievalCalls).toHaveLength(1);
      expect(retrievalCalls[0]).toMatchObject({
        run,
        query: 'payments rollback',
        limit: 2,
      });
      expect(selected.promptBlock).toContain('<viewport_context>');
      expect(selected.promptBlock).toContain('payments-memory (session-memory)');
      expect(selected.promptBlock).toContain('Payments rollback rule');
      expect(selected.promptBlock).toContain('Memory digest: sha256:');
      expect(selected.promptBlock).toContain('Raw memory plaintext was not returned');
      expect(selected.promptBlock).not.toContain(
        'RAW_PAYMENT_MEMORY_SHOULD_NOT_ENTER_DAEMON_PROMPT',
      );
      expect(selected.basis.selectedItems).toEqual([
        expect.objectContaining({
          provider: 'session-memory',
          provider_id: 'ctx_payments',
          alias: 'payments-memory',
          digest: expect.stringMatching(/^sha256:/),
        }),
      ]);
      expect(run.contextReceipts).toEqual([
        expect.objectContaining({
          provider: 'session-memory',
          requested: 'ctx_payments',
          digest: expect.stringMatching(/^sha256:/),
          usedBy: expect.objectContaining({
            nodeId: 'review',
            providerId: 'ctx_payments',
            alias: 'payments-memory',
          }),
        }),
      ]);
      expect(run.events).toContainEqual(
        expect.objectContaining({
          type: 'session-memory-retrieved',
          nodeId: 'review',
          data: expect.objectContaining({
            receipt_id: 'receipt-memory-1',
            result_count: 1,
            raw_memory_plaintext_returned: false,
            learned_state_expands_access: false,
          }),
        }),
      );
      expect(JSON.stringify(run.events)).not.toContain(
        'RAW_PAYMENT_MEMORY_SHOULD_NOT_ENTER_DAEMON_PROMPT',
      );
    } finally {
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });

  it('injects addressed Product20 session mailbox content for the selected agent runtime', async () => {
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'viewport-session-mailbox-context-'),
    );
    try {
      const run = {
        ...workflowRun(projectDir),
        resourceId: 'workspace-product20',
        runtimeTargetId: 'runtime-target-1',
        platformRunId: 'workflow-run-1',
        inputs: {
          viewport: {
            workflow: {
              product20_policy_pin: {
                agent_session_id: 'agent-session-1',
              },
            },
          },
        },
      };
      const mailboxCalls: Array<{ run: WorkflowRunRecord; agentId: string }> = [];
      const platformContextClient = {
        async resolveNodePolicy() {
          return null;
        },
        async retrieveSessionMailbox(input: { run: WorkflowRunRecord; agentId: string }) {
          mailboxCalls.push(input);

          return {
            schema: 'viewport.agent_session_collaboration_mailbox_retrieval/v1',
            agent_session_id: 'agent-session-1',
            workflow_run_id: 'workflow-run-1',
            recipient: {
              actor_type: 'agent',
              actor_id: 'codex-reviewer',
            },
            mailboxes: [
              {
                schema: 'viewport.agent_session_runtime_mailbox/v1',
                recipient_key: 'agent:codex-reviewer',
                recipient: {
                  actor_type: 'agent',
                  actor_id: 'agent:codex-reviewer',
                },
                messages: [
                  {
                    schema: 'viewport.agent_session_runtime_mailbox_message/v1',
                    id: 'mailbox-message-1',
                    sender: {
                      actor_type: 'user',
                      actor_id: '42',
                    },
                    subject: 'Before publishing',
                    body_plaintext: 'RUNTIME_MAILBOX_BODY_FOR_CODEX_ONLY',
                    body_digest: digest('RUNTIME_MAILBOX_BODY_FOR_CODEX_ONLY'),
                    event_id: 'session-event-7',
                    sequence: 7,
                    sent_at: '2026-06-05T12:00:00.000Z',
                  },
                ],
              },
            ],
            source: {
              authoritative_source: 'session_events',
              runtime_lease_authorized: true,
            },
            redaction: {
              schema: 'viewport.agent_session_collaboration_mailbox_redaction/v1',
              raw_provider_keys_included: false,
              ciphertext_returned: false,
              body_plaintext_returned_to_recipient_runtime: true,
            },
          } satisfies PlatformSessionCollaborationMailboxRetrieval;
        },
      } as unknown as WorkflowPlatformContextClient;

      const selected = await resolvePromptNodeContext({
        run,
        nodeId: 'review',
        workflowContext: [],
        nodeContext: {
          include: [
            {
              source: 'session_mailbox',
              as: 'agent-mailbox',
              required: true,
            },
          ],
        },
        prompt: 'Review before publishing.',
        agentId: 'codex-reviewer',
        platformContextClient,
      });

      expect(mailboxCalls).toEqual([{ run, agentId: 'codex-reviewer' }]);
      expect(selected.promptBlock).toContain('<viewport_context>');
      expect(selected.promptBlock).toContain('agent-mailbox (session-mailbox)');
      expect(selected.promptBlock).toContain('Before publishing');
      expect(selected.promptBlock).toContain('RUNTIME_MAILBOX_BODY_FOR_CODEX_ONLY');
      expect(selected.basis.selectedItems).toEqual([
        expect.objectContaining({
          provider: 'session-mailbox',
          provider_id: 'session_mailbox',
          alias: 'agent-mailbox',
          digest: expect.stringMatching(/^sha256:/),
        }),
      ]);
      expect(run.contextReceipts).toEqual([
        expect.objectContaining({
          provider: 'session-mailbox',
          requested: 'session_mailbox',
          digest: expect.stringMatching(/^sha256:/),
          usedBy: expect.objectContaining({
            nodeId: 'review',
            providerId: 'session_mailbox',
            alias: 'agent-mailbox',
          }),
        }),
      ]);
      expect(run.events).toContainEqual(
        expect.objectContaining({
          type: 'session-mailbox-retrieved',
          nodeId: 'review',
          data: expect.objectContaining({
            agent_id: 'codex-reviewer',
            message_count: 1,
            plaintext_returned_to_recipient_runtime: true,
            raw_provider_keys_included: false,
          }),
        }),
      );
      expect(JSON.stringify(run.events)).not.toContain('RUNTIME_MAILBOX_BODY_FOR_CODEX_ONLY');
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
