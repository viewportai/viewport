import fs from 'node:fs/promises';
import os from 'node:os';
import {
  configDir,
  configFilePath,
  loadConfig,
  resourceOverrideConfigFilePath,
} from '../core/config.js';
import { resolveDisplayVersion, resolvePackageSourceInfo } from '../core/package-meta.js';
import { getArgs } from './args.js';
import { printJson } from './command-shared.js';
import { supportPacketMetadata } from './support-packet.js';

const REDACTED = '[redacted]';
const SECRET_KEY_PATTERN =
  /(^|[_-])(token|secret|secrets|credential|password|passwd|private[_-]?key|authorization|cookie|api[_-]?key|claim|lease|bootstrap)([_-]|$)|issueToken|signingKeys|contextCandidateDecisionKeys/i;

export async function diagnostic(): Promise<void> {
  const args = getArgs();
  if (args.includes('--help') || args.includes('-h')) {
    showDiagnosticHelp();
    return;
  }

  const generatedAt = new Date().toISOString();
  const paths = {
    viewportHome: configDir(),
    configFile: configFilePath(),
    resourceOverrideConfigFile: resourceOverrideConfigFilePath(),
  };
  const configExists = await fileExists(paths.configFile);
  const source = resolvePackageSourceInfo();
  const config = await loadConfigSnapshot();

  printJson({
    command: 'diagnostic',
    ok: true,
    generatedAt,
    supportPacket: supportPacketMetadata(),
    runtime: {
      vpdVersion: resolveDisplayVersion(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cwd: process.cwd(),
      pid: process.pid,
      source: {
        kind: source.kind,
        gitRef: source.gitRef,
      },
    },
    paths,
    config: {
      present: configExists,
      ...config,
    },
  });
}

function showDiagnosticHelp(): void {
  console.log('Usage: vpd diagnostic [--json]');
  console.log('');
  console.log('Print a sanitized JSON support snapshot.');
}

async function loadConfigSnapshot(): Promise<
  { ok: true; value: unknown } | { ok: false; value: null; error: string }
> {
  try {
    return { ok: true, value: redactSecrets(await loadConfig()) };
  } catch (err) {
    return {
      ok: false,
      value: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fileExists(path: string | null): Promise<boolean> {
  if (!path) return false;
  try {
    const stat = await fs.stat(path);
    return stat.isFile();
  } catch {
    return false;
  }
}

function redactSecrets(value: unknown, keyPath: string[] = []): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactSecrets(entry, [...keyPath, String(index)]));
  }

  if (!isJsonRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = [...keyPath, key];
    if (shouldRedactKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactSecrets(entry, nextPath);
  }
  return out;
}

function shouldRedactKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
