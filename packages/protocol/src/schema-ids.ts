export const SchemaIds = {
  workflow: 'viewport.workflow/v1',
  repoConfig: 'viewport.repo_config/v1',
  route: 'viewport.route/v1',
  executionProfile: 'viewport.execution_profile/v1',
  runnerWorkspace: 'viewport.runner_workspace/v1',
  contextPackage: 'viewport.context_package/v1',
  agentEvent: 'viewport.agent_event/v1',
  evidence: 'viewport.evidence/v1',
  actionProposal: 'viewport.action_proposal/v1',
  authorizationDecision: 'viewport.authorization_decision/v1',
  approvalDecision: 'viewport.approval_decision/v1',
  contextReceipt: 'viewport.context_receipt/v1',
  auditReceipt: 'viewport.audit_receipt/v1',
} as const;

export type SchemaId = (typeof SchemaIds)[keyof typeof SchemaIds];
