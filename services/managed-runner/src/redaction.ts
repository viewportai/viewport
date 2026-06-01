import type { EphemeralSecret } from './types.js';

export function redactionValues(secrets: EphemeralSecret[] = []): string[] {
  return secrets
    .flatMap((secret) => [secret.value, secret.redactionHint])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function redact(value: string | undefined, secrets: EphemeralSecret[] = []): string | undefined {
  if (value === undefined) return undefined;
  return redactionValues(secrets).reduce((current, secret) => current.split(secret).join('[redacted]'), value);
}

export function redactEnv(env: Record<string, string> = {}, secrets: EphemeralSecret[] = []): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = redact(value, secrets) ?? '';
  }
  return redacted;
}
