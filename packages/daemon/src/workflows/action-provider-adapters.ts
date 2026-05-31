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
  envNameForCredentialRef,
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

interface ProviderActionOptions {
  idempotencyKey?: string;
  runtimeSecretEnv?: Record<string, string>;
  runtimeSecretFiles?: Record<string, string>;
}

export async function executeProviderAction(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  actionInput: Record<string, WorkflowInputValue>,
  options: ProviderActionOptions = {},
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
  options: ProviderActionOptions,
): Promise<ActionResult> {
  const repository = stringValue(actionInput['repository']);
  const [repositoryOwner, repositoryName] = splitRepository(repository);
  const owner = stringValue(actionInput['owner']) ?? repositoryOwner;
  const repo = stringValue(actionInput['repo']) ?? repositoryName;
  const token = providerCredentialValue(actionInput, {
    defaultRef: 'github/token',
    defaultEnv: 'GITHUB_TOKEN',
    runtimeSecretEnv: options.runtimeSecretEnv,
    runtimeSecretFiles: {
      ...runtimeSecretFilesForRun(run),
      ...(options.runtimeSecretFiles ?? {}),
    },
    runId: run.platformRunId ?? run.id,
  });
  if (!owner || !repo) {
    return declaredProviderAction(node, 'missing_url', options.idempotencyKey, actionInput);
  }
  assertGitHubBrokeredCredential(
    run,
    nodeId,
    node,
    actionInput,
    token,
    options.idempotencyKey,
    Object.keys(options.runtimeSecretEnv ?? {}).sort(),
  );

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
      retry: githubPullRequestCreateRetryPolicy(),
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
  runtimeSecretEnvKeys: string[],
): asserts token is string {
  if (token && token.startsWith('ghs_')) return;

  const reason = token
    ? 'github_credential_must_be_installation_token'
    : 'github_brokered_credential_missing';
  const credentialRef =
    typeof actionInput['credential_ref'] === 'string'
      ? actionInput['credential_ref']
      : typeof actionInput['credentialRef'] === 'string'
        ? actionInput['credentialRef']
        : null;
  const expectedEnvName = credentialRef ? envNameForCredentialRef(credentialRef) : null;
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
        credentialRef,
        expectedEnvName,
        runtimeSecretEnvKeys,
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
  options: ProviderActionOptions,
): Promise<ActionResult> {
  const baseUrl = normalizedBaseUrl(
    stringValue(actionInput['base_url']) ??
      stringValue(actionInput['baseUrl']) ??
      process.env['JIRA_BASE_URL'],
  );
  const token = providerCredentialValue(actionInput, {
    defaultRef: 'jira/token',
    defaultEnv: 'JIRA_API_TOKEN',
    runtimeSecretEnv: options.runtimeSecretEnv,
    runtimeSecretFiles: {
      ...runtimeSecretFilesForRun(run),
      ...(options.runtimeSecretFiles ?? {}),
    },
    runId: run.platformRunId ?? run.id,
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
  options: ProviderActionOptions,
): Promise<ActionResult> {
  const token = providerCredentialValue(actionInput, {
    defaultRef: 'slack/bot-token',
    defaultEnv: 'SLACK_BOT_TOKEN',
    runtimeSecretEnv: options.runtimeSecretEnv,
    runtimeSecretFiles: {
      ...runtimeSecretFilesForRun(run),
      ...(options.runtimeSecretFiles ?? {}),
    },
    runId: run.platformRunId ?? run.id,
  });
  const channel = stringValue(actionInput['channel']) ?? sourceSlackChannel(run);
  const rawText = stringValue(actionInput['text']) ?? stringValue(actionInput['body']);
  const text = rawText ? renderRuntimeMessage(run, rawText) : undefined;
  if (!token || !channel || !text) {
    return declaredProviderAction(node, 'missing_url', options.idempotencyKey, actionInput);
  }

  if (
    node.action === 'post_message' ||
    node.action === 'message' ||
    node.action === 'chat.postMessage'
  ) {
    const renderedActionInput = {
      ...actionInput,
      text,
    };

    return executeJsonApiAction(run, nodeId, node, {
      method: 'POST',
      url: 'https://slack.com/api/chat.postMessage',
      headers: withIdempotencyHeader({ Authorization: `Bearer ${token}` }, options.idempotencyKey),
      proposalInput: renderedActionInput,
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

function renderRuntimeMessage(run: WorkflowRunRecord, template: string): string {
  const runUrl = runtimeRunUrl(run);
  const githubAction = latestGithubAction(run);
  const githubUrl =
    nestedString(githubAction, ['providerReconciliation', 'providerUrl']) ??
    nestedString(githubAction, ['provider_reconciliation', 'providerUrl']) ??
    nestedString(githubAction, ['provider_reconciliation', 'provider_url']) ??
    nestedString(githubAction, ['response', 'htmlUrl']) ??
    nestedString(githubAction, ['response', 'html_url']) ??
    runUrl;
  const variables: Record<string, string> = {
    'run.id': run.platformRunId ?? run.id,
    'run.url': runUrl,
    'audit.url': `${runUrl}#audit`,
    'audit_packet.url': `${runUrl}#audit`,
    'github.url': githubUrl,
    'github_pr.url': githubUrl,
    'github_pr.label': githubReceiptLabel(githubAction),
  };

  const doubleRendered = template.replace(
    /{{\s*([A-Za-z0-9_.-]+)\s*}}/g,
    (match, key: string) => variables[key] ?? match,
  );

  const rendered = doubleRendered.replace(
    /(?<!{){\s*([A-Za-z0-9_.-]+)\s*}(?!})/g,
    (match, key: string) => variables[key] ?? match,
  );

  return normalizeSlackMessageText(rendered);
}

function normalizeSlackMessageText(text: string): string {
  return text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function runtimeRunUrl(run: WorkflowRunRecord): string {
  const runId = encodeURIComponent(run.platformRunId ?? run.id);
  const appUrl = runtimeAppUrl(run);
  const path =
    run.platformRunId && run.resourceId
      ? `/workflows/runs/${runId}?resource=${encodeURIComponent(run.resourceId)}&platformRun=${runId}`
      : `/workflows/runs/${runId}`;

  return `${appUrl}${path}`;
}

function runtimeAppUrl(run: WorkflowRunRecord): string {
  const configured =
    nestedString(run.inputs, ['viewport', 'appUrl']) ??
    nestedString(run.inputs, ['viewport', 'app_url']) ??
    process.env['VIEWPORT_APP_URL'] ??
    process.env['VPD_APP_URL'];
  if (configured) return configured.replace(/\/+$/, '');

  const serverUrl =
    nestedString(run.inputs, ['viewport', 'serverUrl']) ??
    nestedString(run.inputs, ['viewport', 'server_url']) ??
    process.env['VIEWPORT_SERVER_URL'] ??
    process.env['VPD_SERVER_URL'];
  const inferred = inferAppUrlFromServer(serverUrl);
  return inferred.replace(/\/+$/, '');
}

function inferAppUrlFromServer(serverUrl: string | undefined): string {
  if (!serverUrl) return 'https://app.getviewport.com';
  try {
    const url = new URL(serverUrl);
    if (url.hostname.startsWith('api.')) {
      url.hostname = `app.${url.hostname.slice('api.'.length)}`;
      url.pathname = '';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/+$/, '');
    }
    if (url.hostname === 'getviewport.com') {
      url.hostname = 'app.getviewport.com';
      url.pathname = '';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/+$/, '');
    }
    if (url.hostname === 'getviewport.test') {
      url.hostname = 'app.getviewport.test';
      url.pathname = '';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/+$/, '');
    }
  } catch {
    return 'https://app.getviewport.com';
  }

  return 'https://app.getviewport.com';
}

function latestGithubAction(run: WorkflowRunRecord): Record<string, unknown> | null {
  const actions = Object.values(run.nodes)
    .map((node) => recordValue(recordValue(node.metadata)?.['action']))
    .filter((action): action is Record<string, unknown> => {
      if (!action) return false;
      const adapter = runtimeString(action['adapter']);
      const status = runtimeString(action['status']);
      return (
        adapter === 'github' &&
        ['executed', 'completed', 'success', 'succeeded'].includes(status ?? '')
      );
    });
  return actions.at(-1) ?? null;
}

function githubReceiptLabel(action: Record<string, unknown> | null): string {
  const reference =
    nestedString(action, ['response', 'number']) ??
    nestedString(action, ['providerReconciliation', 'providerReference']) ??
    nestedString(action, ['provider_reconciliation', 'providerReference']) ??
    nestedString(action, ['provider_reconciliation', 'provider_reference']);
  if (reference) return /^pr\s*#/i.test(reference) ? reference : `PR #${reference}`;

  const url =
    nestedString(action, ['response', 'htmlUrl']) ??
    nestedString(action, ['response', 'html_url']) ??
    nestedString(action, ['providerReconciliation', 'providerUrl']) ??
    nestedString(action, ['provider_reconciliation', 'providerUrl']) ??
    nestedString(action, ['provider_reconciliation', 'provider_url']);
  const match = url?.match(/\/pull\/([0-9]+)/);
  return match ? `PR #${match[1]}` : 'GitHub PR';
}

function nestedString(value: Record<string, unknown> | null, path: string[]): string | undefined {
  let current: unknown = value;
  for (const segment of path) {
    const record = recordValue(current);
    if (!record) return undefined;
    current = record[segment];
  }
  if (typeof current === 'number') return String(current);
  return runtimeString(current);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function runtimeSecretFilesForRun(run: WorkflowRunRecord): Record<string, string> {
  const viewport = run.inputs?.['viewport'];
  if (!viewport || typeof viewport !== 'object' || Array.isArray(viewport)) return {};
  const files = (viewport as Record<string, unknown>)['credentialSecretFiles'];
  if (!Array.isArray(files)) return {};
  const mapped: Record<string, string> = {};
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) continue;
    const envName = (file as Record<string, unknown>)['envName'];
    const path = (file as Record<string, unknown>)['path'];
    if (typeof envName === 'string' && typeof path === 'string') {
      mapped[envName] = path;
    }
  }
  return mapped;
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
    retry?: {
      statuses: number[];
      attempts: number;
      delayMs: number;
    };
  },
): Promise<ActionResult> {
  const requestInit = {
    method: request.method,
    headers: {
      Accept: 'application/vnd.github+json, application/json;q=0.9, */*;q=0.8',
      'Content-Type': 'application/json',
      ...request.headers,
    },
    body: JSON.stringify(compactObject(request.body)),
  };
  let response = await fetch(request.url, requestInit);
  let attempts = 1;
  const retry = request.retry;
  while (
    retry &&
    attempts < retry.attempts &&
    retry.statuses.includes(response.status)
  ) {
    await sleep(retry.delayMs);
    attempts += 1;
    response = await fetch(request.url, requestInit);
  }
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
        attempts,
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

function githubPullRequestCreateRetryPolicy(): { statuses: number[]; attempts: number; delayMs: number } {
  const delayMs = Number.parseInt(process.env['VIEWPORT_GITHUB_PR_RETRY_DELAY_MS'] ?? '', 10);

  return {
    // GitHub can briefly return "not found" for a just-pushed branch when the
    // PR action follows the publish action immediately, especially in
    // multi-repo runs where branches are created in quick succession.
    statuses: [404, 422],
    attempts: 3,
    delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 750,
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
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
