import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolvePromptNodeContext,
  sanitizeContextQueryForReceipt,
} from '../../src/workflows/context-node-resolver.js';

describe('context node resolver receipts', () => {
  it('redacts Slack and provider secrets from stored context query receipts', () => {
    const query =
      'Slack event: {"token":"slack_verification_secret","event":{"text":"hello"},"access_token":"xoxb-real-token"} ' +
      "headers: {'api_key':'sk-openai-secret'} git=ghs_github_secret runner=vprunner_secret";

    const redacted = sanitizeContextQueryForReceipt(query);

    expect(redacted).toContain('"token":"[redacted]"');
    expect(redacted).toContain('"access_token":"[redacted]"');
    expect(redacted).toContain("'api_key':'[redacted]'");
    expect(redacted).not.toContain('slack_verification_secret');
    expect(redacted).not.toContain('xoxb-real-token');
    expect(redacted).not.toContain('sk-openai-secret');
    expect(redacted).not.toContain('ghs_github_secret');
    expect(redacted).not.toContain('vprunner_secret');
  });

  it('allows approved workflow plan artifacts without external context expansion', async () => {
    const run = {
      id: 'run_approved_context',
      status: 'running',
      inputs: {
        repo_context: 'git://viewportai/vp-example-repo',
      },
      nodes: {
        review_plan: {
          id: 'review_plan',
          type: 'plan',
          status: 'completed',
          output: 'Approved plan body from PM review.',
        },
      },
      events: [],
      resourceManifest: {
        contract: {
          contextProviders: [],
          contextResolution: {},
        },
      },
    } as any;

    const selection = await resolvePromptNodeContext({
      run,
      nodeId: 'draft_implementation_plan',
      prompt: 'Create an implementation plan.',
      workflowContext: {
        sources: ['{{ inputs.repo_context }}'],
      },
      nodeContext: {
        include: ['{{ inputs.repo_context }}', { artifact: 'review_plan.approved_body' }],
      },
    });

    expect(selection.promptBlock).toContain('Approved plan body from PM review.');
    expect(selection.basis.selectedItems).toEqual([
      expect.objectContaining({
        provider: 'workflow-artifact',
        provider_id: 'review_plan.approved_body',
      }),
    ]);
  });

  it('still blocks non-workflow external context expansion without policy approval', async () => {
    const run = {
      id: 'run_blocked_context',
      status: 'running',
      inputs: {
        allowed: 'git://viewportai/vp-example-docs/docs/runbooks/support-triage.md',
      },
      nodes: {},
      events: [],
      resourceManifest: {
        contract: {
          contextProviders: [],
          contextResolution: {},
        },
      },
    } as any;

    await expect(
      resolvePromptNodeContext({
        run,
        nodeId: 'draft_plan',
        prompt: 'Create a plan.',
        workflowContext: {
          sources: ['{{ inputs.allowed }}'],
        },
        nodeContext: {
          include: ['{{ inputs.allowed }}', 'git://viewportai/other-repo'],
        },
      }),
    ).rejects.toThrow('Node context includes refs outside workflow defaults');
  });

  it('selects configured git-backed context providers for git source refs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-git-context-ref-'));
    try {
      await fs.mkdir(path.join(root, '.viewport'), { recursive: true });
      await fs.mkdir(path.join(root, 'docs', 'runbooks'), { recursive: true });
      await fs.writeFile(path.join(root, '.viewport', 'config.yaml'), 'version: 1\n', 'utf8');
      await fs.writeFile(
        path.join(root, 'docs', 'runbooks', 'integration-pr-review.md'),
        'Require replay and stale timestamp tests for webhook signature changes.',
        'utf8',
      );

      const run = {
        id: 'run_git_context_ref',
        status: 'running',
        inputs: {
          review_context: 'git://viewportai/vp-example-docs/docs/runbooks/integration-pr-review.md',
        },
        nodes: {},
        events: [],
        resourceManifest: {
          contract: {
            contextProviders: [
              {
                id: 'vp_example_docs_runbooks',
                provider: 'repo-docs',
                paths: ['docs/runbooks/integration-pr-review.md'],
                sourceConfigPath: path.join(root, '.viewport', 'config.yaml'),
              },
            ],
            contextResolution: {},
          },
        },
      } as any;

      const selection = await resolvePromptNodeContext({
        run,
        nodeId: 'review_pr',
        prompt: 'Review the PR.',
        workflowContext: {
          sources: ['{{ inputs.review_context }}'],
        },
        nodeContext: {
          include: ['{{ inputs.review_context }}'],
        },
      });

      expect(selection.promptBlock).toContain('Require replay and stale timestamp tests');
      expect(selection.basis.selectedItems).toEqual([
        expect.objectContaining({
          provider: 'repo-docs',
          title: 'docs/runbooks/integration-pr-review.md',
        }),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
