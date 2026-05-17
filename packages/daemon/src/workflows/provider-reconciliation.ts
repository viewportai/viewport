import { createHash } from 'node:crypto';

const MAX_RESPONSE_CHARS = 4_000;
const PROVIDER_RECONCILIATION_CHECKER = 'vpd.provider_adapter';

type ProviderReconciliationStatus =
  | 'not_checked'
  | 'verified'
  | 'mismatch'
  | 'unavailable'
  | 'failed';

export interface ProviderReconciliation {
  status: ProviderReconciliationStatus;
  method?: string;
  checkedAt?: string;
  checkedBy?: string;
  providerReference?: string;
  providerUrl?: string;
  targetDigest?: string;
  payloadDigest?: string;
  error?: string;
  payload?: unknown;
}

export interface ProviderReconciliationRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  expected: (parsed: unknown) => Record<string, unknown> | null;
  actual: (parsed: unknown) => Record<string, unknown> | null;
  providerReference?: (parsed: unknown) => string | undefined;
  providerUrl?: (parsed: unknown) => string | undefined;
}

export async function reconcileProviderAction(
  request: ProviderReconciliationRequest | null,
  unsupportedReason: string | undefined,
  initialProviderPayload: unknown,
): Promise<ProviderReconciliation | null> {
  const checkedAt = new Date().toISOString();

  if (!request) {
    if (!unsupportedReason) return null;
    return {
      status: 'not_checked',
      method: 'not_supported',
      checkedAt,
      checkedBy: PROVIDER_RECONCILIATION_CHECKER,
      payload: { reason: unsupportedReason },
    };
  }

  const expected = request.expected(initialProviderPayload);
  const providerReference = request.providerReference?.(initialProviderPayload);
  const providerUrl = request.providerUrl?.(initialProviderPayload) ?? request.url;

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: {
        Accept: 'application/vnd.github+json, application/json;q=0.9, */*;q=0.8',
        ...request.headers,
      },
    });
    const responseText = await safeResponseText(response);
    const parsed = parseJson(responseText);
    if (!response.ok) {
      return {
        status: 'unavailable',
        method: 'read_after_write',
        checkedAt,
        checkedBy: PROVIDER_RECONCILIATION_CHECKER,
        providerReference,
        providerUrl,
        error: `HTTP ${response.status}: ${responseText.slice(0, MAX_RESPONSE_CHARS)}`,
      };
    }

    const actual = request.actual(parsed);
    const actualProviderUrl = request.providerUrl?.(parsed) ?? providerUrl;
    if (!expected || !actual) {
      return {
        status: 'unavailable',
        method: 'read_after_write',
        checkedAt,
        checkedBy: PROVIDER_RECONCILIATION_CHECKER,
        providerReference,
        providerUrl: actualProviderUrl,
        payloadDigest: digestJson(parsed),
        error: 'Provider read-back response did not include a comparable identity.',
      };
    }

    const matched = canonicalJson(expected) === canonicalJson(actual);
    return {
      status: matched ? 'verified' : 'mismatch',
      method: 'read_after_write',
      checkedAt,
      checkedBy: PROVIDER_RECONCILIATION_CHECKER,
      providerReference,
      providerUrl: actualProviderUrl,
      targetDigest: digestJson(expected),
      payloadDigest: digestJson(parsed),
      payload: matched ? actual : { expected, actual },
    };
  } catch (error) {
    return {
      status: 'failed',
      method: 'read_after_write',
      checkedAt,
      checkedBy: PROVIDER_RECONCILIATION_CHECKER,
      providerReference,
      providerUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function githubReconciliationRequest(
  headers: Record<string, string>,
  parsed: unknown,
  kind: 'pull_request' | 'issue_comment',
): ProviderReconciliationRequest | null {
  const apiUrl = objectString(parsed, 'url');
  if (!apiUrl) return null;
  return {
    method: 'GET',
    url: apiUrl,
    headers,
    expected: (value) => githubIdentity(value, kind),
    actual: (value) => githubIdentity(value, kind),
    providerReference: (value) =>
      objectString(value, 'html_url') ?? objectString(value, 'url') ?? undefined,
    providerUrl: (value) =>
      objectString(value, 'html_url') ?? objectString(value, 'url') ?? undefined,
  };
}

export function jiraCommentReconciliationRequest(
  baseUrl: string,
  headers: Record<string, string>,
  parsed: unknown,
): ProviderReconciliationRequest | null {
  const id = objectString(parsed, 'id');
  if (!id) return null;
  const selfUrl = objectString(parsed, 'self');
  const url = selfUrl ?? `${baseUrl}/rest/api/3/comment/${encodeURIComponent(id)}`;
  return {
    method: 'GET',
    url,
    headers,
    expected: jiraCommentIdentity,
    actual: jiraCommentIdentity,
    providerReference: (value) => objectString(value, 'id') ?? undefined,
    providerUrl: () => url,
  };
}

export function slackMessageReconciliationRequest(
  headers: Record<string, string>,
  parsed: unknown,
): ProviderReconciliationRequest | null {
  const channel = objectString(parsed, 'channel');
  const ts = objectString(parsed, 'ts');
  if (!channel || !ts) return null;
  const params = new URLSearchParams({ channel, message_ts: ts });
  return {
    method: 'GET',
    url: `https://slack.com/api/chat.getPermalink?${params.toString()}`,
    headers,
    expected: slackMessageIdentity,
    actual: slackPermalinkIdentity(channel, ts),
    providerReference: () => `${channel}:${ts}`,
    providerUrl: (value) => objectString(value, 'permalink') ?? undefined,
  };
}

function githubIdentity(
  value: unknown,
  kind: 'pull_request' | 'issue_comment',
): Record<string, unknown> | null {
  const apiUrl = objectString(value, 'url');
  const htmlUrl = objectString(value, 'html_url');
  if (!apiUrl && !htmlUrl) return null;
  return compactObject({
    provider: 'github',
    kind,
    apiUrl,
    htmlUrl,
    number: objectNumber(value, 'number'),
    id: objectNumber(value, 'id'),
  });
}

function jiraCommentIdentity(value: unknown): Record<string, unknown> | null {
  const id = objectString(value, 'id');
  if (!id) return null;
  return compactObject({
    provider: 'jira',
    kind: 'issue_comment',
    id,
    self: objectString(value, 'self'),
  });
}

function slackMessageIdentity(value: unknown): Record<string, unknown> | null {
  const channel = objectString(value, 'channel');
  const ts = objectString(value, 'ts');
  if (!channel || !ts) return null;
  return { provider: 'slack', kind: 'message', channel, ts };
}

function slackPermalinkIdentity(
  channel: string,
  ts: string,
): (value: unknown) => Record<string, unknown> | null {
  return (value) => {
    if (objectBoolean(value, 'ok') === false) return null;
    return { provider: 'slack', kind: 'message', channel, ts };
  };
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

function objectBoolean(value: unknown, key: string): boolean | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === 'boolean' ? entry : null;
}

function digestJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortJson(entryValue)]),
  );
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
