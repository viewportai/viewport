import { addEvent, renderTemplate } from './runtime-helpers.js';
import { executeProviderAction, type ActionResult } from './action-provider-adapters.js';
import { sanitizeActionInput, workflowActionProposalDigest } from './action-digest.js';
import { rememberExecutedAction, suppressDuplicateAction } from './action-execution-ledger.js';
import { actionPolicyReason } from './action-policy.js';
import type { WorkflowActionNode, WorkflowInputValue, WorkflowRunRecord } from './types.js';

const MAX_RESPONSE_CHARS = 4_000;

export { WorkflowActionError } from './action-provider-adapters.js';

export async function executeActionAdapter(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  options: { approved?: boolean } = {},
): Promise<ActionResult> {
  const idempotencyKey = await renderOptionalTemplate(run, node.idempotencyKey);
  const actionInput = await renderActionInput(run, node.with ?? {});
  const duplicate = suppressDuplicateAction(run, nodeId, node, idempotencyKey, actionInput);
  if (duplicate) return duplicate;

  if (node.requiresApproval === true && options.approved !== true) {
    return declaredAction(run, nodeId, node, 'awaiting_approval', idempotencyKey, actionInput);
  }

  if (node.adapter === 'webhook' || node.adapter === 'http') {
    return executeWebhookAction(run, nodeId, node, idempotencyKey, actionInput);
  }

  const providerAction = await executeProviderAction(run, nodeId, node, actionInput, {
    idempotencyKey,
  });
  if (providerAction) return providerAction;

  return declaredAction(run, nodeId, node, 'declared', idempotencyKey, actionInput);
}

async function executeWebhookAction(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  idempotencyKey: string | undefined,
  actionInput: Record<string, WorkflowInputValue>,
): Promise<ActionResult> {
  const url = stringValue(actionInput['url']);
  if (!url) return declaredAction(run, nodeId, node, 'missing_url', idempotencyKey, actionInput);

  const method = stringValue(actionInput['method']) ?? actionMethod(node.action);
  const headers = headerRecord(actionInput['headers']);
  const body = actionInput['body'];
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
      ...idempotencyHeader(headers, idempotencyKey),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const responseText = await safeResponseText(response);
  const metadata = {
    action: {
      adapter: node.adapter,
      action: node.action,
      idempotencyKey: idempotencyKey ?? null,
      requiresApproval: node.requiresApproval === true,
      status: response.ok ? 'executed' : 'failed',
      digest: workflowActionProposalDigest(node, { idempotencyKey, input: actionInput }),
      input: sanitizeActionInput(actionInput),
      request: { method, url },
      response: {
        status: response.status,
        ok: response.ok,
        bodyExcerpt: responseText.slice(0, MAX_RESPONSE_CHARS),
      },
    },
  };

  addEvent(
    run,
    response.ok ? 'action-executed' : 'action-failed',
    response.ok
      ? `Action node ${nodeId} executed ${node.adapter}.${node.action}`
      : `Action node ${nodeId} failed ${node.adapter}.${node.action}`,
    metadata,
    nodeId,
  );

  if (!response.ok) {
    throw new Error(`Action ${nodeId} failed with HTTP ${response.status}: ${responseText}`);
  }

  rememberExecutedAction(run, nodeId, node, idempotencyKey, actionInput, {
    output: `${node.adapter}.${node.action} ${response.status}`,
    response: metadata.action.response,
  });

  return {
    output: `${node.adapter}.${node.action} ${response.status}`,
    metadata,
  };
}

async function renderActionInput(
  run: WorkflowRunRecord,
  value: Record<string, WorkflowInputValue>,
): Promise<Record<string, WorkflowInputValue>> {
  return (await renderActionValue(run, value)) as Record<string, WorkflowInputValue>;
}

async function renderOptionalTemplate(
  run: WorkflowRunRecord,
  value: string | undefined,
): Promise<string | undefined> {
  if (!value) return undefined;
  const rendered = await renderTemplate(value, run);
  return rendered.trim() === '' ? undefined : rendered;
}

async function renderActionValue(
  run: WorkflowRunRecord,
  value: WorkflowInputValue,
): Promise<WorkflowInputValue> {
  if (typeof value === 'string') return await renderTemplate(value, run);
  if (Array.isArray(value)) {
    return await Promise.all(value.map((entry) => renderActionValue(run, entry)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, entry]) => [
          key,
          await renderActionValue(run, entry),
        ]),
      ),
    );
  }
  return value;
}

function declaredAction(
  _run: WorkflowRunRecord,
  _nodeId: string,
  node: WorkflowActionNode,
  status: 'awaiting_approval' | 'declared' | 'missing_url',
  idempotencyKey: string | undefined,
  actionInput: Record<string, WorkflowInputValue>,
): ActionResult {
  return {
    output: `${node.adapter}.${node.action}`,
    metadata: {
      action: {
        adapter: node.adapter,
        action: node.action,
        idempotencyKey: idempotencyKey ?? null,
        requiresApproval: node.requiresApproval === true,
        policyReason: actionPolicyReason(node),
        status,
        digest: workflowActionProposalDigest(node, { idempotencyKey, input: actionInput }),
        input: sanitizeActionInput(actionInput),
      },
    },
  };
}

function actionMethod(action: string): string {
  if (action === 'get') return 'GET';
  if (action === 'put') return 'PUT';
  if (action === 'patch') return 'PATCH';
  if (action === 'delete') return 'DELETE';
  return 'POST';
}

function idempotencyHeader(
  headers: Record<string, string>,
  idempotencyKey: string | undefined,
): Record<string, string> {
  if (!idempotencyKey) return {};
  const alreadySet = Object.keys(headers).some((key) => key.toLowerCase() === 'idempotency-key');
  return alreadySet ? {} : { 'Idempotency-Key': idempotencyKey };
}

function headerRecord(value: WorkflowInputValue | undefined): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, entry]) => [key, entry]),
  );
}

function stringValue(value: WorkflowInputValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
