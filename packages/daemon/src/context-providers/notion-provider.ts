import crypto from 'node:crypto';
import type {
  ContextProviderApplyApprovedUpdateInput,
  ContextProviderAdapter,
  ContextProviderResult,
  ContextProviderSearchInput,
} from './types.js';

const NOTION_VERSION = '2022-06-28';

export const notionProviderAdapter: ContextProviderAdapter = {
  kind: 'notion',
  async search(input) {
    const page = await fetchNotionPage(input);
    return [resultForPage(input.provider.id, page, input.query)];
  },
  async get(input) {
    const page = await fetchNotionPage(input);
    const result = resultForPage(input.provider.id, page, input.query);
    return result.id === input.entryId ? result : undefined;
  },
  async applyApprovedUpdate(input) {
    return applyNotionUpdate(input);
  },
};

async function fetchNotionPage(input: ContextProviderSearchInput): Promise<{
  pageId: string;
  title: string;
  body: string;
  url: string;
}> {
  const token = scopedEnv(input.provider.id, 'TOKEN') ?? process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error(`notion provider ${input.provider.id} requires NOTION_TOKEN or VIEWPORT_CONTEXT_${envKey(input.provider.id)}_TOKEN on the runner`);
  }

  const pageId = notionPageId(input.provider.ref ?? input.provider.notebook ?? input.provider.id);
  const response = await fetch(`https://api.notion.com/v1/blocks/${encodeURIComponent(pageId)}/children?page_size=100`, {
    headers: {
      authorization: `Bearer ${token}`,
      'notion-version': NOTION_VERSION,
    },
  });
  if (!response.ok) {
    throw new Error(`notion provider ${input.provider.id} failed to read page ${pageId}: HTTP ${response.status}`);
  }

  const body = await response.json() as { results?: unknown[] };
  const text = (body.results ?? []).flatMap(blockText).join('\n').trim();
  return {
    pageId,
    title: `Notion page ${pageId}`,
    body: text,
    url: `https://notion.so/${pageId.replaceAll('-', '')}`,
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
    provider: 'notion',
    privacy: 'customer_hosted',
    title: page.title,
    body,
    digest: `sha256:${crypto.createHash('sha256').update(page.body).digest('hex')}`,
    source: page.url,
  };
}

function blockText(block: unknown): string[] {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return [];
  const row = block as Record<string, unknown>;
  const type = typeof row['type'] === 'string' ? row['type'] : null;
  if (!type) return [];
  const typed = row[type];
  if (!typed || typeof typed !== 'object' || Array.isArray(typed)) return [];
  const richText = (typed as Record<string, unknown>)['rich_text'];
  if (!Array.isArray(richText)) return [];
  const line = richText
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
      const text = (part as Record<string, unknown>)['plain_text'];
      return typeof text === 'string' ? text : '';
    })
    .join('')
    .trim();
  return line ? [line] : [];
}

function notionPageId(ref: string): string {
  const trimmed = ref.trim();
  const match = /^notion:\/\/page\/(.+)$/.exec(trimmed);
  return (match?.[1] ?? trimmed).replaceAll('-', '');
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
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

async function applyNotionUpdate(
  input: ContextProviderApplyApprovedUpdateInput,
): Promise<{
  status: 'succeeded';
  provider_reference: string;
  provider_url: string;
  payload: Record<string, unknown>;
}> {
  const token = scopedEnv(input.provider.id, 'TOKEN') ?? process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error(`notion provider ${input.provider.id} requires NOTION_TOKEN or VIEWPORT_CONTEXT_${envKey(input.provider.id)}_TOKEN on the runner`);
  }
  if (input.patch.mode !== 'append' || !input.patch.text?.trim()) {
    throw new Error(`notion provider ${input.provider.id} supports approved append text updates in v1`);
  }

  const pageId = notionPageId(input.provider.ref ?? input.provider.notebook ?? input.provider.id);
  const response = await fetch(`https://api.notion.com/v1/blocks/${encodeURIComponent(pageId)}/children`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'notion-version': NOTION_VERSION,
    },
    body: JSON.stringify({
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [
              {
                type: 'text',
                text: { content: input.patch.text },
              },
            ],
          },
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`notion provider ${input.provider.id} failed to apply approved update to page ${pageId}: HTTP ${response.status}`);
  }

  const digest = `sha256:${crypto.createHash('sha256').update(input.patch.text).digest('hex')}`;
  return {
    status: 'succeeded',
    provider_reference: `notion://page/${pageId}`,
    provider_url: `https://notion.so/${pageId.replaceAll('-', '')}`,
    payload: {
      operation: 'append_block',
      external_id: pageId,
      patch_digest: input.patch.patchDigest,
      before_digest: input.patch.beforeDigest,
      after_digest: digest,
      content_digest: digest,
      applied_by: input.actorName,
      applied_at: new Date().toISOString(),
    },
  };
}
