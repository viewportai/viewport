import { addEvent, renderTemplate } from './runtime-helpers.js';
import type { WorkflowActionNode, WorkflowInputValue, WorkflowRunRecord } from './types.js';

const MAX_RESPONSE_CHARS = 4_000;

interface ActionResult {
  output: string;
  metadata: Record<string, unknown>;
}

export async function executeActionAdapter(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  options: { approved?: boolean } = {},
): Promise<ActionResult> {
  if (node.requiresApproval === true && options.approved !== true) {
    return declaredAction(run, nodeId, node, 'awaiting_approval');
  }

  if (node.adapter === 'webhook' || node.adapter === 'http') {
    return executeWebhookAction(run, nodeId, node);
  }

  if (node.adapter === 'github') {
    return executeGitHubAction(run, nodeId, node);
  }

  return declaredAction(run, nodeId, node, 'declared');
}

async function executeWebhookAction(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
): Promise<ActionResult> {
  const actionInput = await renderActionInput(run, node.with ?? {});
  const url = stringValue(actionInput['url']);
  if (!url) return declaredAction(run, nodeId, node, 'missing_url');

  const method = stringValue(actionInput['method']) ?? actionMethod(node.action);
  const headers = headerRecord(actionInput['headers']);
  const body = actionInput['body'];
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const responseText = await safeResponseText(response);
  const metadata = {
    action: {
      adapter: node.adapter,
      action: node.action,
      idempotencyKey: node.idempotencyKey ?? null,
      requiresApproval: node.requiresApproval === true,
      status: response.ok ? 'executed' : 'failed',
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

  return {
    output: `${node.adapter}.${node.action} ${response.status}`,
    metadata,
  };
}

async function executeGitHubAction(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
): Promise<ActionResult> {
  const actionInput = await renderActionInput(run, node.with ?? {});
  const owner = stringValue(actionInput['owner']);
  const repo = stringValue(actionInput['repo']);
  const token = stringValue(actionInput['token']) ?? process.env['GITHUB_TOKEN'];
  if (!owner || !repo || !token) return declaredAction(run, nodeId, node, 'missing_url');

  if (node.action === 'create_pr' || node.action === 'create_pull_request') {
    return executeJsonApiAction(run, nodeId, node, {
      method: 'POST',
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      headers: githubHeaders(token),
      body: {
        title: stringValue(actionInput['title']) ?? 'Viewport workflow change',
        head: stringValue(actionInput['head']) ?? stringValue(actionInput['branch']),
        base: stringValue(actionInput['base']) ?? 'main',
        body: stringValue(actionInput['body']),
        draft: booleanValue(actionInput['draft']),
      },
    });
  }

  if (node.action === 'comment' || node.action === 'comment_issue') {
    const issueNumber =
      stringValue(actionInput['issue_number']) ?? stringValue(actionInput['issueNumber']);
    const body = stringValue(actionInput['body']);
    if (!issueNumber || !body) return declaredAction(run, nodeId, node, 'missing_url');
    return executeJsonApiAction(run, nodeId, node, {
      method: 'POST',
      url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(issueNumber)}/comments`,
      headers: githubHeaders(token),
      body: { body },
    });
  }

  return declaredAction(run, nodeId, node, 'declared');
}

async function renderActionInput(
  run: WorkflowRunRecord,
  value: Record<string, WorkflowInputValue>,
): Promise<Record<string, WorkflowInputValue>> {
  return (await renderActionValue(run, value)) as Record<string, WorkflowInputValue>;
}

async function executeJsonApiAction(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowActionNode,
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
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
  const metadata = {
    action: {
      adapter: node.adapter,
      action: node.action,
      idempotencyKey: node.idempotencyKey ?? null,
      requiresApproval: node.requiresApproval === true,
      status: response.ok ? 'executed' : 'failed',
      request: { method: request.method, url: request.url },
      response: {
        status: response.status,
        ok: response.ok,
        bodyExcerpt: responseText.slice(0, MAX_RESPONSE_CHARS),
        htmlUrl: objectString(parsed, 'html_url'),
        apiUrl: objectString(parsed, 'url'),
        number: objectNumber(parsed, 'number'),
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

  return {
    output: `${node.adapter}.${node.action} ${response.status}`,
    metadata,
  };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function booleanValue(value: WorkflowInputValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function objectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === 'string' ? entry : null;
}

function objectNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === 'number' ? entry : null;
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
): ActionResult {
  return {
    output: `${node.adapter}.${node.action}`,
    metadata: {
      action: {
        adapter: node.adapter,
        action: node.action,
        idempotencyKey: node.idempotencyKey ?? null,
        requiresApproval: node.requiresApproval === true,
        status,
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
