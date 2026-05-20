import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getArgs, getFlag, hasFlag } from './args.js';
import { isJsonMode, printJson } from './command-shared.js';

interface TeamResourceBundleFile {
  path: string;
  bytes?: number;
  sha256: string;
  content: string;
}

interface TeamResourceBundle {
  bundle_digest?: string;
  repository_url?: string;
  default_branch?: string;
  files?: TeamResourceBundleFile[];
}

interface TeamResourceApiTarget {
  server: string;
  workspaceId: string;
  executorId: string;
  credential: string;
  resourceId: string;
}

interface GitResult {
  stdout: string;
  stderr: string;
}
export async function teamResource(): Promise<void> {
  const subcommand = getArgs()[1];
  if (!subcommand) {
    showTeamResourceHelp();
    return;
  }
  if (subcommand === 'sync') {
    await syncTeamResource();
    return;
  }
  throw new Error(teamResourceUsage());
}

function teamResourceUsage(): string {
  return [
    'Usage: vpd team-resource <command>',
    '',
    'Commands:',
    '  sync --bundle <file> --repo <path> [--commit-message <message>] [--push] [--branch <name>] [--no-commit] [--json]',
  ].join('\n');
}

function showTeamResourceHelp(): void {
  console.log(teamResourceUsage());
}

async function syncTeamResource(): Promise<void> {
  const bundlePath = getFlag('bundle');
  const repoPath = getFlag('repo');
  const apiTarget = resolveApiTarget();
  if ((!bundlePath && !apiTarget) || !repoPath) {
    throw new Error(
      'Usage: vpd team-resource sync --bundle <file> --repo <path> [--commit-message <message>] [--push] [--branch <name>] [--no-commit] [--json]\n       vpd team-resource sync --server <url> --workspace <id> --executor <id> --credential <token> --resource <team-resource-id> --repo <path> [--push] [--json]',
    );
  }

  const repo = path.resolve(repoPath);
  const bundle = bundlePath ? await readBundle(bundlePath) : await fetchBundle(apiTarget!);
  const files = normalizeBundleFiles(bundle);

  await assertGitRepository(repo);
  await writeBundleFiles(repo, files);

  const writtenPaths = files.map((file) => file.path);
  let commit: Record<string, unknown> = {
    created: false,
    status: 'skipped',
  };

  if (!hasFlag('no-commit')) {
    commit = await commitBundleFiles(
      repo,
      writtenPaths,
      getFlag('commit-message') ?? 'Viewport Team Resource sync',
    );
  }
  const branch =
    getFlag('branch') ?? bundle.default_branch ?? (await currentBranch(repo).catch(() => 'main'));
  const push =
    hasFlag('push') && typeof commit.sha === 'string' ? await pushCommit(repo, branch) : null;
  const apiReport =
    apiTarget && typeof commit.sha === 'string'
      ? await reportSync(apiTarget, bundle, files, commit.sha, {
          branch,
          pushed: push !== null,
        })
      : null;

  const output = {
    schema_version: 'viewport.team_resource_sync/v1',
    command: 'team-resource sync',
    ok: true,
    repo,
    bundle_digest: bundle.bundle_digest ?? digestFiles(files),
    files: files.map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.content),
      sha256: file.sha256,
    })),
    commit,
    push,
    api_report: apiReport,
  };

  if (isJsonMode()) {
    printJson(output);
    return;
  }

  console.log(`Synced ${files.length} Team Resource file(s) to ${repo}.`);
  if (commit.created) {
    console.log(`Commit: ${commit.sha}`);
  }
}

function resolveApiTarget(): TeamResourceApiTarget | null {
  const server =
    getFlag('server') ?? process.env['VIEWPORT_SERVER_URL'] ?? process.env['VPD_SERVER_URL'];
  const workspaceId =
    getFlag('workspace') ?? getFlag('resource-workspace') ?? process.env['VIEWPORT_WORKSPACE_ID'];
  const executorId = getFlag('executor') ?? process.env['VIEWPORT_MANAGED_EXECUTOR_ID'];
  const credential =
    getFlag('credential') ??
    process.env['VIEWPORT_MANAGED_EXECUTOR_TOKEN'] ??
    process.env['VPD_MANAGED_EXECUTOR_TOKEN'];
  const resourceId = getFlag('resource') ?? process.env['VIEWPORT_TEAM_RESOURCE_ID'];

  if (!server && !workspaceId && !executorId && !credential && !resourceId) {
    return null;
  }
  if (!server || !workspaceId || !executorId || !credential || !resourceId) {
    throw new Error(
      'Remote Team Resource sync requires --server, --workspace, --executor, --credential, and --resource.',
    );
  }

  return {
    server: server.replace(/\/+$/, ''),
    workspaceId,
    executorId,
    credential,
    resourceId,
  };
}

async function readBundle(bundlePath: string): Promise<TeamResourceBundle> {
  const raw = await fs.readFile(path.resolve(bundlePath), 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Team Resource bundle must be a JSON object.');
  }

  return parsed as TeamResourceBundle;
}

async function fetchBundle(target: TeamResourceApiTarget): Promise<TeamResourceBundle> {
  const response = await fetchJson<{ data?: TeamResourceBundle }>(
    `${apiBase(target.server)}/runtime/workspaces/${encodeURIComponent(
      target.workspaceId,
    )}/managed-executors/${encodeURIComponent(
      target.executorId,
    )}/team-resources/${encodeURIComponent(target.resourceId)}/export-bundle`,
    {
      method: 'GET',
      token: target.credential,
    },
  );

  if (!response.data) {
    throw new Error('Team Resource export bundle response did not include data.');
  }

  return response.data;
}

async function reportSync(
  target: TeamResourceApiTarget,
  bundle: TeamResourceBundle,
  files: TeamResourceBundleFile[],
  commitSha: string,
  options: { branch: string; pushed: boolean },
): Promise<Record<string, unknown>> {
  const response = await fetchJson<{ data?: { sync_status?: unknown; metadata?: unknown } }>(
    `${apiBase(target.server)}/runtime/workspaces/${encodeURIComponent(
      target.workspaceId,
    )}/managed-executors/${encodeURIComponent(
      target.executorId,
    )}/team-resources/${encodeURIComponent(target.resourceId)}/sync-report`,
    {
      method: 'PATCH',
      token: target.credential,
      body: {
        bundle_digest: bundle.bundle_digest ?? digestFiles(files),
        commit_sha: commitSha,
        branch: options.branch,
        status: options.pushed ? 'pushed' : 'synced',
        pushed: options.pushed,
        remote_url: bundle.repository_url ?? null,
        files: files.map((file) => ({
          path: file.path,
          sha256: file.sha256,
        })),
      },
    },
  );

  return {
    reported: true,
    sync_status: response.data?.sync_status ?? null,
  };
}

async function fetchJson<T>(
  url: string,
  options: { method: string; token: string; body?: Record<string, unknown> },
): Promise<T> {
  const response = await fetch(url, {
    method: options.method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${options.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Team Resource API request failed: ${response.status} ${body}`);
  }

  return (await response.json()) as T;
}

function apiBase(server: string): string {
  return server.endsWith('/api') ? server : `${server}/api`;
}

function normalizeBundleFiles(bundle: TeamResourceBundle): TeamResourceBundleFile[] {
  if (!Array.isArray(bundle.files) || bundle.files.length === 0) {
    throw new Error('Team Resource bundle must include at least one file.');
  }

  return bundle.files.map((file, index) => {
    if (!file || typeof file !== 'object') {
      throw new Error(`Invalid Team Resource bundle file at index ${index}.`);
    }
    const safePath = normalizeBundlePath(file.path);
    if (typeof file.content !== 'string') {
      throw new Error(`Team Resource bundle file ${safePath} is missing string content.`);
    }
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw new Error(`Team Resource bundle file ${safePath} has an invalid sha256.`);
    }
    const actual = createHash('sha256').update(file.content).digest('hex');
    if (actual !== file.sha256.toLowerCase()) {
      throw new Error(`Team Resource bundle file ${safePath} failed sha256 verification.`);
    }
    return {
      path: safePath,
      sha256: actual,
      content: file.content,
      ...(typeof file.bytes === 'number' ? { bytes: file.bytes } : {}),
    };
  });
}

function normalizeBundlePath(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Team Resource bundle file path is required.');
  }
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  if (
    path.isAbsolute(value) ||
    segments.some((segment) => segment === '..') ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`Unsafe Team Resource bundle path: ${value}`);
  }
  if (!normalized.startsWith('.viewport/')) {
    throw new Error(`Team Resource bundle path must stay under .viewport/: ${value}`);
  }
  return normalized;
}

async function assertGitRepository(repo: string): Promise<void> {
  const stat = await fs.stat(path.join(repo, '.git')).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Team Resource sync target is not a git repository: ${repo}`);
  }
}

async function writeBundleFiles(repo: string, files: TeamResourceBundleFile[]): Promise<void> {
  for (const file of files) {
    const absolute = path.resolve(repo, file.path);
    if (!absolute.startsWith(repo + path.sep)) {
      throw new Error(`Unsafe Team Resource bundle path: ${file.path}`);
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, file.content, 'utf8');
  }
}

async function commitBundleFiles(
  repo: string,
  files: string[],
  message: string,
): Promise<Record<string, unknown>> {
  await git(repo, ['add', '--', ...files]);
  const status = await git(repo, ['status', '--porcelain', '--', ...files]);
  if (status.stdout.trim() === '') {
    const head = await git(repo, ['rev-parse', '--verify', 'HEAD']).catch(() => null);
    return {
      created: false,
      status: 'unchanged',
      ...(head?.stdout.trim() ? { sha: head.stdout.trim() } : {}),
    };
  }

  await git(repo, [
    '-c',
    'user.name=Viewport Worker',
    '-c',
    'user.email=worker@getviewport.dev',
    'commit',
    '-m',
    message,
    '--',
    ...files,
  ]);
  const head = await git(repo, ['rev-parse', 'HEAD']);

  return {
    created: true,
    status: 'committed',
    sha: head.stdout.trim(),
  };
}

async function currentBranch(repo: string): Promise<string> {
  const branch = await git(repo, ['branch', '--show-current']);
  const value = branch.stdout.trim();
  return value || 'main';
}

async function pushCommit(repo: string, branch: string): Promise<Record<string, unknown>> {
  await git(repo, ['push', 'origin', `HEAD:${branch}`]);

  return {
    pushed: true,
    remote: 'origin',
    branch,
  };
}

function digestFiles(files: TeamResourceBundleFile[]): string {
  const material = files.map((file) => `${file.path}:${file.sha256}`).join('\n');
  return `sha256:${createHash('sha256').update(material).digest('hex')}`;
}

function git(repo: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`git ${args.join(' ')} failed: ${stderr || stdout || code}`));
    });
  });
}
