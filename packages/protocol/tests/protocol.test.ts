import { describe, expect, it } from 'vitest';
import {
  CONTRACTS,
  SchemaIds,
  implementedContracts,
  readAllSamples,
  sampleFiles,
  targetOnlyContracts,
  validateSampleEnvelope,
} from '../src/index.js';

describe('@viewportai/protocol registry', () => {
  it('declares schema ids for every first-class contract', () => {
    expect(Object.values(SchemaIds)).toEqual([
      'viewport.workflow/v1',
      'viewport.repo_config/v1',
      'viewport.route/v1',
      'viewport.execution_profile/v1',
      'viewport.runner_workspace/v1',
      'viewport.context_package/v1',
      'viewport.agent_event/v1',
      'viewport.evidence/v1',
      'viewport.action_proposal/v1',
      'viewport.authorization_decision/v1',
      'viewport.approval_decision/v1',
      'viewport.context_receipt/v1',
      'viewport.audit_receipt/v1',
    ]);
  });

  it('keeps implemented and target-only contracts explicit', () => {
    expect(implementedContracts().map((contract) => contract.key)).toEqual([
      'workflow',
      'repoConfig',
      'route',
      'executionProfile',
      'evidence',
      'actionProposal',
      'approvalDecision',
      'auditReceipt',
    ]);
    expect(targetOnlyContracts().map((contract) => contract.key)).toEqual([
      'runnerWorkspace',
      'contextPackage',
      'agentEvent',
      'authorizationDecision',
      'contextReceipt',
    ]);
  });

  it('has one sample file per contract', () => {
    expect(sampleFiles()).toHaveLength(CONTRACTS.length);
    expect(new Set(sampleFiles()).size).toBe(sampleFiles().length);
  });

  it('loads all sample envelopes', async () => {
    const samples = await readAllSamples();
    expect(samples).toHaveLength(CONTRACTS.length);
    for (const sample of samples) {
      expect(validateSampleEnvelope(sample)).toEqual({ ok: true, issues: [] });
    }
  });

  it('rejects malformed route and execution profile samples', async () => {
    const samples = await readAllSamples();
    const route = samples.find((sample) => sample.contract.key === 'route');
    const profile = samples.find((sample) => sample.contract.key === 'executionProfile');

    expect(route).toBeDefined();
    expect(profile).toBeDefined();

    expect(
      validateSampleEnvelope({
        ...route!,
        document: {
          ...route!.document,
          resolve: { workflow: 'bug-to-pr' },
        },
      }).ok,
    ).toBe(false);

    expect(
      validateSampleEnvelope({
        ...profile!,
        document: {
          ...profile!.document,
          runner: {},
        },
      }).ok,
    ).toBe(false);
  });

  it('rejects malformed operational record samples', async () => {
    const samples = await readAllSamples();
    const evidence = samples.find((sample) => sample.contract.key === 'evidence');
    const action = samples.find((sample) => sample.contract.key === 'actionProposal');
    const approval = samples.find((sample) => sample.contract.key === 'approvalDecision');
    const audit = samples.find((sample) => sample.contract.key === 'auditReceipt');

    expect(evidence).toBeDefined();
    expect(action).toBeDefined();
    expect(approval).toBeDefined();
    expect(audit).toBeDefined();

    expect(
      validateSampleEnvelope({
        ...evidence!,
        document: {
          ...evidence!.document,
          title: '',
        },
      }).ok,
    ).toBe(false);

    expect(
      validateSampleEnvelope({
        ...action!,
        document: {
          ...action!.document,
          proposalDigest: 'not-a-digest',
        },
      }).ok,
    ).toBe(false);

    expect(
      validateSampleEnvelope({
        ...approval!,
        document: {
          ...approval!.document,
          subjectDigest: 'not-a-digest',
        },
      }).ok,
    ).toBe(false);

    expect(
      validateSampleEnvelope({
        ...audit!,
        document: {
          ...audit!.document,
          payloadDigest: 'not-a-digest',
        },
      }).ok,
    ).toBe(false);
  });
});
