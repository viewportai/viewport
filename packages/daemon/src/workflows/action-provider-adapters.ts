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
  const repository = stringValue(actionInput['repository']);
  const [repositoryOwner, repositoryName] = splitRepository(repository);
  const owner = stringValue(actionInput['owner']) ?? repositoryOwner;
  const repo = stringValue(actionInput['repo']) ?? repositoryName;
  const token = providerCredentialValue(actionInput, {
    defaultRef: 'github/token',
    defaultEnv: 'GITHUB_TOKEN',
  });
  if (!owner || !repo) {
    return declaredProviderAction(node, 'missing_url', options.idempotencyKey, actionInput);
  }
  assertGitHubBrokeredCredential(run, nodeId, node, actionInput, token, options.idempotencyKey);

  if (isGitHubPullRequestCreateAction(node.action)) {
    const title = stringValue(actionInput['title']) ?? 'Viewport workflow change';
    const head = stringValue(actionInput['head']) ?? stringValue(actionInput['branch']);
    const base = stringValue(actionInput['base']) ?? 'main';
    const body = stringValue(actionInput['body']);
    const existing = await existingGitHubPullRequest(
      run,
      nodeId,
      node,
      actionInput,
      {
        owner,
        repo,
        token,
        head,
        base,
      },
      options.idempotencyKey,
    );
    if (existing) return existing;

    return executeJsonApiAction(run, nodeId, node, {
      method: 'POST',
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      headers: withIdempotencyHeader(githubHeaders(token), options.idempotencyKey),
      proposalInput: actionInput,
      body: {
        title,
        head,
        base,
        body,
        draft: booleanValue(actionInput['draft']),
      },
      reconcile: (parsed) =>
        githubReconciliationRequest(githubHeaders(token), parsed, 'pull_request'),
    });
  }

  if (isGitHubCommentAction(node.action)) {
    const issueNumber =
      stringValue(actionInput['issue_number']) ??
      stringValue(actionInput['issueNumber']) ??
      sourceGitHubPullRequestNumber(run);
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

function assertGitHubBrokeredCredential(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  actionInput: Record<string, WorkflowInputValue>,
  token: string | undefined,
  idempotencyKey: string | undefined,
): asserts token is string {
  if (token && token.startsWith('ghs_')) return;

  const reason = token
    ? 'github_credential_must_be_installation_token'
    : 'github_brokered_credential_missing';
  const metadata = {
    action: {
      adapter: node.adapter,
      action: node.action,
      proposalKey: node.proposalKey ?? null,
      idempotencyKey: idempotencyKey ?? null,
      requiresApproval: node.requiresApproval === true,
      policyReason: actionPolicyReason(node),
      status: 'blocked',
      digest: workflowActionProposalDigest(node, {
        idempotencyKey,
        input: actionInput,
      }),
      input: sanitizeActionInput(actionInput),
      credential: {
        reason,
        required: 'github_app_installation_token',
        acceptedPrefix: 'ghs_',
      },
      workflow_authority_denial: {
        reason,
        provider: 'github',
        requiredCredential: 'github_app_installation_token',
      },
    },
  };

  addEvent(
    run,
    'action-blocked',
    `Action node ${nodeId} blocked ${node.adapter}.${node.action}: ${reason}`,
    metadata,
    nodeId,
  );

  throw new WorkflowActionError(`GitHub action ${nodeId} blocked: ${reason}`, {
    output: `${node.adapter}.${node.action} blocked`,
    metadata,
  });
}

async function existingGitHubPullRequest(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  actionInput: Record<string, WorkflowInputValue>,
  request: {
    owner: string;
    repo: string;
    token: string;
    head: string | undefined;
    base: string;
  },
  idempotencyKey: string | undefined,
): Promise<ActionResult | null> {
  if (!request.head) return null;

  const params = new URLSearchParams({
    state: 'open',
    head: request.head.includes(':') ? request.head : `${request.owner}:${request.head}`,
    base: request.base,
    per_page: '1',
  });
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repo)}/pulls?${params.toString()}`,
    {
      method: 'GET',
      headers: githubHeaders(request.token),
    },
  );
  if (!response.ok) return null;

  const parsed = parseJson(await safeResponseText(response));
  const pullRequest = Array.isArray(parsed) ? parsed[0] : null;
  if (!pullRequest || typeof pullRequest !== 'object') return null;

  const providerReconciliation = await reconcileProviderAction(
    githubReconciliationRequest(githubHeaders(request.token), pullRequest, 'pull_request'),
    undefined,
    pullRequest,
  );
  const metadata = {
    action: {
      adapter: node.adapter,
      action: node.action,
      proposalKey: node.proposalKey ?? null,
      idempotencyKey: idempotencyKey ?? null,
      requiresApproval: node.requiresApproval === true,
      policyReason: actionPolicyReason(node),
      status: 'executed',
      idempotentReplay: true,
      idempotent_replay: true,
      digest: workflowActionProposalDigest(node, {
        idempotencyKey,
        input: actionInput,
      }),
      input: sanitizeActionInput(actionInput),
      request: {
        method: 'GET',
        url: `https://api.github.com/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repo)}/pulls`,
      },
      response: {
        status: 200,
        ok: true,
        bodyExcerpt: 'Existing open pull request matched by head/base.',
        htmlUrl: objectString(pullRequest, 'html_url'),
        apiUrl: objectString(pullRequest, 'url'),
        number: objectNumber(pullRequest, 'number'),
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
    'action-executed',
    `Action node ${nodeId} reused existing ${node.adapter}.${node.action}`,
    metadata,
    nodeId,
  );
  rememberExecutedAction(run, nodeId, node, idempotencyKey, actionInput, {
    output: `${node.adapter}.${node.action} 200`,
    response: metadata.action.response,
    ...(providerReconciliation ? { providerReconciliation } : {}),
  });

  return {
    output: `${node.adapter}.${node.action} 200`,
    metadata,
  };
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
  const channel = stringValue(actionInput['channel']) ?? sourceSlackChannel(run);
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
        thread_ts:
          stringValue(actionInput['thread_ts']) ??
          stringValue(actionInput['threadTs']) ??
          sourceSlackThreadTs(run),
      },
      okFromBody: true,
      reconcile: (parsed) =>
        slackMessageReconciliationRequest({ Authorization: `Bearer ${token}` }, parsed),
    });
  }

  return declaredProviderAction(node, 'declared', options.idempotencyKey, actionInput);
}

function splitRepository(repository: string | undefined): [string | undefined, string | undefined] {
  if (!repository) return [undefined, undefined];
  const [owner, repo, extra] = repository.split('/');
  if (!owner || !repo || extra) return [undefined, undefined];
  return [owner, repo];
}

function isGitHubPullRequestCreateAction(action: string): boolean {
  return [
    'create_pr',
    'create_pull_request',
    'pull_request.create',
    'pull-request.create',
    'pr.create',
    'open_pr',
  ].includes(action);
}

function isGitHubCommentAction(action: string): boolean {
  return ['comment', 'comment_issue', 'issue.comment', 'pull_request.comment'].includes(action);
}

function sourceGitHubPullRequestNumber(run: WorkflowRunRecord): string | undefined {
  return (
    scalarStringAt(run.inputs, ['integration_event', 'payload', 'pull_request', 'number']) ??
    scalarStringAt(run.inputs, ['integration_event', 'payload', 'issue', 'number']) ??
    scalarStringAt(run.inputs, ['integration_event', 'payload', 'number']) ??
    scalarStringAt(run.inputs, ['integration_event', 'pull_request', 'number']) ??
    scalarStringAt(run.inputs, ['integration_event', 'issue', 'number']) ??
    scalarStringAt(run.inputs, ['integration_event', 'number'])
  );
}

function sourceSlackChannel(run: WorkflowRunRecord): string | undefined {
  return (
    stringAt(run.inputs, ['integration_event', 'payload', 'event', 'channel']) ??
    stringAt(run.inputs, ['integration_event', 'event', 'channel']) ??
    stringAt(run.inputs, ['issue', 'payload', 'event', 'channel']) ??
    stringAt(run.inputs, ['issue', 'event', 'channel'])
  );
}

function sourceSlackThreadTs(run: WorkflowRunRecord): string | undefined {
  return (
    stringAt(run.inputs, ['integration_event', 'payload', 'event', 'thread_ts']) ??
    stringAt(run.inputs, ['integration_event', 'payload', 'event', 'threadTs']) ??
    stringAt(run.inputs, ['integration_event', 'payload', 'event', 'ts']) ??
    stringAt(run.inputs, ['integration_event', 'event', 'thread_ts']) ??
    stringAt(run.inputs, ['integration_event', 'event', 'threadTs']) ??
    stringAt(run.inputs, ['integration_event', 'event', 'ts']) ??
    stringAt(run.inputs, ['issue', 'payload', 'event', 'thread_ts']) ??
    stringAt(run.inputs, ['issue', 'payload', 'event', 'threadTs']) ??
    stringAt(run.inputs, ['issue', 'payload', 'event', 'ts']) ??
    stringAt(run.inputs, ['issue', 'event', 'thread_ts']) ??
    stringAt(run.inputs, ['issue', 'event', 'threadTs']) ??
    stringAt(run.inputs, ['issue', 'event', 'ts'])
  );
}

function stringAt(value: unknown, path: string[]): string | undefined {
  let cursor = value;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'string' && cursor.trim() !== '' ? cursor : undefined;
}

function scalarStringAt(value: unknown, path: string[]): string | undefined {
  let cursor = value;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor === 'string' && cursor.trim() !== '') return cursor;
  if (typeof cursor === 'number' && Number.isInteger(cursor) && cursor > 0) return String(cursor);
  return undefined;
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
