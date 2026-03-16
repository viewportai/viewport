import crypto from 'node:crypto';
import { BridgeError } from './bridge-errors.js';

export interface RelayTokenClaims {
  e2eeProfile?: string;
  pairingSecret?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  jti?: string;
}

export interface RelayTokenVerificationOptions {
  issuer?: string;
  audience?: string;
  signingKeys: Record<string, string>;
  clockSkewSec?: number;
}

interface JwtHeader {
  alg?: string;
  typ?: string;
  kid?: string;
}

function parseBase64UrlJson<T>(segment: string, label: string): T {
  let decoded = '';
  try {
    decoded = Buffer.from(segment, 'base64url').toString('utf8');
  } catch (error) {
    throw new BridgeError(
      'TOKEN_RESPONSE_INVALID',
      `relay token ${label} decode failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return JSON.parse(decoded) as T;
  } catch (error) {
    throw new BridgeError(
      'TOKEN_RESPONSE_INVALID',
      `relay token ${label} JSON invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function secureCompare(aRaw: string, bRaw: string): boolean {
  const a = Buffer.from(aRaw, 'utf8');
  const b = Buffer.from(bRaw, 'utf8');
  const compareLength = Math.max(a.length, b.length, 1);
  const paddedA = Buffer.alloc(compareLength);
  const paddedB = Buffer.alloc(compareLength);
  a.copy(paddedA);
  b.copy(paddedB);
  const equal = crypto.timingSafeEqual(paddedA, paddedB);
  return equal && a.length === b.length;
}

function ensureNumericClaim(
  payload: Record<string, unknown>,
  name: 'exp' | 'iat' | 'nbf',
): number | undefined {
  const raw = payload[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new BridgeError('TOKEN_RESPONSE_INVALID', `relay token ${name} claim must be numeric`);
  }
  return raw;
}

function ensureAudience(
  payload: Record<string, unknown>,
  expectedAudience: string | undefined,
): void {
  if (!expectedAudience) return;
  const aud = payload['aud'];
  if (typeof aud === 'string') {
    if (aud !== expectedAudience) {
      throw new BridgeError(
        'TOKEN_RESPONSE_INVALID',
        `relay token audience mismatch (expected ${expectedAudience})`,
      );
    }
    return;
  }
  if (Array.isArray(aud) && aud.every((entry) => typeof entry === 'string')) {
    if (!(aud as string[]).includes(expectedAudience)) {
      throw new BridgeError(
        'TOKEN_RESPONSE_INVALID',
        `relay token audience mismatch (expected ${expectedAudience})`,
      );
    }
    return;
  }
  throw new BridgeError('TOKEN_RESPONSE_INVALID', 'relay token aud claim is missing/invalid');
}

export function verifyRelayTokenClaims(
  relayToken: string,
  options: RelayTokenVerificationOptions,
): RelayTokenClaims {
  const parts = relayToken.split('.');
  if (parts.length !== 3) {
    throw new BridgeError('TOKEN_RESPONSE_INVALID', 'relay token is malformed');
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new BridgeError('TOKEN_RESPONSE_INVALID', 'relay token is malformed');
  }

  const header = parseBase64UrlJson<JwtHeader>(headerPart, 'header');
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new BridgeError('TOKEN_RESPONSE_INVALID', 'relay token header is invalid');
  }
  if (header.alg !== 'HS256' && header.alg !== 'RS256') {
    throw new BridgeError(
      'TOKEN_RESPONSE_INVALID',
      `unsupported relay token alg: ${String(header.alg)}`,
    );
  }

  const kid = typeof header.kid === 'string' && header.kid.trim().length > 0 ? header.kid : 'v1';
  const signingKey = options.signingKeys[kid];
  if (!signingKey || signingKey.trim().length === 0) {
    throw new BridgeError('TOKEN_RESPONSE_INVALID', `relay token key id ${kid} is not trusted`);
  }

  if (header.alg === 'HS256') {
    const expectedSignature = Buffer.from(
      crypto.createHmac('sha256', signingKey).update(`${headerPart}.${payloadPart}`).digest(),
    ).toString('base64url');
    if (!secureCompare(expectedSignature, signaturePart)) {
      throw new BridgeError('TOKEN_RESPONSE_INVALID', 'relay token signature invalid');
    }
  } else {
    let signatureRaw: Buffer;
    try {
      signatureRaw = Buffer.from(signaturePart, 'base64url');
    } catch (error) {
      throw new BridgeError(
        'TOKEN_RESPONSE_INVALID',
        `relay token signature decode failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const valid = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`, 'utf8'),
      signingKey,
      signatureRaw,
    );
    if (!valid) {
      throw new BridgeError('TOKEN_RESPONSE_INVALID', 'relay token signature invalid');
    }
  }

  const payload = parseBase64UrlJson<Record<string, unknown>>(payloadPart, 'payload');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new BridgeError('TOKEN_RESPONSE_INVALID', 'relay token payload is not an object');
  }

  if (options.issuer) {
    const iss = payload['iss'];
    if (typeof iss !== 'string' || iss !== options.issuer) {
      throw new BridgeError(
        'TOKEN_RESPONSE_INVALID',
        `relay token issuer mismatch (expected ${options.issuer})`,
      );
    }
  }

  ensureAudience(payload, options.audience);

  const nowSec = Math.floor(Date.now() / 1000);
  const skew = Math.max(0, Math.floor(options.clockSkewSec ?? 30));
  const exp = ensureNumericClaim(payload, 'exp');
  const iat = ensureNumericClaim(payload, 'iat');
  const nbf = ensureNumericClaim(payload, 'nbf');

  if (exp === undefined) {
    throw new BridgeError('TOKEN_RESPONSE_INVALID', 'relay token exp claim is required');
  }
  if (exp <= nowSec - skew) {
    throw new BridgeError('TOKEN_RESPONSE_INVALID', 'relay token is expired');
  }
  if (iat !== undefined && iat > nowSec + skew) {
    throw new BridgeError('TOKEN_RESPONSE_INVALID', 'relay token iat is in the future');
  }
  if (nbf !== undefined && nbf > nowSec + skew) {
    throw new BridgeError('TOKEN_RESPONSE_INVALID', 'relay token is not active yet');
  }

  const jti = payload['jti'];
  if (typeof jti !== 'string' || jti.trim().length === 0) {
    throw new BridgeError('TOKEN_RESPONSE_INVALID', 'relay token jti claim is required');
  }

  return payload as RelayTokenClaims;
}
