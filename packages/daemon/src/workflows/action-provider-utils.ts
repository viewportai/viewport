import { Buffer } from 'node:buffer';
import type { WorkflowInputValue } from './types.js';

export function withIdempotencyHeader(
  headers: Record<string, string>,
  idempotencyKey: string | undefined,
): Record<string, string> {
  if (!idempotencyKey) return headers;
  const alreadySet = Object.keys(headers).some((key) => key.toLowerCase() === 'idempotency-key');
  return alreadySet ? headers : { ...headers, 'Idempotency-Key': idempotencyKey };
}

export function idempotencyKeyFromHeaders(headers: Record<string, string>): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'idempotency-key');
  return entry?.[1];
}

export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export function jiraHeaders(token: string, email?: string): Record<string, string> {
  if (email) {
    return { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
  }
  return { Authorization: `Bearer ${token}` };
}

export function jiraDocument(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

export function normalizedBaseUrl(value: string | undefined): string | undefined {
  return value ? value.replace(/\/+$/, '') : undefined;
}

export function booleanValue(value: WorkflowInputValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function objectString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === 'string' ? entry : null;
}

export function objectNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === 'number' ? entry : null;
}

export function objectBoolean(value: unknown, key: string): boolean | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === 'boolean' ? entry : null;
}

export function stringValue(value: WorkflowInputValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function credentialRefValue(
  input: Record<string, WorkflowInputValue>,
  fallback: string,
): string {
  return stringValue(input['credential_ref']) ?? stringValue(input['credentialRef']) ?? fallback;
}

function explicitCredentialRefValue(input: Record<string, WorkflowInputValue>): string | undefined {
  return stringValue(input['credential_ref']) ?? stringValue(input['credentialRef']);
}

export function envNameForCredentialRef(ref: string): string {
  return `VIEWPORT_CREDENTIAL_${ref
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()}`;
}

export function providerCredentialValue(
  input: Record<string, WorkflowInputValue>,
  _options: { defaultRef: string; defaultEnv: string },
): string | undefined {
  const explicitRef = explicitCredentialRefValue(input);
  if (!explicitRef) return undefined;

  const refEnvValue = process.env[envNameForCredentialRef(explicitRef)];
  if (refEnvValue) return refEnvValue;
  return undefined;
}

export async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
