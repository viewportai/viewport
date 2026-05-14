import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../core/config.js';
import type {
  ContextProviderAdapter,
  ContextProviderProposeInput,
  ContextProviderResult,
  ContextProviderSearchInput,
} from './types.js';

const DEFAULT_SIZE_BUDGET_BYTES = 100 * 1024;
const MAX_DOCS_PER_PROVIDER = 50;
const MAX_SEARCH_SNIPPET_BYTES = 8 * 1024;

type GitHubContextItem = {
  id: string;
  title: string;
  body: string;
  digest: string;
  sourcePath: string;
};

export const githubRepoProviderAdapter: ContextProviderAdapter = {
  kind: 'github-repo',
  async search(input) {
    const repo = await ensureSyncedRepo(input);
    const items = await resolveGitHubContextItems(input, repo);
    return items.map((item) => resultForItem(input.provider.id, item, input.query));
  },
  async get(input) {
    const repo = await ensureSyncedRepo(input);
    const items = await resolveGitHubContextItems(input, repo);
    return items
      .map((item) => resultForItem(input.provider.id, item))
      .find((item) => item.id === input.entryId);
  },
  async propose(input) {
    const repo = await ensureSyncedRepo(input);
    const branch = await createProposalBranch(input, repo);
    const filePath = await writeProposalFile(input, repo);
    await ensureGitIdentity(repo);
    await runGit(['add', filePath], repo);
    await runGit(
      ['commit', '-m', `docs(context): ${singleLine(input.title).slice(0, 72)}`],
      repo,
    );
    await runGit(['push', '-u', 'origin', branch], repo);

    const pr = await tryCreatePullRequest(input, repo);
    const bodyDigest = `sha256:${crypto.createHash('sha256').update(input.body).digest('hex')}`;
    return {
      candidate_id: pr.url ?? `github-pr:${input.provider.id}:${branch}`,
      payload_digest: bodyDigest,
      status: pr.url ? 'pull_request_opened' : 'branch_pushed',
      pull_request_url: pr.url,
      branch,
      source: `github-repo://${input.provider.repo}/${filePath}`,
    };
  },
};

async function resolveGitHubContextItems(
  input: ContextProviderSearchInput,
  repoRoot: string,
): Promise<GitHubContextItem[]> {
  const budget = input.sizeBudgetBytes ?? DEFAULT_SIZE_BUDGET_BYTES;
  const patterns = input.provider.paths?.length ? input.provider.paths : ['context/**/*.md', '**/*.md'];
  const files = await discoverProviderFiles(repoRoot, patterns);
  const ranked = rankFiles(files, input.query);
  const items: GitHubContextItem[] = [];
  let usedBytes = 0;

  for (const filePath of ranked) {
    if (items.length >= MAX_DOCS_PER_PROVIDER) break;
    const stat = await safeStat(filePath);
    if (!stat || stat.size <= 0 || stat.size > budget || usedBytes + stat.size > budget) continue;
    const raw = await fs.readFile(filePath, 'utf8');
    usedBytes += Buffer.byteLength(raw, 'utf8');
    const relative = relativePath(repoRoot, filePath);
    items.push({
      id: `${input.provider.id}:${relative}`,
      title: relative,
      body: raw.trim(),
      sourcePath: filePath,
      digest: `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`,
    });
  }

  return items;
}

async function ensureSyncedRepo(input: ContextProviderSearchInput | ContextProviderProposeInput) {
  const provider = input.provider;
  const remote = provider.remote ?? repoToRemote(provider.repo);
  if (!remote) throw new Error(`github-repo provider ${provider.id} requires repo or remote`);
  const cachePath = providerCachePath(input.home, remote);
  const exists = await safeStat(path.join(cachePath, '.git'));
  if (!exists) {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await runGit(['clone', remote, cachePath], undefined);
  }

  await runGit(['fetch', '--prune', 'origin'], cachePath);
  const ref = provider.ref ?? provider.branch ?? 'main';
  await runGit(['checkout', ref], cachePath);
  await runGit(['pull', '--ff-only', 'origin', ref], cachePath).catch(() => undefined);
  return cachePath;
}

async function createProposalBranch(input: ContextProviderProposeInput, repoRoot: string) {
  const base = input.provider.branch ?? input.provider.ref ?? 'main';
  await runGit(['checkout', base], repoRoot);
  const branch = `viewport/context/${slugify(input.title)}-${Date.now().toString(36)}`;
  await runGit(['checkout', '-b', branch], repoRoot);
  return branch;
}

async function writeProposalFile(input: ContextProviderProposeInput, repoRoot: string) {
  const directory = path.join(repoRoot, 'context', 'proposals');
  await fs.mkdir(directory, { recursive: true });
  const fileName = `${new Date().toISOString().slice(0, 10)}-${slugify(input.title)}.md`;
  const filePath = path.join(directory, fileName);
  const content = [
    '---',
    `title: ${JSON.stringify(input.title)}`,
    `source_kind: ${JSON.stringify(input.sourceKind)}`,
    `source: ${JSON.stringify(input.source ?? '')}`,
    `proposed_by: ${JSON.stringify(input.actorName)}`,
    `manifest_digest: ${JSON.stringify(input.manifestDigest)}`,
    '---',
    '',
    input.body.trim(),
    '',
  ].join('\n');
  await fs.writeFile(filePath, content, 'utf8');
  return relativePath(repoRoot, filePath);
}

async function tryCreatePullRequest(
  input: ContextProviderProposeInput,
  repoRoot: string,
): Promise<{ url?: string }> {
  const body = [
    input.body.trim(),
    '',
    '---',
    `Viewport provider: \`${input.provider.id}\``,
    `Source kind: \`${input.sourceKind}\``,
    `Source: \`${input.source ?? 'not provided'}\``,
    `Manifest: \`${input.manifestDigest}\``,
  ].join('\n');

  try {
    const result = await runCommand(
      'gh',
      ['pr', 'create', '--fill', '--title', input.title, '--body', body],
      repoRoot,
    );
    const url = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^https:\/\/github\.com\/.+\/pull\/\d+/.test(line));
    return url ? { url } : {};
  } catch {
    return {};
  }
}

async function ensureGitIdentity(repoRoot: string): Promise<void> {
  const name = await runGit(['config', '--get', 'user.name'], repoRoot).catch(() => null);
  if (!name?.stdout.trim()) {
    await runGit(['config', 'user.name', 'Viewport Context'], repoRoot);
  }
  const email = await runGit(['config', '--get', 'user.email'], repoRoot).catch(() => null);
  if (!email?.stdout.trim()) {
    await runGit(['config', 'user.email', 'context@getviewport.local'], repoRoot);
  }
}

function resultForItem(providerId: string, item: GitHubContextItem, query?: string): ContextProviderResult {
  return {
    id: item.id,
    provider_id: providerId,
    provider: 'github-repo',
    privacy: 'third_party_terms',
    title: item.title,
    body: query ? searchSnippet(item.body, query) : item.body,
    digest: item.digest,
    source: item.sourcePath,
  };
}

function repoToRemote(repo: string | undefined): string | undefined {
  const trimmed = repo?.trim();
  if (!trimmed) return undefined;
  if (/^(https?:|git@|ssh:|file:)/.test(trimmed)) return trimmed;
  return `git@github.com:${trimmed}.git`;
}

function providerCachePath(home: string | undefined, remote: string): string {
  const root = home ? path.resolve(home) : configDir();
  const digest = crypto.createHash('sha256').update(remote).digest('hex').slice(0, 16);
  return path.join(root, 'context', 'github-repos', digest);
}

async function discoverProviderFiles(baseDirectory: string, patterns: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const pattern of patterns) {
    const matches = await discoverPattern(baseDirectory, pattern);
    for (const filePath of matches) files.add(filePath);
  }
  return [...files].sort();
}

async function discoverPattern(baseDirectory: string, pattern: string): Promise<string[]> {
  const normalized = pattern.replaceAll('\\', '/');
  if (!normalized.includes('*')) {
    const filePath = path.resolve(baseDirectory, normalized);
    return isSafeChild(baseDirectory, filePath) && (await isReadableFile(filePath))
      ? [filePath]
      : [];
  }

  const root = path.resolve(baseDirectory, literalPrefix(normalized));
  if (!isSafeChild(baseDirectory, root)) return [];
  const candidates = await walkFiles(root);
  return candidates.filter((filePath) => matchesSimpleGlob(baseDirectory, filePath, normalized));
}

function literalPrefix(pattern: string): string {
  const index = pattern.search(/[*]/);
  const prefix = index === -1 ? pattern : pattern.slice(0, index);
  const slash = prefix.lastIndexOf('/');
  return slash === -1 ? '.' : prefix.slice(0, slash);
}

async function walkFiles(root: string): Promise<string[]> {
  const stat = await safeStat(root);
  if (!stat) return [];
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) return [];

  const results: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name === '.git') continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(entryPath)));
      continue;
    }
    if (entry.isFile()) results.push(entryPath);
  }
  return results;
}

function matchesSimpleGlob(baseDirectory: string, filePath: string, pattern: string): boolean {
  const relative = relativePath(baseDirectory, filePath);
  if (pattern.endsWith('/**/*.md')) {
    const prefix = pattern.slice(0, -'/**/*.md'.length);
    return relative.startsWith(`${prefix}/`) && relative.endsWith('.md');
  }
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -'/**'.length);
    return relative.startsWith(`${prefix}/`);
  }
  if (pattern === '**/*.md') return relative.endsWith('.md');
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -'/*'.length);
    return relative.startsWith(`${prefix}/`) && !relative.slice(prefix.length + 1).includes('/');
  }
  return relative === pattern;
}

function rankFiles(files: string[], query?: string): string[] {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) return files;
  return [...files].sort((left, right) => {
    const leftScore = left.toLowerCase().includes(normalized) ? 0 : 1;
    const rightScore = right.toLowerCase().includes(normalized) ? 0 : 1;
    return leftScore - rightScore || left.localeCompare(right);
  });
}

async function isReadableFile(filePath: string): Promise<boolean> {
  const stat = await safeStat(filePath);
  return Boolean(stat?.isFile());
}

async function safeStat(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch {
    return null;
  }
}

function isSafeChild(baseDirectory: string, candidate: string): boolean {
  const relative = path.relative(baseDirectory, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function relativePath(baseDirectory: string, filePath: string): string {
  return path.relative(baseDirectory, filePath).split(path.sep).join('/');
}

function searchSnippet(body: string, query: string): string {
  if (Buffer.byteLength(body, 'utf8') <= MAX_SEARCH_SNIPPET_BYTES) return body;

  const normalizedQuery = query.trim().toLowerCase();
  const normalizedBody = body.toLowerCase();
  const matchIndex = normalizedQuery ? normalizedBody.indexOf(normalizedQuery) : -1;
  const center = matchIndex >= 0 ? matchIndex : 0;
  const radius = Math.floor(MAX_SEARCH_SNIPPET_BYTES / 2);
  const start = Math.max(0, center - radius);
  const end = Math.min(body.length, start + MAX_SEARCH_SNIPPET_BYTES);
  const prefix = start > 0 ? '...\n' : '';
  const suffix = end < body.length ? '\n...' : '';
  let snippet = `${prefix}${body.slice(start, end).trim()}${suffix}`;

  while (Buffer.byteLength(snippet, 'utf8') > MAX_SEARCH_SNIPPET_BYTES && snippet.length > 0) {
    snippet = snippet.slice(0, -1);
  }

  return snippet;
}

function runGit(args: string[], cwd: string | undefined): Promise<{ stdout: string; stderr: string }> {
  return runCommand('git', args, cwd);
}

function runCommand(
  command: string,
  args: string[],
  cwd: string | undefined,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(' ')} failed\n${stderr || stdout}`.trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'context-update'
  );
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
