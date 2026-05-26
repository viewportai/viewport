export type GitContextUpdateTargetScope = 'repo' | 'directory' | 'file';

export interface GitContextUpdateTargetRef {
  provider: 'git';
  owner: string;
  repo: string;
  repository: string;
  path: string | null;
  scope: GitContextUpdateTargetScope;
}

export function parseGitContextUpdateTargetRef(ref: string): GitContextUpdateTargetRef | null {
  if (!ref.startsWith('git://')) return null;
  const rest = ref.slice('git://'.length);
  const parts = rest.split('/');
  const owner = parts[0]?.trim();
  const repo = parts[1]?.trim();
  if (!owner || !repo) return null;

  const rawPath = parts.slice(2).join('/').replace(/\/+/g, '/');
  if (!rawPath) {
    return { provider: 'git', owner, repo, repository: `${owner}/${repo}`, path: null, scope: 'repo' };
  }

  const directory = ref.endsWith('/');
  const normalizedPath = directory && !rawPath.endsWith('/') ? `${rawPath}/` : rawPath;
  return {
    provider: 'git',
    owner,
    repo,
    repository: `${owner}/${repo}`,
    path: normalizedPath,
    scope: directory ? 'directory' : 'file',
  };
}

export function gitContextTargetAllowsPath(target: GitContextUpdateTargetRef, path: string): boolean {
  const normalized = normalizeRelativeGitPath(path);
  if (!normalized) return false;

  if (target.scope === 'repo') return true;
  if (!target.path) return false;
  if (target.scope === 'directory') return normalized.startsWith(target.path);
  return normalized === target.path;
}

function normalizeRelativeGitPath(path: string): string | null {
  const segments = path
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return segments.join('/');
}
