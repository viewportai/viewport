import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { WorkflowGitPublishNode, WorkflowRunRecord } from './types.js';
import {
  allowedRepositories,
  workflowAuthorityContract,
  workflowAuthorityContractDigest,
  type WorkflowAuthorityDenial,
} from './workflow-authority-contract.js';
import { cleanChildProcessEnv } from '../security/child-env.js';

export interface RenderedGitPublishInput {
  cwd: string;
  branch: string;
  message: string;
}

export interface GitPublishResult {
  repository: string;
  branch: string;
  commit: string;
  pushed: boolean;
  changed: boolean;
  credentialMode: 'runner_local' | 'run_scoped_grant';
  credentialRef: string | null;
}

export interface GitPublishCredentialMaterial {
  envName: string;
  secret?: string;
}

export async function gitPublishAuthorityDenial(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowGitPublishNode,
  input: RenderedGitPublishInput,
): Promise<WorkflowAuthorityDenial | null> {
  const contract = workflowAuthorityContract(run);
  if (!contract) return null;

  const repository = normalizeRepository(node.repository);
  const allowed = allowedRepositories(run);
  if (allowed.length > 0 && !allowed.includes(repository)) {
    return {
      schema: 'viewport.workflow_authority_denial/v1',
      reason: 'repository_not_allowed',
      runId: run.id,
      nodeId,
      repository,
      detail: `Git publish node references repository ${repository}, which is outside workflow repo authority.`,
      contractDigest: workflowAuthorityContractDigest(run),
      allowed,
    };
  }

  if (!isPathWithin(input.cwd, run.directoryPath)) {
    return {
      schema: 'viewport.workflow_authority_denial/v1',
      reason: 'git_publish_path_outside_worktree',
      runId: run.id,
      nodeId,
      repository,
      detail: 'Git publish cwd is outside the run worktree.',
      contractDigest: workflowAuthorityContractDigest(run),
      allowed,
    };
  }

  if ((node.credentialMode ?? 'runner_local') === 'run_scoped_grant') {
    if (node.credentialRef) return null;

    return {
      schema: 'viewport.workflow_authority_denial/v1',
      reason: 'git_publish_run_scoped_grant_unavailable',
      runId: run.id,
      nodeId,
      repository,
      detail: 'Git publish run-scoped grant mode requires credentialRef.',
      contractDigest: workflowAuthorityContractDigest(run),
      allowed,
    };
  }

  const remote = (await git(['remote', 'get-url', 'origin'], input.cwd)).trim();
  const remoteRepository = repositoryFromRemote(remote);
  if (remoteRepository && remoteRepository !== repository) {
    return {
      schema: 'viewport.workflow_authority_denial/v1',
      reason: 'git_publish_remote_mismatch',
      runId: run.id,
      nodeId,
      repository: remoteRepository,
      detail: `Git publish remote references repository ${remoteRepository}, but the node declares ${repository}.`,
      contractDigest: workflowAuthorityContractDigest(run),
      allowed: [repository],
    };
  }

  return null;
}

export async function executeGitPublishNode(
  node: WorkflowGitPublishNode,
  input: RenderedGitPublishInput,
  credential?: GitPublishCredentialMaterial,
): Promise<GitPublishResult> {
  const repository = normalizeRepository(node.repository);
  const credentialMode = node.credentialMode ?? 'runner_local';
  if (credentialMode === 'run_scoped_grant' && !credential?.secret) {
    throw new Error(
      `Run-scoped git publish grant ${node.credentialRef ?? '(missing credentialRef)'} was not materialized for this run.`,
    );
  }
  const credentialEnv = credential?.secret
    ? await gitCredentialEnv(input.cwd, credential.secret)
    : undefined;
  await git(['config', 'user.email', 'viewport-runner@example.invalid'], input.cwd);
  await git(['config', 'user.name', 'Viewport Runner'], input.cwd);
  await git(['checkout', '-B', input.branch], input.cwd);
  await git(['add', ...(node.paths && node.paths.length > 0 ? node.paths : ['-A'])], input.cwd);

  const changed = (await git(['status', '--porcelain'], input.cwd)).trim().length > 0;
  if (changed || node.allowEmpty === true) {
    await git(['commit', ...(node.allowEmpty === true && !changed ? ['--allow-empty'] : []), '-m', input.message], input.cwd);
  }
  const commit = (await git(['rev-parse', 'HEAD'], input.cwd)).trim();
  const shouldPush = node.push !== false;
  if (shouldPush) {
    await git(['push', 'origin', `HEAD:${input.branch}`], input.cwd, credentialEnv);
  }

  return {
    repository,
    branch: input.branch,
    commit,
    pushed: shouldPush,
    changed,
    credentialMode,
    credentialRef: node.credentialRef ?? null,
  };
}

async function gitCredentialEnv(root: string, secret: string): Promise<NodeJS.ProcessEnv> {
  const directory = path.join(root, '.viewport', 'credential-helpers');
  await fs.mkdir(directory, { recursive: true });
  const helperPath = path.join(directory, `git-askpass-${Date.now()}-${Math.random().toString(16).slice(2)}.sh`);
  const script = [
    '#!/bin/sh',
    'case "$1" in',
    '  *Username*) printf "%s\\n" "x-access-token" ;;',
    '  *) printf "%s\\n" "$VIEWPORT_GIT_TOKEN" ;;',
    'esac',
    '',
  ].join('\n');
  await fs.writeFile(helperPath, script, { mode: 0o700 });

  return {
    ...cleanChildProcessEnv(),
    GIT_ASKPASS: helperPath,
    GIT_TERMINAL_PROMPT: '0',
    VIEWPORT_GIT_TOKEN: secret,
    DISPLAY: process.env['DISPLAY'] ?? ':0',
    TMPDIR: process.env['TMPDIR'] ?? os.tmpdir(),
  };
}

function repositoryFromRemote(remote: string | undefined): string | null {
  if (!remote) return null;
  const github = remote.match(/(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?/i);
  return github ? normalizeRepository(github[1]) : null;
}

function normalizeRepository(value: string | undefined): string {
  if (!value) return '';
  return value
    .trim()
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = cleanChildProcessEnv(),
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(detail || `git ${args[0] ?? 'command'} failed with ${code}`));
    });
  });
}
