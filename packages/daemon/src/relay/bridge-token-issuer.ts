import crypto from 'node:crypto';
import { transportFetch } from '../cli/network.js';
import { BridgeError } from './bridge-errors.js';
import { type RelayTokenClaims, verifyRelayTokenClaims } from './bridge-jwt.js';
import { parseRelayHandshakeProfile, type RelayHandshakeProfile } from './bridge-key-exchange.js';

interface RelayTokenResponse {
  ok: boolean;
  relayToken?: string;
  claims?: RelayTokenClaims;
  reason?: string;
  error?: string;
}

type JwksResponse = { keys?: Array<Record<string, unknown>> };

const MAX_JWKS_KEYS = 64;

export interface RelayTokenIssuerOptions {
  relayServerUrl: string;
  workspaceId: string;
  runtimeTargetId?: string;
  relayTlsVerify?: 'auto' | '0' | '1';
  relayCaCertPath?: string;
  relayTlsPins?: string[];
  relayTokenIssuer?: string;
  relayTokenAudience?: string;
  relayTokenJwksUrl?: string;
  relayTokenSigningKeys?: Record<string, string>;
  relayTokenClockSkewSec?: number;
}

export class RelayTokenIssuer {
  private readonly relayTokenJwksUrl: string | undefined;
  private readonly relayTokenSigningKeys: Record<string, string>;
  private jwksCacheExpiresAt = 0;
  private jwksCacheKeys: Record<string, string> = {};

  constructor(
    private readonly options: RelayTokenIssuerOptions,
    private daemonIssueToken: string | null,
  ) {
    this.relayTokenJwksUrl = options.relayTokenJwksUrl;
    this.relayTokenSigningKeys = options.relayTokenSigningKeys ?? {};
  }

  setDaemonIssueToken(token: string | null): void {
    this.daemonIssueToken = token;
  }

  async issue(): Promise<{
    relayToken: string;
    profile: RelayHandshakeProfile;
  }> {
    const url = `${this.options.relayServerUrl.replace(/\/+$/, '')}/api/runtime/relay-token`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    let res: Response;
    if (!this.daemonIssueToken) {
      throw new BridgeError('TOKEN_ISSUE_FAILED', 'missing daemon issue token');
    }
    try {
      res = await transportFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          role: 'workspace-daemon',
          workspaceId: this.options.workspaceId,
          runtimeTargetId: this.options.runtimeTargetId,
          credential: this.daemonIssueToken,
        }),
        signal: controller.signal,
        tlsVerify: this.options.relayTlsVerify ?? 'auto',
        caCertPath: this.options.relayCaCertPath,
        tlsPins: this.options.relayTlsPins,
      });
    } catch (error) {
      clearTimeout(timeout);
      throw new BridgeError(
        'TOKEN_ISSUE_FAILED',
        error instanceof Error ? error.message : String(error),
      );
    }
    clearTimeout(timeout);

    const parsed = await parseRelayIssueResponse(res);
    if (!res.ok || !parsed.ok || !parsed.relayToken) {
      const reason = parsed.reason ?? parsed.error ?? `HTTP ${res.status}`;
      throw new BridgeError('TOKEN_ISSUE_FAILED', `issue relay token failed: ${reason}`);
    }

    const tokenClaims = await this.verifyIssueResponseToken(parsed.relayToken);
    const profile = parseRelayHandshakeProfile(tokenClaims.e2eeProfile ?? 'noise-ik');
    if (!profile) {
      throw new BridgeError('TOKEN_RESPONSE_INVALID', 'missing/invalid e2eeProfile claim');
    }

    return {
      relayToken: parsed.relayToken,
      profile,
    };
  }

  private async verifyIssueResponseToken(relayToken: string): Promise<RelayTokenClaims> {
    let verificationKeys = await this.resolveRelayTokenVerificationKeys(false);
    try {
      return this.verifyTokenClaims(relayToken, verificationKeys);
    } catch (error) {
      if (
        this.relayTokenJwksUrl &&
        error instanceof BridgeError &&
        error.code === 'TOKEN_RESPONSE_INVALID' &&
        error.message.includes('is not trusted')
      ) {
        verificationKeys = await this.resolveRelayTokenVerificationKeys(true);
        return this.verifyTokenClaims(relayToken, verificationKeys);
      }
      throw error;
    }
  }

  private verifyTokenClaims(
    relayToken: string,
    signingKeys: Record<string, string>,
  ): RelayTokenClaims {
    return verifyRelayTokenClaims(relayToken, {
      issuer: this.options.relayTokenIssuer ?? 'viewport-server',
      audience: this.options.relayTokenAudience ?? 'viewport-relay',
      signingKeys,
      clockSkewSec: this.options.relayTokenClockSkewSec ?? 30,
    });
  }

  private async resolveRelayTokenVerificationKeys(
    forceRefresh: boolean,
  ): Promise<Record<string, string>> {
    if (!this.relayTokenJwksUrl) {
      return this.relayTokenSigningKeys;
    }
    const now = Date.now();
    if (!forceRefresh && now < this.jwksCacheExpiresAt && Object.keys(this.jwksCacheKeys).length) {
      return this.jwksCacheKeys;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    let res: Response;
    try {
      res = await transportFetch(this.relayTokenJwksUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
        tlsVerify: this.options.relayTlsVerify ?? 'auto',
        caCertPath: this.options.relayCaCertPath,
        tlsPins: this.options.relayTlsPins,
      });
    } catch (error) {
      clearTimeout(timeout);
      throw new BridgeError(
        'TOKEN_RESPONSE_INVALID',
        `failed to fetch JWKS: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    clearTimeout(timeout);

    if (!res.ok) {
      throw new BridgeError('TOKEN_RESPONSE_INVALID', `JWKS endpoint returned HTTP ${res.status}`);
    }

    const parsed = (await res.json().catch(() => null)) as JwksResponse | null;
    if (!parsed || !Array.isArray(parsed.keys)) {
      throw new BridgeError('TOKEN_RESPONSE_INVALID', 'JWKS response missing keys array');
    }
    if (parsed.keys.length > MAX_JWKS_KEYS) {
      throw new BridgeError(
        'TOKEN_RESPONSE_INVALID',
        `JWKS response contains too many keys (${parsed.keys.length} > ${MAX_JWKS_KEYS})`,
      );
    }

    const keys = parseJwksSigningKeys(parsed.keys);
    this.jwksCacheKeys = keys;
    this.jwksCacheExpiresAt = Date.now() + 5 * 60_000;
    return keys;
  }
}

async function parseRelayIssueResponse(res: Response): Promise<RelayTokenResponse> {
  const json = (await res.json().catch(() => null)) as RelayTokenResponse | null;
  if (!json) {
    return {
      ok: false,
      reason: `relay token endpoint returned non-JSON (${res.status})`,
    };
  }
  return json;
}

function parseJwksSigningKeys(entries: Array<Record<string, unknown>>): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const kid = typeof entry['kid'] === 'string' ? entry['kid'].trim() : '';
    const kty = typeof entry['kty'] === 'string' ? entry['kty'] : '';
    const alg = typeof entry['alg'] === 'string' ? entry['alg'] : '';
    const n = typeof entry['n'] === 'string' ? entry['n'] : '';
    const e = typeof entry['e'] === 'string' ? entry['e'] : '';
    if (!kid || kty !== 'RSA' || !n || !e) continue;
    if (alg && alg !== 'RS256') continue;

    try {
      const keyObject = crypto.createPublicKey({
        key: { kty: 'RSA', n, e },
        format: 'jwk',
      });
      keys[kid] = keyObject.export({ format: 'pem', type: 'spki' }).toString();
    } catch {
      continue;
    }
  }

  if (Object.keys(keys).length === 0) {
    throw new BridgeError('TOKEN_RESPONSE_INVALID', 'JWKS contained no usable signing keys');
  }

  return keys;
}
