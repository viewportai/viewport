import type {
  ManagedAssignment,
  ManagedWorkerCapabilities,
} from './workflow-managed-worker-types.js';
import { sanitizeWorkflowApprovalActor } from '../workflows/approval-actor.js';
import type { WorkflowApprovalActor, WorkflowRunRecord } from '../workflows/types.js';

export { workflowRunToSyncPayload as localRunToSyncPayload } from '../workflows/platform-sync-payload.js';

export function capabilityPayload(
  capabilities: ManagedWorkerCapabilities,
): Record<string, unknown> {
  const tools = [...new Set(['shell', ...capabilities.tools])];
  const agents = agentCapabilityPayload(capabilities.agents, capabilities.models, tools);

  return {
    tools,
    ...(capabilities.runnerPool ? { runner_pool: capabilities.runnerPool } : {}),
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
    ...(capabilities.models.length > 0 ? { models: capabilities.models } : {}),
    ...(capabilities.integrations.length > 0 ? { integrations: capabilities.integrations } : {}),
    ...((capabilities.actionCommand || capabilities.providerActions) &&
    capabilities.integrations.length > 0
      ? { action_replay: capabilities.integrations }
      : {}),
    ...(capabilities.secrets.length > 0 ? { secrets: capabilities.secrets } : {}),
  };
}

function agentCapabilityPayload(
  agents: string[],
  models: string[],
  tools: string[],
): Record<string, Record<string, unknown>> {
  const uniqueAgents = [...new Set(agents.filter((agent) => agent.trim() !== ''))];
  const uniqueModels = [...new Set(models.filter((model) => model.trim() !== ''))];

  return Object.fromEntries(
    uniqueAgents.map((agent) => {
      const scopedModels = uniqueModels.filter((model) => modelLooksOwnedByAgent(agent, model));
      const assignedModels =
        scopedModels.length > 0 || uniqueAgents.length > 1 ? scopedModels : uniqueModels;

      return [
        agent,
        {
          available: true,
          models: assignedModels,
          ...(assignedModels[0] ? { default_model: assignedModels[0] } : {}),
          tools: toolsForAgent(agent, tools),
          supports_plan_mode: agent === 'claude',
        },
      ];
    }),
  );
}

function modelLooksOwnedByAgent(agent: string, model: string): boolean {
  const normalizedAgent = agent.toLowerCase();
  const normalizedModel = model.toLowerCase();
  if (normalizedAgent.includes('claude')) {
    return (
      normalizedModel.includes('claude') ||
      normalizedModel.includes('opus') ||
      normalizedModel.includes('sonnet') ||
      normalizedModel.includes('haiku')
    );
  }
  if (normalizedAgent.includes('codex') || normalizedAgent.includes('openai')) {
    return normalizedModel.includes('gpt') || normalizedModel.includes('codex') || normalizedModel.includes('o3');
  }
  if (normalizedAgent.includes('gemini')) {
    return normalizedModel.includes('gemini');
  }

  return false;
}

function toolsForAgent(agent: string, tools: string[]): string[] {
  const baseTools = new Set(tools);
  if (agent === 'codex') {
    baseTools.add('apply_patch');
    baseTools.add('git');
  }
  if (agent === 'claude') {
    baseTools.add('shell');
  }

  return [...baseTools];
}

export function dataFrom(body: unknown): unknown {
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}

export function readRun(body: unknown): WorkflowRunRecord {
  const run =
    body && typeof body === 'object' && 'run' in body ? (body as { run: unknown }).run : body;
  if (!run || typeof run !== 'object' || typeof (run as { id?: unknown }).id !== 'string') {
    throw new Error('Daemon workflow response did not include a run.');
  }
  return run as WorkflowRunRecord;
}

export function approvalMessage(node: NonNullable<ManagedAssignment['nodes']>[number]): string {
  const approval = node.metadata?.['approval'];
  if (approval && typeof approval === 'object' && 'message' in approval) {
    const message = (approval as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return node.output ?? 'Approved from Viewport';
}

export function approvalActor(
  node: NonNullable<ManagedAssignment['nodes']>[number],
): WorkflowApprovalActor {
  const approval = node.metadata?.['approval'];
  const actor =
    approval && typeof approval === 'object' ? (approval as { actor?: unknown }).actor : null;
  return sanitizeWorkflowApprovalActor(actor) ?? { name: 'Viewport', source: 'managed-executor' };
}

export function approvalExpectedActionDigest(
  node: NonNullable<ManagedAssignment['nodes']>[number],
): string | undefined {
  const approval = node.metadata?.['approval'];
  if (approval && typeof approval === 'object') {
    const digest = (approval as { actionDigest?: unknown }).actionDigest;
    if (typeof digest === 'string' && digest.trim() !== '') return digest;
  }
  const action = node.metadata?.['action'];
  if (action && typeof action === 'object') {
    const digest = (action as { digest?: unknown }).digest;
    if (typeof digest === 'string' && digest.trim() !== '') return digest;
  }
  return undefined;
}

export function approvalExecutionGrant(
  node: NonNullable<ManagedAssignment['nodes']>[number],
): Record<string, string> | undefined {
  const approval = node.metadata?.['approval'];
  if (!approval || typeof approval !== 'object') return undefined;
  const grant =
    (approval as { executionGrant?: unknown; execution_grant?: unknown }).executionGrant ??
    (approval as { execution_grant?: unknown }).execution_grant;
  if (!grant || typeof grant !== 'object') return undefined;
  const record = grant as Record<string, unknown>;
  const digest = stringValue(record['digest']);
  if (!digest) return undefined;

  return {
    ...(stringValue(record['schema']) ? { schema: stringValue(record['schema']) as string } : {}),
    digest,
    ...(stringValue(record['proposal_key'])
      ? { proposal_key: stringValue(record['proposal_key']) as string }
      : {}),
    ...(stringValue(record['approval_decision_key'])
      ? { approval_decision_key: stringValue(record['approval_decision_key']) as string }
      : {}),
    ...(stringValue(record['issued_at'])
      ? { issued_at: stringValue(record['issued_at']) as string }
      : {}),
  };
}

export function approvalFeedback(
  node: NonNullable<ManagedAssignment['nodes']>[number],
): Record<string, unknown> | undefined {
  const approval = node.metadata?.['approval'];
  if (!approval || typeof approval !== 'object') return undefined;
  const feedback = (approval as { feedback?: unknown }).feedback;
  if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback)) return undefined;

  return feedback as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function progressSyncEveryMs(leaseSeconds: number): number {
  return Math.max(500, Math.min(30_000, Math.floor(leaseSeconds * 500)));
}
