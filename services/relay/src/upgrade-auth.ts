import { z } from 'zod';

const TokenSchema = z.string().min(10).max(4096);

export type RelayMode = 'dev' | 'staging' | 'prod';
export type UpgradeTokenSource = 'header' | 'protocol' | 'query';

export type UpgradeAuthResult =
  | {
      ok: true;
      token: string;
      source: UpgradeTokenSource;
    }
  | {
      ok: false;
      reason: 'MISSING_AUTH_TOKEN' | 'QUERY_TOKEN_NOT_ALLOWED';
    };

function parseBearer(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() || '';
  if (!token) return null;
  return TokenSchema.safeParse(token).success ? token : null;
}

function parseProtocolToken(protocolHeader: string | undefined): string | null {
  if (!protocolHeader) return null;
  const candidates = protocolHeader
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const candidate of candidates) {
    if (!candidate.startsWith('auth.')) continue;
    const token = candidate.slice('auth.'.length);
    if (!TokenSchema.safeParse(token).success) continue;
    return token;
  }
  return null;
}

export function resolveUpgradeAuth(input: {
  relayMode: RelayMode;
  authorizationHeader: string | undefined;
  protocolHeader: string | undefined;
  queryToken: string | undefined;
}): UpgradeAuthResult {
  const fromHeader = parseBearer(input.authorizationHeader);
  if (fromHeader) {
    return { ok: true, token: fromHeader, source: 'header' };
  }

  const fromProtocol = parseProtocolToken(input.protocolHeader);
  if (fromProtocol) {
    return { ok: true, token: fromProtocol, source: 'protocol' };
  }

  const fromQuery = (input.queryToken ?? '').trim();
  if (!fromQuery) {
    return { ok: false, reason: 'MISSING_AUTH_TOKEN' };
  }
  if (input.relayMode !== 'dev') {
    return { ok: false, reason: 'QUERY_TOKEN_NOT_ALLOWED' };
  }
  if (!TokenSchema.safeParse(fromQuery).success) {
    return { ok: false, reason: 'MISSING_AUTH_TOKEN' };
  }
  return { ok: true, token: fromQuery, source: 'query' };
}
