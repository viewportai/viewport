import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { WorkflowCheckoutNode, WorkflowRunRecord } from './types.js';
import {
  allowedRepositories,
  workflowAuthorityContract,
  workflowAuthorityContractDigest,
  type WorkflowAuthorityDenial,
} from './workflow-authority-contract.js';
import { cleanChildProcessEnv } from '../security/child-env.js';

export interface CheckoutResult {
  repository: string;
  remote: string;
  path: string;
  sourceCategory: 'operating_repo';
  readWriteMode: 'read_write';
  ref: string | null;
  branch: string | null;
  commit: string;
  credentialMode: 'runner_local' | 'run_scoped_grant';
  credentialRef: string | null;
}

export interface CheckoutCredentialMaterial {
  envName: string;
  secret?: string;
}

export function checkoutAuthorityDenial(
  run: WorkflowRunRecord,
  nodeId: string,
  node: WorkflowCheckoutNode,
): WorkflowAuthorityDenial | null {
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
      detail: `Checkout node references repository ${repository}, which is outside workflow repo authority.`,
      contractDigest: workflowAuthorityContractDigest(run),
      allowed,
    };
  }

  if (node.path && !isPathWithin(path.resolve(run.directoryPath, node.path), run.directoryPath)) {
    return {
      schema: 'viewport.workflow_authority_denial/v1',
      reason: 'checkout_path_outside_run_worktree',
      runId: run.id,
      nodeId,
      repository,
      detail: `Checkout path ${node.path} is outside the run worktree.`,
      contractDigest: workflowAuthorityContractDigest(run),
      allowed,
    };
  }

  const remoteRepository = repositoryFromRemote(node.remote);
  if (remoteRepository && remoteRepository !== repository) {
    return {
      schema: 'viewport.workflow_authority_denial/v1',
      reason: 'repository_not_allowed',
      runId: run.id,
      nodeId,
      repository: remoteRepository,
      detail: `Checkout remote references repository ${remoteRepository}, but the node declares ${repository}.`,
      contractDigest: workflowAuthorityContractDigest(run),
      allowed: [repository],
    };
  }

  return null;
}

export async function executeCheckoutNode(
  run: WorkflowRunRecord,
  node: WorkflowCheckoutNode,
  credential?: CheckoutCredentialMaterial,
): Promise<CheckoutResult> {
  const repository = normalizeRepository(node.repository);
  if (!repository) {
    throw new Error('Checkout node repository is required.');
  }
  const credentialMode = node.credentialMode ?? 'runner_local';
  if (credentialMode === 'run_scoped_grant' && !credential?.secret) {
    throw new Error(
      `Run-scoped checkout grant ${node.credentialRef ?? '(missing credentialRef)'} was not materialized for this run.`,
    );
  }

  const destination = checkoutDestination(run.directoryPath, run.id, repository, node.path);
  await fs.mkdir(path.dirname(destination), { recursive: true });

  const remote = node.remote ?? `https://github.com/${repository}.git`;
  const credentialEnv = credential?.secret
    ? await checkoutCredentialEnv(run.directoryPath, credential.secret)
    : nonInteractiveGitEnv();
  if (await existingGitWorktree(destination)) {
    await git(['remote', 'set-url', 'origin', remote], destination, credentialEnv).catch(
      () => undefined,
    );
  } else {
    await git(['clone', remote, destination], run.directoryPath, credentialEnv, 45_000);
  }

  if (node.ref) {
    await git(['checkout', node.ref], destination);
  }
  if (node.branch) {
    await git(['checkout', '-B', node.branch], destination);
  }

  const commit = (await git(['rev-parse', 'HEAD'], destination)).trim();

  return {
    repository,
    remote: redactedRemote(remote),
    path: destination,
    sourceCategory: 'operating_repo',
    readWriteMode: 'read_write',
    ref: node.ref ?? null,
    branch: node.branch ?? null,
    commit,
    credentialMode,
    credentialRef: node.credentialRef ?? null,
  };
}

async function existingGitWorktree(destination: string): Promise<boolean> {
  try {
    await fs.access(path.join(destination, '.git'));
    await git(['rev-parse', '--is-inside-work-tree'], destination);
    return true;
  } catch {
    return false;
  }
}

function checkoutDestination(
  root: string,
  runId: string,
  repository: string,
  configuredPath?: string,
): string {
  const safeRepo = repository.replace(/[^a-z0-9_.-]+/gi, '__');
  const safeRun = runId.replace(/[^a-z0-9_.-]+/gi, '__');
  const candidate = configuredPath
    ? path.resolve(root, configuredPath)
    : path.join(root, '.viewport', 'workspace', 'runs', safeRun, 'repos', 'operating', safeRepo);
  if (!isPathWithin(candidate, root)) {
    throw new Error('Checkout path is outside the run worktree.');
  }

  return candidate;
}

function repositoryFromRemote(remote: string | undefined): string | null {
  if (!remote) return null;
  const github = remote.match(
    /(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?/i,
  );
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

function redactedRemote(remote: string): string {
  return remote
    .replace(/(https:\/\/)([^/@]+)@github\.com\//i, '$1[redacted]@github.com/')
    .replace(/(gh[ps]_[A-Za-z0-9_]+)/g, '[redacted-token]');
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function checkoutCredentialEnv(_root: string, secret: string): Promise<NodeJS.ProcessEnv> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-git-askpass-'));
  const helperPath = path.join(
    directory,
    `git-askpass-${Date.now()}-${Math.random().toString(16).slice(2)}.sh`,
  );
  const script = [
    '#!/bin/sh',
    'case "$1" in',
    '  *Username*) printf "%s\\n" "x-access-token" ;;',
    '  *) printf "%s\\n" "$VIEWPORT_GIT_TOKEN" ;;',
    'esac',
    '',
  ].join('\n');
  await fs.writeFile(helperPath, script, { mode: 0o700 });

  return nonInteractiveGitEnv({
    GIT_ASKPASS: helperPath,
    VIEWPORT_GIT_TOKEN: secret,
  });
}

function nonInteractiveGitEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return cleanChildProcessEnv({
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    // Some git builds ignore GIT_ASKPASS without DISPLAY/SSH_ASKPASS on macOS.
    DISPLAY: process.env['DISPLAY'] ?? ':0',
    TMPDIR: process.env['TMPDIR'] ?? os.tmpdir(),
    ...overrides,
  });
}

async function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = nonInteractiveGitEnv(),
  timeoutMs = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      reject(new Error(`git ${args[0] ?? 'command'} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(detail || `git ${args[0] ?? 'command'} failed with ${code}`));
    });
  });
}
