import { SchemaIds, type SchemaId } from './schema-ids.js';

export type ContractStatus = 'implemented' | 'target-only';
export type CompatibilityState = 'validated' | 'stubbed' | 'pending' | 'not-applicable';

export interface ContractDefinition {
  readonly key: string;
  readonly schemaId: SchemaId;
  readonly sampleFile: string;
  readonly status: ContractStatus;
  readonly daemonCompatibility: CompatibilityState;
  readonly platformCompatibility: CompatibilityState;
  readonly webCompatibility: CompatibilityState;
  readonly notes: string;
}

export const CONTRACTS = [
  {
    key: 'workflow',
    schemaId: SchemaIds.workflow,
    sampleFile: 'workflow.bug-to-pr.yaml',
    status: 'implemented',
    daemonCompatibility: 'validated',
    platformCompatibility: 'validated',
    webCompatibility: 'pending',
    notes:
      'Implemented by daemon workflow parser and platform workflow-core/PHP validation family. Web projection fixture is still pending.',
  },
  {
    key: 'repoConfig',
    schemaId: SchemaIds.repoConfig,
    sampleFile: 'repo-config.sample.yaml',
    status: 'implemented',
    daemonCompatibility: 'validated',
    platformCompatibility: 'not-applicable',
    webCompatibility: 'not-applicable',
    notes:
      'Validated against daemon ViewportConfigSchema with version: 1. The schema: viewport.repo_config/v1 field is a Batch A protocol overlay accepted by the daemon passthrough parser.',
  },
  {
    key: 'route',
    schemaId: SchemaIds.route,
    sampleFile: 'route.payments-bugs.yaml',
    status: 'implemented',
    daemonCompatibility: 'pending',
    platformCompatibility: 'validated',
    webCompatibility: 'pending',
    notes:
      'Protocol package validates route shape. Platform stores route versions, validates ready resolve targets, projects latest-ready versions, and proves disabled routes fail closed during route-table matching.',
  },
  {
    key: 'executionProfile',
    schemaId: SchemaIds.executionProfile,
    sampleFile: 'execution-profile.payments.yaml',
    status: 'implemented',
    daemonCompatibility: 'pending',
    platformCompatibility: 'validated',
    webCompatibility: 'pending',
    notes:
      'Protocol package validates execution profile shape. Platform stores execution profile versions, validates runner pool targets, snapshots profile identity into runs, and proves disabled profiles fail closed after route matching.',
  },
  {
    key: 'runnerWorkspace',
    schemaId: SchemaIds.runnerWorkspace,
    sampleFile: 'runner-workspace.payments-vps.yaml',
    status: 'target-only',
    daemonCompatibility: 'pending',
    platformCompatibility: 'pending',
    webCompatibility: 'pending',
    notes: 'Runner capabilities exist, but workspace templates are not implemented.',
  },
  {
    key: 'contextPackage',
    schemaId: SchemaIds.contextPackage,
    sampleFile: 'context-package.payments-domain-rules.yaml',
    status: 'target-only',
    daemonCompatibility: 'pending',
    platformCompatibility: 'pending',
    webCompatibility: 'pending',
    notes: 'Context engine exists, but package registry semantics are not implemented.',
  },
  {
    key: 'agentEvent',
    schemaId: SchemaIds.agentEvent,
    sampleFile: 'agent-event.evidence.yaml',
    status: 'target-only',
    daemonCompatibility: 'pending',
    platformCompatibility: 'pending',
    webCompatibility: 'pending',
    notes: 'Current provider/workflow events need a mapper before this is implemented.',
  },
  {
    key: 'evidence',
    schemaId: SchemaIds.evidence,
    sampleFile: 'evidence.packet.yaml',
    status: 'implemented',
    daemonCompatibility: 'pending',
    platformCompatibility: 'validated',
    webCompatibility: 'pending',
    notes:
      'Protocol package validates evidence packet shape. Platform stores evidence packets and daemon emits first-pass node-output evidence; provider-normalized evidence quality remains pending.',
  },
  {
    key: 'actionProposal',
    schemaId: SchemaIds.actionProposal,
    sampleFile: 'action-proposal.github-pr.yaml',
    status: 'implemented',
    daemonCompatibility: 'validated',
    platformCompatibility: 'validated',
    webCompatibility: 'pending',
    notes:
      'Protocol package validates action proposal shape. Platform stores first-class action proposals, daemon emits proposals from local runs, and approvals are digest-bound.',
  },
  {
    key: 'authorizationDecision',
    schemaId: SchemaIds.authorizationDecision,
    sampleFile: 'authorization-decision.workflow-run.yaml',
    status: 'target-only',
    daemonCompatibility: 'pending',
    platformCompatibility: 'pending',
    webCompatibility: 'pending',
    notes:
      'Current authorization is spread across controllers/services; no portable decision record exists yet.',
  },
  {
    key: 'approvalDecision',
    schemaId: SchemaIds.approvalDecision,
    sampleFile: 'approval-decision.github-pr.yaml',
    status: 'implemented',
    daemonCompatibility: 'validated',
    platformCompatibility: 'validated',
    webCompatibility: 'pending',
    notes:
      'Protocol package validates approval decision shape. Platform stores approval decisions, daemon receives approved digests on resume, and stale digest approvals fail closed.',
  },
  {
    key: 'contextReceipt',
    schemaId: SchemaIds.contextReceipt,
    sampleFile: 'context-receipt.payments-domain-rules.yaml',
    status: 'target-only',
    daemonCompatibility: 'pending',
    platformCompatibility: 'pending',
    webCompatibility: 'pending',
    notes: 'Protocol package validates sample shape, but context usage receipts are not emitted as this contract yet.',
  },
  {
    key: 'auditReceipt',
    schemaId: SchemaIds.auditReceipt,
    sampleFile: 'audit-receipt.bug-to-pr.yaml',
    status: 'implemented',
    daemonCompatibility: 'validated',
    platformCompatibility: 'validated',
    webCompatibility: 'pending',
    notes:
      'Protocol package validates audit receipt shape. Platform stores audit receipts and daemon emits first-pass audit receipts; tamper-evident receipt linkage remains pending.',
  },
] as const satisfies readonly ContractDefinition[];

export type ContractKey = (typeof CONTRACTS)[number]['key'];

export function contractBySampleFile(sampleFile: string): ContractDefinition | undefined {
  return CONTRACTS.find((contract) => contract.sampleFile === sampleFile);
}

export function implementedContracts(): ContractDefinition[] {
  return CONTRACTS.filter((contract) => contract.status === 'implemented');
}

export function targetOnlyContracts(): ContractDefinition[] {
  return CONTRACTS.filter((contract) => contract.status === 'target-only');
}
