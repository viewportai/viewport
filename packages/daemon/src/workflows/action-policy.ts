import type { WorkflowActionNode } from './types.js';

export function actionPolicyReason(node: WorkflowActionNode): string | null {
  const reason = node.policy?.reason?.trim();
  if (reason) return reason;
  if (node.requiresApproval === true) {
    return 'This side effect is configured to require human approval before execution.';
  }
  if (node.policy?.approvalRequired === true) {
    return 'Workflow policy requires human approval before this side effect executes.';
  }
  return null;
}
