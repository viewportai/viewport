import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
