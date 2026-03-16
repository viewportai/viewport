import path from 'node:path';

export type DeploymentProfile = 'local' | 'lan' | 'relay';

export interface SecurityProfile {
  profile: DeploymentProfile;
  host: string;
  allowedHosts: string[] | true;
  allowedOrigins?: string[] | true;
  requireAuth: boolean;
}

export interface SecurityProfileInput {
  profile: DeploymentProfile;
  host: string;
  allowedHostsRaw?: string;
  allowedOriginsRaw?: string;
  explicitAuthFlag: boolean;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

export function parseAllowedHosts(raw?: string): string[] | true {
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  if (raw.trim().toLowerCase() === 'true') {
    return true;
  }
  return raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

export function buildSecurityProfile(input: SecurityProfileInput): SecurityProfile {
  const allowedHosts = parseAllowedHosts(input.allowedHostsRaw);
  const allowedOrigins = parseAllowedHosts(input.allowedOriginsRaw);
  const host = input.host.trim();
  if (host.length === 0) {
    throw new Error('Host is required');
  }

  if (input.profile === 'local' && !isLoopbackHost(host)) {
    throw new Error(
      `Profile "local" requires loopback host. Received "${host}". Use --profile lan or --profile relay.`,
    );
  }

  if ((input.profile === 'lan' || input.profile === 'relay') && allowedHosts !== true) {
    const hasEntries = Array.isArray(allowedHosts) && allowedHosts.length > 0;
    if (!hasEntries) {
      throw new Error(
        `Profile "${input.profile}" requires --allowed-hosts (comma list or "true") for host-header validation.`,
      );
    }
  }

  const requireAuth =
    input.profile === 'lan' || input.profile === 'relay' ? true : input.explicitAuthFlag;

  return {
    profile: input.profile,
    host,
    allowedHosts,
    allowedOrigins:
      allowedOrigins === true ? true : allowedOrigins.length > 0 ? allowedOrigins : [],
    requireAuth,
  };
}

function normalizeHostHeader(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed.startsWith('[')) {
    // IPv6 host headers are formatted as [::1]:7070.
    const close = trimmed.indexOf(']');
    if (close >= 0) {
      const hostPart = trimmed.slice(0, close + 1);
      return hostPart;
    }
  }
  const idx = trimmed.indexOf(':');
  return idx >= 0 ? trimmed.slice(0, idx) : trimmed;
}

function hostMatchesRule(host: string, rule: string): boolean {
  if (rule === host) return true;
  if (rule.startsWith('.')) {
    const suffix = rule.slice(1);
    // Guard against over-broad rules like ".com" / ".local" that match too much.
    if (!suffix.includes('.')) return false;
    return host === suffix || host.endsWith(rule);
  }
  return false;
}

export function isHostAllowed(hostHeader: string | undefined, profile: SecurityProfile): boolean {
  if (!hostHeader) return false;
  const host = normalizeHostHeader(hostHeader);
  if (!host) return false;

  if (profile.allowedHosts === true) {
    return true;
  }

  if (isLoopbackHost(host)) {
    return true;
  }

  for (const rule of profile.allowedHosts) {
    if (hostMatchesRule(host, rule)) {
      return true;
    }
  }

  return false;
}

export function isOriginAllowed(origin: string | undefined, profile: SecurityProfile): boolean {
  if (!origin || origin.trim().length === 0) {
    // Non-browser/CLI clients may not send Origin.
    return true;
  }
  const explicitOrigins = profile.allowedOrigins;
  if (explicitOrigins === true) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    const originHost = parsed.hostname.toLowerCase();
    if (isLoopbackHost(originHost)) return true;
    if (Array.isArray(explicitOrigins) && explicitOrigins.length > 0) {
      return explicitOrigins.some((rule) => hostMatchesRule(originHost, rule));
    }
    if (profile.allowedHosts === true) return true;
    return profile.allowedHosts.some((rule) => hostMatchesRule(originHost, rule));
  } catch {
    return false;
  }
}

export function isPathWithin(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  if (relative.length === 0) return true;
  if (relative === '..') return false;
  if (relative.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(relative);
}
