import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ViewportContextProviderRef } from '../config-resolution/index.js';

const DEFAULT_SIZE_BUDGET_BYTES = 100 * 1024;
const MAX_DOCS_PER_PROVIDER = 50;

export interface RepoDocsContextItem {
  id: string;
  title: string;
  body: string;
  providerId: string;
  providerKind: 'repo-docs';
  privacy: 'local_only';
  sourcePath: string;
  digest: string;
}

export async function resolveRepoDocsProvider(options: {
  provider: ViewportContextProviderRef;
  query?: string;
  sizeBudgetBytes?: number;
}): Promise<RepoDocsContextItem[]> {
  if (options.provider.provider !== 'repo-docs') return [];
  const baseDirectory = repoRootForConfig(options.provider.sourceConfigPath);
  const budget = options.sizeBudgetBytes ?? DEFAULT_SIZE_BUDGET_BYTES;
  const files = await discoverProviderFiles(baseDirectory, options.provider.paths ?? []);
  const ranked = rankFiles(files, options.query);
  const items: RepoDocsContextItem[] = [];
  let usedBytes = 0;

  for (const filePath of ranked) {
    if (items.length >= MAX_DOCS_PER_PROVIDER) break;
    const stat = await safeStat(filePath);
    if (!stat || stat.size <= 0 || stat.size > budget || usedBytes + stat.size > budget) continue;
    const raw = await fs.readFile(filePath, 'utf8');
    usedBytes += Buffer.byteLength(raw, 'utf8');
    items.push({
      id: `${options.provider.id}:${relativePath(baseDirectory, filePath)}`,
      title: relativePath(baseDirectory, filePath),
      body: raw.trim(),
      providerId: options.provider.id,
      providerKind: 'repo-docs',
      privacy: 'local_only',
      sourcePath: filePath,
      digest: `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`,
    });
  }

  return items;
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
    if (entry.isSymbolicLink()) continue;
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

function repoRootForConfig(configPath: string): string {
  const configDirectory = path.dirname(configPath);
  if (path.basename(configDirectory) === '.viewport') {
    return path.dirname(configDirectory);
  }
  return configDirectory;
}
