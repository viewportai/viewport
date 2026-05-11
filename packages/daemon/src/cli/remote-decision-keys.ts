import { transportFetch } from './network.js';

export async function fetchContextCandidateDecisionKeys(options: {
  serverUrl: string;
  tlsVerify?: 'auto' | '0' | '1';
  caCertPath?: string;
  tlsPins?: string[];
}): Promise<Record<string, string> | undefined> {
  const url = `${options.serverUrl.replace(/\/+$/, '')}/api/.well-known/context-candidate-decision-keys.json`;
  const res = await transportFetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    tlsVerify: options.tlsVerify ?? 'auto',
    caCertPath: options.caCertPath,
    tlsPins: options.tlsPins,
    timeoutMs: 3_000,
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch context candidate decision keys: HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (!body || typeof body !== 'object') {
    throw new Error('Context candidate decision key response must be an object');
  }
  const keys = (body as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) {
    throw new Error('Context candidate decision key response must include keys');
  }

  const parsed: Record<string, string> = {};
  for (const key of keys) {
    if (!key || typeof key !== 'object') continue;
    const item = key as { kid?: unknown; algorithm?: unknown; public_key?: unknown };
    if (
      typeof item.kid === 'string' &&
      item.kid.length > 0 &&
      item.algorithm === 'Ed25519' &&
      typeof item.public_key === 'string' &&
      item.public_key.length > 0
    ) {
      parsed[item.kid] = item.public_key;
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function parseDecisionSigningKeys(
  raw: string | undefined,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Context candidate decision key JSON must be an object');
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([kid, key]) =>
        typeof key === 'string' && key.length > 0 ? [[kid, key]] : [],
      ),
    );
  }

  const separator = trimmed.indexOf(':');
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error('Context candidate decision key must use kid:base64-public-key format');
  }

  return {
    [trimmed.slice(0, separator)]: trimmed.slice(separator + 1),
  };
}
