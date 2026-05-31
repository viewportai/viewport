const REDACTED = '[redacted]';

const SECRET_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-=]+/gi,
  /\bgh[ospru]_[A-Za-z0-9_]{8,}\b/g,
  /\bsk-[A-Za-z0-9][A-Za-z0-9._-]{6,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
  /\bvp(?:claim|dt|exec|runner)_[A-Za-z0-9._-]+\b/gi,
  /\b(?:api[_-]?key|token|secret|password)=\S+/gi,
];

const SAFE_TOKEN_COUNTER_KEYS = new Set([
  'inputtoken',
  'inputtokens',
  'outputtoken',
  'outputtokens',
  'totaltoken',
  'totaltokens',
  'maxtoken',
  'maxtokens',
  'budgetedtoken',
  'budgetedtokens',
  'tokenusage',
]);

export function redactSecretsFromString(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }

  return redacted;
}

export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return redactSecretsFromString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, seen));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecretsFromString(value.message),
      stack: value.stack ? redactSecretsFromString(value.stack) : undefined,
    };
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = isSensitiveKey(key) ? REDACTED : redactSecrets(item, seen);
  }

  return redacted;
}

export function redactLogArgs(args: unknown[]): unknown[] {
  return args.map((arg) => redactSecrets(arg));
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_.]/g, '');
  if (SAFE_TOKEN_COUNTER_KEYS.has(normalized)) {
    return false;
  }

  if (normalized === 'authorization' || normalized === 'credential') {
    return true;
  }

  if (
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('apikey') ||
    normalized.includes('privatekey')
  ) {
    return true;
  }

  return normalized === 'token' || normalized.endsWith('token');
}
