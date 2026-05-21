import { addEvent } from './runtime-helpers.js';
import { rememberExecutedAction } from './action-execution-ledger.js';
import { sanitizeActionInput, workflowActionProposalDigest } from './action-digest.js';
import { actionPolicyReason } from './action-policy.js';
import {
  booleanValue,
  compactObject,
  githubHeaders,
  idempotencyKeyFromHeaders,
  jiraDocument,
  jiraHeaders,
  normalizedBaseUrl,
  objectBoolean,
  objectNumber,
  objectString,
  parseJson,
  providerCredentialValue,
  safeResponseText,
  stringValue,
  withIdempotencyHeader,
} from './action-provider-utils.js';
import {
  githubReconciliationRequest,
  jiraCommentReconciliationRequest,
  reconcileProviderAction,
  slackMessageReconciliationRequest,
  type ProviderReconciliationRequest,
} from './provider-reconciliation.js';
import type { WorkflowActionNode, WorkflowInputValue, WorkflowRunRecord } from './types.js';

const MAX_RESPONSE_CHARS = 4_000;

export interface ActionResult {
  output: string;
  metadata: Record<string, unknown>;
}

export class WorkflowActionError extends Error {
  constructor(
    message: string,
    readonly result: ActionResult,
  ) {
    super(message);
  }
}

export async function executeProviderAction(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  actionInput: Record<string, WorkflowInputValue>,
  options: { idempotencyKey?: string } = {},
): Promise<ActionResult | null> {
  if (node.adapter === 'github') {
    return executeGitHubAction(run, nodeId, node, actionInput, options);
  }
  if (node.adapter === 'jira') {
    return executeJiraAction(run, nodeId, node, actionInput, options);
  }
  if (node.adapter === 'slack') {
    return executeSlackAction(run, nodeId, node, actionInput, options);
  }
  return null;
}

async function executeGitHubAction(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  actionInput: Record<string, WorkflowInputValue>,
  options: { idempotencyKey?: string },
): Promise<ActionResult> {
  const owner = stringValue(actionInput['owner']);
  const repo = stringValue(actionInput['repo']);
  const token = providerCredentialValue(actionInput, {
    defaultRef: 'github/token',
    defaultEnv: 'GITHUB_TOKEN',
  });
  if (!owner || !repo || !token) {
    return declaredProviderAction(node, 'missing_url', options.idempotencyKey, actionInput);
  }

  if (node.action === 'create_pr' || node.action === 'create_pull_request') {
    return executeJsonApiAction(run, nodeId, node, {
      method: 'POST',
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      headers: withIdempotencyHeader(githubHeaders(token), options.idempotencyKey),
      proposalInput: actionInput,
      body: {
        title: stringValue(actionInput['title']) ?? 'Viewport workflow change',
        head: stringValue(actionInput['head']) ?? stringValue(actionInput['branch']),
        base: stringValue(actionInput['base']) ?? 'main',
        body: stringValue(actionInput['body']),
        draft: booleanValue(actionInput['draft']),
      },
      reconcile: (parsed) =>
        githubReconciliationRequest(githubHeaders(token), parsed, 'pull_request'),
    });
  }

  if (node.action === 'comment' || node.action === 'comment_issue') {
    const issueNumber =
      stringValue(actionInput['issue_number']) ?? stringValue(actionInput['issueNumber']);
    const body = stringValue(actionInput['body']);
    if (!issueNumber || !body) {
      return declaredProviderAction(node, 'missing_url', options.idempotencyKey, actionInput);
    }
    return executeJsonApiAction(run, nodeId, node, {
      method: 'POST',
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(issueNumber)}/comments`,
      headers: withIdempotencyHeader(githubHeaders(token), options.idempotencyKey),
      proposalInput: actionInput,
      body: { body },
      reconcile: (parsed) =>
        githubReconciliationRequest(githubHeaders(token), parsed, 'issue_comment'),
    });
  }

  return declaredProviderAction(node, 'declared', options.idempotencyKey, actionInput);
}

async function executeJiraAction(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  actionInput: Record<string, WorkflowInputValue>,
  options: { idempotencyKey?: string },
): Promise<ActionResult> {
  const baseUrl = normalizedBaseUrl(
    stringValue(actionInput['base_url']) ??
      stringValue(actionInput['baseUrl']) ??
      process.env['JIRA_BASE_URL'],
  );
  const token = providerCredentialValue(actionInput, {
    defaultRef: 'jira/token',
    defaultEnv: 'JIRA_API_TOKEN',
  });
  const email = stringValue(actionInput['email']) ?? process.env['JIRA_EMAIL'];
  const issueKey =
    stringValue(actionInput['issue_key']) ??
    stringValue(actionInput['issueKey']) ??
    stringValue(actionInput['key']);
  if (!baseUrl || !token || !issueKey) {
    return declaredProviderAction(node, 'missing_url', options.idempotencyKey, actionInput);
  }

  if (
    node.action === 'comment' ||
    node.action === 'comment_issue' ||
    node.action === 'issue.comment'
  ) {
    const body = stringValue(actionInput['body']);
    if (!body)
      return declaredProviderAction(node, 'missing_url', options.idempotencyKey, actionInput);
    return executeJsonApiAction(run, nodeId, node, {
      method: 'POST',
      url: `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      headers: withIdempotencyHeader(jiraHeaders(token, email), options.idempotencyKey),
      proposalInput: actionInput,
      body: { body: jiraDocument(body) },
      reconcile: (parsed) =>
        jiraCommentReconciliationRequest(baseUrl, jiraHeaders(token, email), parsed),
    });
  }

  if (node.action === 'transition' || node.action === 'issue.transition') {
    const transitionId =
      stringValue(actionInput['transition_id']) ?? stringValue(actionInput['transitionId']);
    if (!transitionId)
      return declaredProviderAction(node, 'missing_url', options.idempotencyKey, actionInput);
    return executeJsonApiAction(run, nodeId, node, {
      method: 'POST',
      url: `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
      headers: withIdempotencyHeader(jiraHeaders(token, email), options.idempotencyKey),
      proposalInput: actionInput,
      body: { transition: { id: transitionId } },
      reconciliationUnsupported:
        'Jira transition actions need an expected target status before generic read-after-write verification can prove the transition.',
    });
  }

  return declaredProviderAction(node, 'declared', options.idempotencyKey, actionInput);
}

async function executeSlackAction(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  actionInput: Record<string, WorkflowInputValue>,
  options: { idempotencyKey?: string },
): Promise<ActionResult> {
  const token = providerCredentialValue(actionInput, {
    defaultRef: 'slack/bot-token',
    defaultEnv: 'SLACK_BOT_TOKEN',
  });
  const channel = stringValue(actionInput['channel']);
  const text = stringValue(actionInput['text']) ?? stringValue(actionInput['body']);
  if (!token || !channel || !text) {
    return declaredProviderAction(node, 'missing_url', options.idempotencyKey, actionInput);
  }

  if (
    node.action === 'post_message' ||
    node.action === 'message' ||
    node.action === 'chat.postMessage'
  ) {
    return executeJsonApiAction(run, nodeId, node, {
      method: 'POST',
      url: 'https://slack.com/api/chat.postMessage',
      headers: withIdempotencyHeader({ Authorization: `Bearer ${token}` }, options.idempotencyKey),
      proposalInput: actionInput,
      body: {
        channel,
        text,
        client_msg_id: options.idempotencyKey,
        thread_ts: stringValue(actionInput['thread_ts']) ?? stringValue(actionInput['threadTs']),
      },
      okFromBody: true,
      reconcile: (parsed) =>
        slackMessageReconciliationRequest({ Authorization: `Bearer ${token}` }, parsed),
    });
  }

  return declaredProviderAction(node, 'declared', options.idempotencyKey, actionInput);
}

async function executeJsonApiAction(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    proposalInput: Record<string, WorkflowInputValue>;
    body: Record<string, unknown>;
    okFromBody?: boolean;
    reconcile?: (parsed: unknown) => ProviderReconciliationRequest | null;
    reconciliationUnsupported?: string;
  },
): Promise<ActionResult> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: {
      Accept: 'application/vnd.github+json, application/json;q=0.9, */*;q=0.8',
      'Content-Type': 'application/json',
      ...request.headers,
    },
    body: JSON.stringify(compactObject(request.body)),
  });
  const responseText = await safeResponseText(response);
  const parsed = parseJson(responseText);
  const appOk = request.okFromBody ? objectBoolean(parsed, 'ok') !== false : true;
  const ok = response.ok && appOk;
  const providerReconciliation = ok
    ? await reconcileProviderAction(
        request.reconcile?.(parsed) ?? null,
        request.reconciliationUnsupported,
        parsed,
      )
    : null;
  const metadata = {
    action: {
      adapter: node.adapter,
      action: node.action,
      proposalKey: node.proposalKey ?? null,
      idempotencyKey: idempotencyKeyFromHeaders(request.headers) ?? null,
      requiresApproval: node.requiresApproval === true,
      policyReason: actionPolicyReason(node),
      status: ok ? 'executed' : 'failed',
      digest: workflowActionProposalDigest(node, {
        idempotencyKey: idempotencyKeyFromHeaders(request.headers),
        input: request.proposalInput,
      }),
      input: sanitizeActionInput(request.proposalInput),
      request: { method: request.method, url: request.url },
      response: {
        status: response.status,
        ok,
        bodyExcerpt: responseText.slice(0, MAX_RESPONSE_CHARS),
        htmlUrl: objectString(parsed, 'html_url'),
        apiUrl: objectString(parsed, 'url'),
        number: objectNumber(parsed, 'number'),
        channel: objectString(parsed, 'channel'),
        ts: objectString(parsed, 'ts'),
        error: objectString(parsed, 'error'),
      },
      ...(providerReconciliation
        ? {
            providerReconciliation,
            provider_reconciliation: providerReconciliation,
          }
        : {}),
      ...approvedExecutionGrant(run, nodeId, node.requiresApproval === true),
    },
  };

  addEvent(
    run,
    ok ? 'action-executed' : 'action-failed',
    ok
      ? `Action node ${nodeId} executed ${node.adapter}.${node.action}`
      : `Action node ${nodeId} failed ${node.adapter}.${node.action}`,
    metadata,
    nodeId,
  );

  if (!ok) {
    throw new WorkflowActionError(
      `Action ${nodeId} failed with HTTP ${response.status}: ${responseText}`,
      {
        output: `${node.adapter}.${node.action} ${response.status}`,
        metadata,
      },
    );
  }

  rememberExecutedAction(
    run,
    nodeId,
    node,
    idempotencyKeyFromHeaders(request.headers),
    request.proposalInput,
    {
      output: `${node.adapter}.${node.action} ${response.status}`,
      response: metadata.action.response,
      ...(providerReconciliation ? { providerReconciliation } : {}),
    },
  );

  return {
    output: `${node.adapter}.${node.action} ${response.status}`,
    metadata,
  };
}

function declaredProviderAction(
  node: WorkflowActionNode,
  status: 'declared' | 'missing_url',
  idempotencyKey: string | undefined,
  actionInput: Record<string, WorkflowInputValue>,
): ActionResult {
  return {
    output: `${node.adapter}.${node.action}`,
    metadata: {
      action: {
        adapter: node.adapter,
        action: node.action,
        proposalKey: node.proposalKey ?? null,
        idempotencyKey: idempotencyKey ?? null,
        requiresApproval: node.requiresApproval === true,
        policyReason: actionPolicyReason(node),
        status,
        digest: workflowActionProposalDigest(node, {
          idempotencyKey,
          input: actionInput,
        }),
        input: sanitizeActionInput(actionInput),
      },
    },
  };
}

function approvedExecutionGrant(
  run: WorkflowRunRecord,
  nodeId: string,
  requiresApproval: boolean,
): Record<string, unknown> {
  if (!requiresApproval) return {};
  const grant = run.nodes[nodeId]?.approval?.executionGrant;
  return grant ? { executionGrant: grant, execution_grant: grant } : {};
}
