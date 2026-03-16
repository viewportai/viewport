import type { RuntimeLaunchConfig } from './cli/supervisor-protocol.js';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function looksLikePlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.includes('change-me') ||
    normalized.includes('placeholder') ||
    normalized.includes('example') ||
    normalized.length < 24
  );
}

function hasTrustedSigningKeys(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([kid, key]) => isNonEmptyString(kid) && isNonEmptyString(key),
  ) as Array<[string, string]>;
  if (entries.length === 0) return false;
  return entries.every(([, key]) => !looksLikePlaceholderSecret(key));
}

function hasTrustedJwksUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') {
      return true;
    }
    if (parsed.protocol === 'http:') {
      const host = parsed.hostname.trim().toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host === '::1';
    }
    return false;
  } catch {
    return false;
  }
}

export function validateRelayRuntimeSecurity(config: RuntimeLaunchConfig): void {
  if (!config.relayEnabled) return;

  const hasSigningKeys = hasTrustedSigningKeys(config.relayTokenSigningKeys);
  const hasJwksUrl = hasTrustedJwksUrl(config.relayTokenJwksUrl);
  if (!hasSigningKeys && !hasJwksUrl) {
    throw new Error(
      'relay token verification requires either trusted signing keys or an https JWKS URL when relay is enabled',
    );
  }

  if (config.profile === 'local') return;

  if (config.relayTlsVerify !== '1') {
    throw new Error('relay tls verify must be 1 outside local profile when relay is enabled');
  }

  const relayEndpoint = config.relayEndpoint ?? '';
  if (!relayEndpoint.startsWith('wss://')) {
    throw new Error('relay endpoint must use wss outside local profile when relay is enabled');
  }
  const pins = Array.isArray(config.relayTlsPins)
    ? config.relayTlsPins.filter((entry) => isNonEmptyString(entry))
    : [];
  if (pins.length === 0) {
    throw new Error('relay tls pins are required for wss relay endpoints outside local profile');
  }
}
