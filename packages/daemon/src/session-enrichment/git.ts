import { execFileSync } from 'node:child_process';

export interface GitRepositoryMetadata {
  repoRoot: string | null;
  repoRemoteUrl: string | null;
  repoBranch: string | null;
  repoSha: string | null;
  isGitRepository: boolean;
}

const EMPTY_GIT_METADATA: GitRepositoryMetadata = {
  repoRoot: null,
  repoRemoteUrl: null,
  repoBranch: null,
  repoSha: null,
  isGitRepository: false,
};

export function createGitMetadataResolver(): (
  directoryPath?: string | null,
) => GitRepositoryMetadata {
  const cache = new Map<string, GitRepositoryMetadata>();
  return (directoryPath) => {
    const key = directoryPath?.trim();
    if (!key) return EMPTY_GIT_METADATA;
    const cached = cache.get(key);
    if (cached) return cached;
    const metadata = resolveGitMetadata(key);
    cache.set(key, metadata);
    return metadata;
  };
}

function resolveGitMetadata(directoryPath: string): GitRepositoryMetadata {
  const repoRoot = gitOutput(directoryPath, ['rev-parse', '--show-toplevel']);
  if (!repoRoot) return EMPTY_GIT_METADATA;

  return {
    repoRoot,
    repoRemoteUrl: gitOutput(directoryPath, ['config', '--get', 'remote.origin.url']),
    repoBranch: gitOutput(directoryPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    repoSha: gitOutput(directoryPath, ['rev-parse', 'HEAD']),
    isGitRepository: true,
  };
}

function gitOutput(directoryPath: string, args: string[]): string | null {
  try {
    const output = execFileSync('git', ['-C', directoryPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}
