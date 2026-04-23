import fs from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { configDir } from '../core/config.js';
import { getFlag, hasFlag } from './args.js';
import { daemonFetch } from './daemon-client.js';

export const CLI_SCHEMA_VERSION = 1;
export type OutputFormat = 'text' | 'json' | 'yaml' | 'table';

export interface TableColumn {
  key: string;
  header: string;
  format?: (value: unknown, row: Record<string, unknown>) => string;
}

export interface TableOptions {
  rows: Array<Record<string, unknown>>;
  columns?: TableColumn[];
  emptyMessage?: string;
}

export interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
  sessions: number;
  directories: number;
  agents: string;
  pid?: number;
  host?: string;
  port?: number;
  listen?: string;
  socketPath?: string;
  startedAt?: number;
  process?: {
    node?: string;
    platform?: string;
    arch?: string;
    memoryRss?: number;
    memoryHeapUsed?: number;
    memoryHeapTotal?: number;
  };
  relay?: {
    enabled: boolean;
    state?: 'stopped' | 'connecting' | 'connected' | 'waiting_retry' | 'circuit_open';
    reconnectAttempt?: number;
    lastErrorCode?: string;
    lastErrorMessage?: string;
    lastErrorAt?: number;
    circuitOpenUntil?: number;
  };
}

export function shortError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function printJson(value: unknown): void {
  if (isJsonRecord(value) && typeof value['schemaVersion'] !== 'number') {
    console.log(
      JSON.stringify(
        {
          schemaVersion: CLI_SCHEMA_VERSION,
          ...value,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

export function isJsonMode(): boolean {
  return hasFlag('json');
}

function isComplexYamlValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return true;
  return typeof value === 'object';
}

function yamlString(value: string): string {
  if (/^[A-Za-z0-9._:/-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return yamlString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function yamlKey(value: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function renderYamlLines(value: unknown, indent = 0): string[] {
  const pad = ' '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${pad}[]`];
    }
    const out: string[] = [];
    for (const item of value) {
      if (isComplexYamlValue(item)) {
        out.push(`${pad}-`);
        out.push(...renderYamlLines(item, indent + 2));
      } else {
        out.push(`${pad}- ${yamlScalar(item)}`);
      }
    }
    return out;
  }

  if (isJsonRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return [`${pad}{}`];
    }
    const out: string[] = [];
    for (const [key, entryValue] of entries) {
      if (isComplexYamlValue(entryValue)) {
        out.push(`${pad}${yamlKey(key)}:`);
        out.push(...renderYamlLines(entryValue, indent + 2));
      } else {
        out.push(`${pad}${yamlKey(key)}: ${yamlScalar(entryValue)}`);
      }
    }
    return out;
  }

  return [`${pad}${yamlScalar(value)}`];
}

export function printYaml(value: unknown): void {
  console.log(renderYamlLines(value).join('\n'));
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => stringifyCell(item)).join(', ');
  return JSON.stringify(value);
}

function defaultTableColumns(rows: Array<Record<string, unknown>>): TableColumn[] {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) keys.add(key);
  }
  return [...keys].sort((a, b) => a.localeCompare(b)).map((key) => ({ key, header: key }));
}

export function printTable(options: TableOptions): void {
  const { rows, columns = defaultTableColumns(options.rows), emptyMessage = 'No rows.' } = options;
  if (rows.length === 0) {
    console.log(emptyMessage);
    return;
  }
  const widths = columns.map((column) => {
    let width = column.header.length;
    for (const row of rows) {
      const raw = row[column.key];
      const value = column.format ? column.format(raw, row) : stringifyCell(raw);
      width = Math.max(width, value.length);
    }
    return width;
  });
  const header = columns
    .map((column, idx) => column.header.padEnd(widths[idx] ?? column.header.length))
    .join('  ');
  const separator = columns
    .map((column, idx) => '-'.repeat(widths[idx] ?? column.header.length))
    .join('  ');
  const body = rows.map((row) =>
    columns
      .map((column, idx) => {
        const raw = row[column.key];
        const value = column.format ? column.format(raw, row) : stringifyCell(raw);
        return value.padEnd(widths[idx] ?? value.length);
      })
      .join('  '),
  );
  console.log([header, separator, ...body].join('\n'));
}

export function resolveOutputFormat(options?: { allowTable?: boolean }): OutputFormat {
  const rawFormat = getFlag('format');
  const wantsJson = hasFlag('json');
  if (!rawFormat) {
    return wantsJson ? 'json' : 'text';
  }

  if (
    rawFormat !== 'json' &&
    rawFormat !== 'yaml' &&
    rawFormat !== 'table' &&
    rawFormat !== 'text'
  ) {
    throw new Error(`Invalid --format value: ${rawFormat}. Expected text|json|yaml|table.`);
  }

  if (wantsJson && rawFormat !== 'json') {
    throw new Error('Cannot combine --json with --format other than json.');
  }
  if (rawFormat === 'table' && !options?.allowTable) {
    throw new Error('Table output is not supported for this command.');
  }
  return rawFormat;
}

export function printStructured(
  value: unknown,
  options?: { format?: OutputFormat; table?: TableOptions },
): void {
  const format = options?.format ?? resolveOutputFormat({ allowTable: !!options?.table });
  if (format === 'json') {
    printJson(value);
    return;
  }
  if (format === 'yaml') {
    printYaml(value);
    return;
  }
  if (format === 'table') {
    if (!options?.table) {
      throw new Error('Table output requires table configuration.');
    }
    printTable(options.table);
    return;
  }
  // text format is handled by command-specific renderers.
}

export function parseTimeoutMs(raw: string | undefined, fallbackMs: number): number {
  if (!raw || raw.trim().length === 0) {
    return fallbackMs;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid --timeout value: ${raw}`);
  }
  return Math.ceil(seconds * 1000);
}

export function resolvePackageName(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf-8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
      return parsed.name;
    }
  } catch {
    // fall through
  }
  return '@viewportai/daemon';
}

export function resolvePackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
      return parsed.version;
    }
  } catch {
    // fall through
  }
  return 'unknown';
}

export async function readDaemonHealth(): Promise<HealthResponse | null> {
  const res = await daemonFetch('/health');
  if (!res || !res.ok) return null;
  return (await res.json()) as HealthResponse;
}

export async function waitForDaemonReady(options?: {
  timeoutMs?: number;
  intervalMs?: number;
  requireRelayConnected?: boolean;
}): Promise<HealthResponse> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const intervalMs = options?.intervalMs ?? 250;
  const requireRelayConnected = options?.requireRelayConnected ?? false;
  const deadline = Date.now() + timeoutMs;
  let lastHealth: HealthResponse | null = null;

  while (Date.now() < deadline) {
    const health = await readDaemonHealth();
    if (health) {
      lastHealth = health;
      if (!requireRelayConnected) {
        return health;
      }

      if (health.relay?.enabled && health.relay.state === 'connected') {
        return health;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (requireRelayConnected) {
    const relayState = lastHealth?.relay?.state ?? 'unavailable';
    throw new Error(
      `Timed out waiting for daemon relay reconnect (last relay state: ${relayState})`,
    );
  }

  throw new Error('Timed out waiting for daemon health');
}

export async function requestLifecycle(action: 'shutdown' | 'restart'): Promise<boolean> {
  const res = await daemonFetch(`/api/lifecycle/${action}`, { method: 'POST' });
  return !!(res && res.ok);
}

export async function readAuthTokenForPairing(): Promise<string | null> {
  try {
    const tokenPath = path.join(configDir(), 'auth-token');
    const token = (await fs.readFile(tokenPath, 'utf-8')).trim();
    return token || null;
  } catch {
    return null;
  }
}
