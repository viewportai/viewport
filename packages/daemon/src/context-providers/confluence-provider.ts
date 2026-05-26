import crypto from 'node:crypto';
import type {
  ContextProviderApplyApprovedUpdateInput,
  ContextProviderAdapter,
  ContextProviderResult,
  ContextProviderSearchInput,
} from './types.js';

export const confluenceProviderAdapter: ContextProviderAdapter = {
  kind: 'confluence',
  async search(input) {
    const page = await fetchConfluencePage(input);
    return [resultForPage(input.provider.id, page, input.query)];
  },
  async get(input) {
    const page = await fetchConfluencePage(input);
    const result = resultForPage(input.provider.id, page, input.query);
    return result.id === input.entryId ? result : undefined;
  },
  async applyApprovedUpdate(input) {
    return applyConfluenceUpdate(input);
  },
};

async function fetchConfluencePage(input: ContextProviderSearchInput): Promise<{
  pageId: string;
  title: string;
  body: string;
  url: string;
}> {
  const baseUrl = trimTrailingSlash(
    scopedEnv(input.provider.id, 'BASE_URL') ?? process.env.CONFLUENCE_BASE_URL,
  );
  const email = scopedEnv(input.provider.id, 'EMAIL') ?? process.env.CONFLUENCE_EMAIL;
  const token = scopedEnv(input.provider.id, 'API_TOKEN') ?? process.env.CONFLUENCE_API_TOKEN;
  if (!baseUrl || !email || !token) {
    throw new Error(
      `confluence provider ${input.provider.id} requires CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN or scoped VIEWPORT_CONTEXT_${envKey(input.provider.id)}_* env vars on the runner`,
    );
  }

  const pageId = confluencePageId(input.provider.ref ?? input.provider.id);
  const url = `${baseUrl}/wiki/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage,_links,version`;
  const response = await fetch(url, {
    headers: {
      authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(
      `confluence provider ${input.provider.id} failed to read page ${pageId}: HTTP ${response.status}`,
    );
  }

  const body = (await response.json()) as {
    id?: string;
    title?: string;
    body?: { storage?: { value?: string } };
    _links?: { webui?: string };
    version?: { number?: number };
  };
  const html = body.body?.storage?.value ?? '';
  return {
    pageId,
    title: body.title ?? `Confluence page ${pageId}`,
    body: stripHtml(html),
    url: body._links?.webui ? `${baseUrl}${body._links.webui}` : `${baseUrl}/wiki/pages/${pageId}`,
  };
}

function resultForPage(
  providerId: string,
  page: { pageId: string; title: string; body: string; url: string },
  query?: string,
): ContextProviderResult {
  const body = query ? snippet(page.body, query) : page.body;
  return {
    id: `${providerId}:${page.pageId}`,
    provider_id: providerId,
    provider: 'confluence',
    privacy: 'customer_hosted',
    title: page.title,
    body,
    digest: `sha256:${crypto.createHash('sha256').update(page.body).digest('hex')}`,
    source: page.url,
  };
}

function confluencePageId(ref: string): string {
  const trimmed = ref.trim();
  const match = /^confluence:\/\/(?:space\/[^/]+\/)?page\/(.+)$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function snippet(body: string, query: string): string {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return body;
  const index = body.toLowerCase().indexOf(normalized);
  if (index < 0) return body.slice(0, 8_000);
  return body.slice(Math.max(0, index - 2_000), index + 6_000).trim();
}

function scopedEnv(providerId: string, suffix: string): string | undefined {
  const key = `VIEWPORT_CONTEXT_${envKey(providerId)}_${suffix}`;
  const value = process.env[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function envKey(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  return value?.replace(/\/+$/, '');
}

async function applyConfluenceUpdate(input: ContextProviderApplyApprovedUpdateInput): Promise<{
  status: 'succeeded';
  provider_reference: string;
  provider_url: string;
  payload: Record<string, unknown>;
}> {
  const baseUrl = trimTrailingSlash(
    scopedEnv(input.provider.id, 'BASE_URL') ?? process.env.CONFLUENCE_BASE_URL,
  );
  const email = scopedEnv(input.provider.id, 'EMAIL') ?? process.env.CONFLUENCE_EMAIL;
  const token = scopedEnv(input.provider.id, 'API_TOKEN') ?? process.env.CONFLUENCE_API_TOKEN;
  if (!baseUrl || !email || !token) {
    throw new Error(
      `confluence provider ${input.provider.id} requires CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN or scoped VIEWPORT_CONTEXT_${envKey(input.provider.id)}_* env vars on the runner`,
    );
  }
  if (input.patch.mode !== 'append' || !input.patch.text?.trim()) {
    throw new Error(
      `confluence provider ${input.provider.id} supports approved append text updates in v1`,
    );
  }

  const pageId = confluencePageId(input.provider.ref ?? input.provider.id);
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const readUrl = `${baseUrl}/wiki/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage,_links,version`;
  const readResponse = await fetch(readUrl, {
    headers: {
      authorization: auth,
      accept: 'application/json',
    },
  });
  if (!readResponse.ok) {
    throw new Error(
      `confluence provider ${input.provider.id} failed to read page ${pageId}: HTTP ${readResponse.status}`,
    );
  }
  const current = (await readResponse.json()) as {
    id?: string;
    title?: string;
    body?: { storage?: { value?: string } };
    version?: { number?: number };
    _links?: { webui?: string };
  };
  const title = current.title ?? `Confluence page ${pageId}`;
  const version = typeof current.version?.number === 'number' ? current.version.number : 1;
  const before = current.body?.storage?.value ?? '';
  const appended = `${before}\n<p>${escapeHtml(input.patch.text)}</p>`;
  const updateResponse = await fetch(
    `${baseUrl}/wiki/rest/api/content/${encodeURIComponent(pageId)}`,
    {
      method: 'PUT',
      headers: {
        authorization: auth,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: pageId,
        type: 'page',
        title,
        version: { number: version + 1 },
        body: {
          storage: {
            value: appended,
            representation: 'storage',
          },
        },
      }),
    },
  );
  if (!updateResponse.ok) {
    throw new Error(
      `confluence provider ${input.provider.id} failed to apply approved update to page ${pageId}: HTTP ${updateResponse.status}`,
    );
  }

  const digest = `sha256:${crypto.createHash('sha256').update(input.patch.text).digest('hex')}`;
  return {
    status: 'succeeded',
    provider_reference: `confluence://page/${pageId}`,
    provider_url: current._links?.webui
      ? `${baseUrl}${current._links.webui}`
      : `${baseUrl}/wiki/pages/${pageId}`,
    payload: {
      operation: 'append_storage',
      external_id: pageId,
      external_version: version + 1,
      patch_digest: input.patch.patchDigest,
      before_digest: input.patch.beforeDigest,
      after_digest: digest,
      content_digest: digest,
      applied_by: input.actorName,
      applied_at: new Date().toISOString(),
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
