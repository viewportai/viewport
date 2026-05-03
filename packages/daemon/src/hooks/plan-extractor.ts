export interface ExtractedPlanProposal {
  title?: string;
  summary?: string;
  body: string;
  source?: string;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
}

const FENCE_PATTERN = /```viewport-plan\s*\n([\s\S]*?)```/i;
const COMMENT_PATTERN = /<!--\s*viewport-plan\s*\n([\s\S]*?)-->/i;

/**
 * Extracts an explicit Viewport plan proposal from provider hook text.
 *
 * Claude/Codex do not emit a native "plan proposed" event, so this function
 * only accepts deliberate markers. This keeps ingestion predictable and avoids
 * silently converting arbitrary assistant prose into durable Plan records.
 */
export function extractPlanProposalFromText(
  text: string | undefined,
): ExtractedPlanProposal | null {
  if (!text) return null;

  const content = FENCE_PATTERN.exec(text)?.[1] ?? COMMENT_PATTERN.exec(text)?.[1];
  if (!content?.trim()) return null;

  const trimmed = content.trim();
  const json = parseJsonPlan(trimmed);
  if (json) return json;

  return parseFrontmatterPlan(trimmed);
}

function parseJsonPlan(text: string): ExtractedPlanProposal | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const body =
      readString(record.body) ?? readString(record.plan) ?? readString(record.plan_markdown);
    if (!body) return null;
    return {
      title: readString(record.title),
      summary: readString(record.summary),
      body,
      source: readString(record.source),
      sourceRef: readString(record.source_ref) ?? readString(record.sourceRef),
      metadata: readRecord(record.metadata),
    };
  } catch {
    return null;
  }
}

function parseFrontmatterPlan(text: string): ExtractedPlanProposal | null {
  const separator = text.indexOf('\n---\n');
  if (separator === -1) {
    return { body: text };
  }

  const header = text.slice(0, separator).trim();
  const body = text.slice(separator + '\n---\n'.length).trim();
  if (!body) return null;

  const fields = new Map<string, string>();
  for (const line of header.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    fields.set(match[1].toLowerCase(), stripQuotes(match[2].trim()));
  }

  return {
    title: fields.get('title'),
    summary: fields.get('summary'),
    body,
    source: fields.get('source'),
    sourceRef: fields.get('source_ref') ?? fields.get('sourceref'),
    metadata: {
      extractedFrom: 'explicit-marker',
      marker: 'viewport-plan',
    },
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
