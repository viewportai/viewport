import { describe, expect, it } from 'vitest';
import {
  extractPlanProposalFromText,
  PLAN_PROPOSAL_MARKER,
  PLAN_PROPOSAL_SCHEMA_VERSION,
} from '../../src/hooks/plan-extractor.js';

describe('extractPlanProposalFromText', () => {
  it('extracts the canonical JSON viewport-plan contract', () => {
    const proposal = extractPlanProposalFromText(
      [
        'Agent output before the marker.',
        '```viewport-plan',
        JSON.stringify({
          schema: PLAN_PROPOSAL_SCHEMA_VERSION,
          title: 'Ship plan review loop',
          summary: 'Create, review, and approve a project plan.',
          body: '## Plan\n1. Create the plan\n2. Wait for approval',
          source: 'claude-code',
          source_ref: 'claude://session/session_1',
          metadata: { providerModel: 'sonnet' },
        }),
        '```',
      ].join('\n'),
    );

    expect(proposal).toMatchObject({
      title: 'Ship plan review loop',
      summary: 'Create, review, and approve a project plan.',
      body: '## Plan\n1. Create the plan\n2. Wait for approval',
      source: 'claude-code',
      sourceRef: 'claude://session/session_1',
      metadata: {
        providerModel: 'sonnet',
        extractedFrom: 'explicit-marker',
        marker: PLAN_PROPOSAL_MARKER,
        schema: PLAN_PROPOSAL_SCHEMA_VERSION,
        format: 'json',
      },
    });
  });

  it('extracts the frontmatter viewport-plan contract from HTML comments', () => {
    const proposal = extractPlanProposalFromText(
      [
        '<!-- viewport-plan',
        `schema: ${PLAN_PROPOSAL_SCHEMA_VERSION}`,
        'title: Review deployment strategy',
        'summary: Make the deployment plan reviewable.',
        'source: codex',
        'source_ref: codex://session/session_2',
        '---',
        '## Plan',
        '1. Inspect deployment scripts.',
        '2. Ask for approval before rollout.',
        '-->',
      ].join('\n'),
    );

    expect(proposal).toMatchObject({
      title: 'Review deployment strategy',
      summary: 'Make the deployment plan reviewable.',
      body: '## Plan\n1. Inspect deployment scripts.\n2. Ask for approval before rollout.',
      source: 'codex',
      sourceRef: 'codex://session/session_2',
      metadata: {
        extractedFrom: 'explicit-marker',
        marker: PLAN_PROPOSAL_MARKER,
        schema: PLAN_PROPOSAL_SCHEMA_VERSION,
        format: 'frontmatter',
      },
    });
  });

  it('rejects unsupported explicit plan contract versions', () => {
    const proposal = extractPlanProposalFromText(
      [
        '```viewport-plan',
        JSON.stringify({
          schema: 'viewport.plan_proposal/v0',
          body: 'This should not become a durable plan.',
        }),
        '```',
      ].join('\n'),
    );

    expect(proposal).toBeNull();
  });

  it('rejects explicit plan markers without a supported schema', () => {
    expect(
      extractPlanProposalFromText(
        [
          '```viewport-plan',
          JSON.stringify({
            body: 'Missing schemas should not become durable plans.',
          }),
          '```',
        ].join('\n'),
      ),
    ).toBeNull();

    expect(
      extractPlanProposalFromText(
        ['```viewport-plan', 'This is marked but not a contract.', '```'].join('\n'),
      ),
    ).toBeNull();
  });

  it('rejects JSON viewport-plan blocks with ambiguous plan bodies', () => {
    expect(
      extractPlanProposalFromText(
        [
          '```viewport-plan',
          JSON.stringify({
            schema: PLAN_PROPOSAL_SCHEMA_VERSION,
            body: 'Body A',
            plan_markdown: 'Body B',
          }),
          '```',
        ].join('\n'),
      ),
    ).toBeNull();
  });

  it('sanitizes JSON viewport-plan metadata before emitting proposals', () => {
    const proposal = extractPlanProposalFromText(
      [
        '```viewport-plan',
        JSON.stringify({
          schema: PLAN_PROPOSAL_SCHEMA_VERSION,
          body: 'Plan body',
          metadata: {
            providerModel: 'sonnet',
            resourceId: 'agent-controlled-project',
            secret: 'do-not-broadcast',
            nested: { unsafe: true },
          },
        }),
        '```',
      ].join('\n'),
    );

    expect(proposal?.metadata).toEqual({
      providerModel: 'sonnet',
      extractedFrom: 'explicit-marker',
      marker: PLAN_PROPOSAL_MARKER,
      schema: PLAN_PROPOSAL_SCHEMA_VERSION,
      format: 'json',
    });
  });

  it('does not infer plan proposals from unmarked prose', () => {
    expect(extractPlanProposalFromText('Here is my plan: do the work.')).toBeNull();
  });
});
