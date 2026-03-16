import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface NpmInvocation {
  nodePath: string;
  npmPath: string;
  command: string;
  argsPrefix: string[];
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function resolveNodePathFromPid(pid: number): { nodePath: string | null; error?: string } {
  const result = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    return { nodePath: null, error: `ps failed: ${normalizeError(result.error)}` };
  }
  if ((result.status ?? 1) !== 0) {
    return {
      nodePath: null,
      error: result.stderr?.trim() || `ps exited with code ${result.status ?? 1}`,
    };
  }
  const resolved = result.stdout.trim();
  if (!resolved) {
    return { nodePath: null, error: 'empty command path' };
  }
  return { nodePath: resolved };
}

export function resolvePreferredNodePath(params: {
  daemonPid?: number | null;
  fallbackNodePath?: string;
}): { nodePath: string; source: 'daemon_pid' | 'current_process'; note?: string } {
  const fallback = params.fallbackNodePath ?? process.execPath;
  if (typeof params.daemonPid === 'number' && params.daemonPid > 0) {
    const fromPid = resolveNodePathFromPid(params.daemonPid);
    if (fromPid.nodePath) {
      return { nodePath: fromPid.nodePath, source: 'daemon_pid' };
    }
    return {
      nodePath: fallback,
      source: 'current_process',
      note: `Unable to resolve daemon node path from pid ${params.daemonPid}: ${fromPid.error ?? 'unknown error'}`,
    };
  }
  return { nodePath: fallback, source: 'current_process' };
}

export function resolveNpmInvocationFromNode(nodePath: string): NpmInvocation {
  const binDir = path.dirname(nodePath);
  const prefix = path.dirname(binDir);
  const npmBinary = path.join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');

  if (existsSync(npmBinary)) {
    return {
      nodePath,
      npmPath: npmBinary,
      command: npmBinary,
      argsPrefix: [],
    };
  }

  const npmCliCandidates = [
    path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];

  for (const candidate of npmCliCandidates) {
    if (existsSync(candidate)) {
      return {
        nodePath,
        npmPath: candidate,
        command: nodePath,
        argsPrefix: [candidate],
      };
    }
  }

  throw new Error(`Unable to resolve npm for node executable: ${nodePath}`);
}

export function formatNpmInvocation(invocation: NpmInvocation): string {
  if (invocation.argsPrefix.length === 0) {
    return invocation.command;
  }
  return `${invocation.command} ${invocation.argsPrefix.join(' ')}`;
}

function parseVersionFromNpmOutput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string' && parsed.trim().length > 0) {
      return parsed.trim();
    }
  } catch {
    // fall through
  }

  return trimmed.replace(/^"+|"+$/g, '').trim() || null;
}

function firstMeaningfulNpmLine(stderr: string): string | null {
  for (const rawLine of stderr.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.toLowerCase().startsWith('npm notice')) continue;
    return line.replace(/^npm ERR!\s*/i, '').trim();
  }
  return null;
}

export function classifyUpdateCheckFailure(params: {
  packageName: string;
  stderr: string;
  exitCode: number;
}): string {
  const normalized = params.stderr.trim();
  const lower = normalized.toLowerCase();
  const packageToken = `'${params.packageName.toLowerCase()}@*' is not in this registry`;

  if (
    lower.includes('e404') &&
    (lower.includes(packageToken) ||
      lower.includes('not found - get https://registry.npmjs.org/') ||
      lower.includes('404 not found'))
  ) {
    return 'update check unavailable: package not published yet';
  }

  if (
    lower.includes('access token expired or revoked') ||
    lower.includes('eneedauth') ||
    lower.includes('e401')
  ) {
    return 'update check unavailable: npm auth issue';
  }

  if (
    lower.includes('enotfound') ||
    lower.includes('eai_again') ||
    lower.includes('network is unreachable') ||
    lower.includes('timed out')
  ) {
    return 'update check unavailable: network issue';
  }

  const message = firstMeaningfulNpmLine(normalized);
  if (message) {
    return `update check failed: ${message}`;
  }
  return `update check failed: npm exited ${params.exitCode}`;
}

export function fetchLatestVersion(params: {
  npm: NpmInvocation;
  packageName: string;
  timeoutMs?: number;
}): { version: string | null; note?: string } {
  const result = spawnSync(
    params.npm.command,
    [...params.npm.argsPrefix, 'view', params.packageName, 'version', '--json'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      timeout: params.timeoutMs ?? 3000,
    },
  );

  if (result.error) {
    return { version: null, note: `update check failed: ${normalizeError(result.error)}` };
  }

  if ((result.status ?? 1) !== 0) {
    return {
      version: null,
      note: classifyUpdateCheckFailure({
        packageName: params.packageName,
        stderr: result.stderr ?? '',
        exitCode: result.status ?? 1,
      }),
    };
  }

  const version = parseVersionFromNpmOutput(result.stdout);
  if (!version) {
    return { version: null, note: 'update check failed: empty response' };
  }

  return { version };
}

export function compareSemver(left: string, right: string): number | null {
  const parse = (value: string): [number, number, number] | null => {
    const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const l = parse(left);
  const r = parse(right);
  if (!l || !r) return null;

  const [lMajor, lMinor, lPatch] = l;
  const [rMajor, rMinor, rPatch] = r;
  if (lMajor < rMajor) return -1;
  if (lMajor > rMajor) return 1;
  if (lMinor < rMinor) return -1;
  if (lMinor > rMinor) return 1;
  if (lPatch < rPatch) return -1;
  if (lPatch > rPatch) return 1;

  return 0;
}
