import { transportFetch } from '../cli/network.js';
import type { Daemon } from '../core/daemon.js';
import { BridgeError } from '../relay/bridge-errors.js';
import { verifyRelayTokenClaims } from '../relay/bridge-jwt.js';
import { parseJwksSigningKeys } from '../relay/bridge-token-issuer.js';

type TrustedEdgeCommandPurpose =
  | 'context-candidate-preview'
  | 'context-resolve'
  | 'trusted-edge-plan-decrypt'
  | 'trusted-edge-plan-decrypt-field'
  | 'trusted-edge-plan-encrypt-field'
  | 'trusted-edge-plan-wrap-key';

interface VerifyTrustedEdgeCommandCapabilityInput {
  token?: string;
  workspaceId: string;
  purpose: TrustedEdgeCommandPurpose;
  contextResourceId?: string;
  candidateEventId?: string;
  payloadDigest?: string;
  planId?: string;
}

type RelayConfig = NonNullable<ReturnType<Daemon['configManager']['getDaemonConfig']>>['relay'];
type RelayBinding = NonNullable<NonNullable<RelayConfig>['bindings']>[number];

interface VerificationConfig {
  issuer?: string;
  audience?: string;
  jwksUrl?: string;
  signingKeys?: Record<string, string>;
  clockSkewSec?: number;
  tlsVerify?: 'auto' | '0' | '1';
  caCertPath?: string;
  tlsPins?: string[];
}

const jwksCache = new Map<string, { expiresAt: number; keys: Record<string, string> }>();
const JWKS_CACHE_MS = 5 * 60_000;

export async function verifyTrustedEdgeCommandCapability(
  daemon: Daemon,
  input: VerifyTrustedEdgeCommandCapabilityInput,
): Promise<void> {
  const token = input.token?.trim();
  if (!token) {
    throw new Error('Trusted-edge command capability is required.');
  }

  const config = resolveVerificationConfig(daemon, input.workspaceId);
  const signingKeys = await resolveSigningKeys(config);
  const claims = verifyRelayTokenClaims(token, {
    issuer: config.issuer,
    audience: config.audience,
    signingKeys,
    clockSkewSec: config.clockSkewSec ?? 30,
  });
  const claimMap = claims as unknown as Record<string, unknown>;

  requireClaim(claimMap['scope'], 'trusted-edge-command', 'scope');
  requireClaim(claimMap['role'], 'trusted-edge-client', 'role');
  requireClaim(claimMap['workspaceId'], input.workspaceId, 'workspaceId');
  requireClaim(claimMap['purpose'], input.purpose, 'purpose');
  requireStringClaim(claimMap['trustedEdgeUnlockSessionId'], 'trustedEdgeUnlockSessionId');

  if (input.contextResourceId) {
    requireClaim(claimMap['contextResourceId'], input.contextResourceId, 'contextResourceId');
  }
  if (input.candidateEventId) {
    requireClaim(claimMap['candidateEventId'], input.candidateEventId, 'candidateEventId');
  }
  if (input.payloadDigest) {
    requireClaim(claimMap['payloadDigest'], input.payloadDigest, 'payloadDigest');
  }
  if (input.planId) {
    requireClaim(claimMap['planId'], input.planId, 'planId');
  }
}

function requireClaim(actual: unknown, expected: string, name: string): void {
  if (typeof actual !== 'string' || actual !== expected) {
    throw new Error(`Trusted-edge command capability ${name} mismatch.`);
  }
}

function requireStringClaim(actual: unknown, name: string): void {
  if (typeof actual !== 'string' || actual.trim() === '') {
    throw new Error(`Trusted-edge command capability ${name} is required.`);
  }
}

function resolveVerificationConfig(daemon: Daemon, workspaceId: string): VerificationConfig {
  const relay = daemon.configManager.getDaemonConfig()?.relay;
  const binding = relay?.bindings?.find(
    (candidate) => candidate.enabled !== false && candidate.workspaceId === workspaceId,
  );
  const source: RelayBinding | RelayConfig | undefined = binding ?? relay;

  if (!source) {
    throw new Error('Trusted-edge command capability verification is not configured.');
  }

  return {
    issuer: source.tokenIssuer,
    audience: source.tokenAudience,
    jwksUrl: source.tokenJwksUrl,
    signingKeys: source.signingKeys,
    clockSkewSec: source.tokenClockSkewSec,
    tlsVerify: source.tlsVerify,
    caCertPath: source.caCertPath,
    tlsPins: source.tlsPins,
  };
}

async function resolveSigningKeys(config: VerificationConfig): Promise<Record<string, string>> {
  const explicit = config.signingKeys ?? {};
  if (!config.jwksUrl) {
    if (Object.keys(explicit).length === 0) {
      throw new Error('Trusted-edge command capability signing keys are not configured.');
    }
    return explicit;
  }

  const cached = jwksCache.get(config.jwksUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await transportFetch(config.jwksUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
      tlsVerify: config.tlsVerify ?? 'auto',
      caCertPath: config.caCertPath,
      tlsPins: config.tlsPins,
    });
    if (!response.ok) {
      throw new Error(`JWKS endpoint returned HTTP ${response.status}`);
    }
    const payload = (await response.json().catch(() => null)) as {
      keys?: Array<Record<string, unknown>>;
    } | null;
    if (!payload || !Array.isArray(payload.keys)) {
      throw new Error('JWKS response missing keys array.');
    }
    const keys = parseJwksSigningKeys(payload.keys);
    jwksCache.set(config.jwksUrl, { expiresAt: Date.now() + JWKS_CACHE_MS, keys });
    return keys;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new Error(
      `Trusted-edge command capability key lookup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
