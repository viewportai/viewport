import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

interface PackageJsonMeta {
  name?: unknown;
  version?: unknown;
}

function packageJsonPath(): string {
  return fileURLToPath(new URL('../../package.json', import.meta.url));
}

function readPackageJson(): PackageJsonMeta | null {
  try {
    const raw = fs.readFileSync(packageJsonPath(), 'utf-8');
    return JSON.parse(raw) as PackageJsonMeta;
  } catch {
    return null;
  }
}

export function resolvePackageRoot(): string {
  return path.dirname(packageJsonPath());
}

export function resolveCliEntrypointPath(): string {
  return fileURLToPath(new URL('../index.js', import.meta.url));
}

export function resolvePackageName(): string {
  const parsed = readPackageJson();
  if (typeof parsed?.name === 'string' && parsed.name.trim().length > 0) {
    return parsed.name;
  }
  return '@viewportai/daemon';
}

export function resolvePackageVersion(): string {
  const parsed = readPackageJson();
  if (typeof parsed?.version === 'string' && parsed.version.trim().length > 0) {
    return parsed.version;
  }
  return 'unknown';
}

function findGitRoot(start: string): string | null {
  let current = start;
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface PackageSourceInfo {
  kind: 'linked-local-build' | 'installed-package';
  repoRoot: string | null;
  gitRef: string | null;
}

export function resolvePackageSourceInfo(): PackageSourceInfo {
  const root = resolvePackageRoot();
  if (root.includes(`${path.sep}node_modules${path.sep}`)) {
    return {
      kind: 'installed-package',
      repoRoot: null,
      gitRef: null,
    };
  }

  const repoRoot = findGitRoot(root);
  let gitRef: string | null = null;
  if (repoRoot) {
    try {
      gitRef = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      gitRef = null;
    }
  }

  return {
    kind: 'linked-local-build',
    repoRoot,
    gitRef,
  };
}
