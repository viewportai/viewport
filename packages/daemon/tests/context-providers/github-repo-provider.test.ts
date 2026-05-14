import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSessionResourceManifest } from '../../src/config-resolution/index.js';
import { githubRepoProviderAdapter } from '../../src/context-providers/github-repo-provider.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-github-context-provider-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('github-repo provider', () => {
  it('pulls markdown context from a git remote into a local cache', async () => {
    const { remoteUrl } = await createRemoteContextRepo();
    const productRepo = await createProductRepo(remoteUrl);
    const manifest = await resolveSessionResourceManifest({ workingDirectory: productRepo });
    const provider = manifest.contract.contextProviders[0]!;

    const results = await githubRepoProviderAdapter.search?.({
      provider,
      query: 'incidents',
      actorName: 'alice-laptop',
      home: root,
      sizeBudgetBytes: manifest.contract.contextResolution.sizeBudgetBytes,
    });

    expect(results).toBeDefined();
    expect(results).toHaveLength(1);
    expect(results![0]).toMatchObject({
      id: 'team_memory:context/runbook.md',
      provider_id: 'team_memory',
      provider: 'github-repo',
      privacy: 'third_party_terms',
      title: 'context/runbook.md',
    });
    expect(results![0]?.body).toContain('Use incident summaries when touching reliability code.');
  });

  it('proposes updates on a branch without writing to the default branch', async () => {
    const { bareRepo, remoteUrl } = await createRemoteContextRepo();
    const productRepo = await createProductRepo(remoteUrl);
    const manifest = await resolveSessionResourceManifest({ workingDirectory: productRepo });
    const provider = manifest.contract.contextProviders[0]!;

    const proposal = await githubRepoProviderAdapter.propose?.({
      provider,
      manifestDigest: manifest.manifestDigest,
      actorName: 'alice-laptop',
      title: 'Roses policy',
      body: 'When the user mentions roses, preserve the color decision in shared context.',
      sourceKind: 'workflow',
      credentials: { passphrase: '', recoveryCode: '' },
      home: root,
      source: 'manual-qa',
    });

    expect(proposal).toBeDefined();
    expect(proposal?.status).toBe('branch_pushed');
    expect(proposal?.branch).toMatch(/^viewport\/context\/roses-policy-/);
    expect(proposal?.candidate_id).toContain('github-pr:team_memory:viewport/context/roses-policy-');

    const heads = await runGit(['ls-remote', '--heads', bareRepo], undefined);
    expect(heads.stdout).toContain(`refs/heads/${proposal?.branch}`);

    const mainTree = await runGit(['--git-dir', bareRepo, 'ls-tree', '-r', '--name-only', 'main'], undefined);
    expect(mainTree.stdout).not.toContain('context/proposals');
  });
});

async function createRemoteContextRepo(): Promise<{ bareRepo: string; remoteUrl: string }> {
  const source = path.join(root, 'context-source');
  const bareRepo = path.join(root, 'context-remote.git');
  await fs.mkdir(path.join(source, 'context'), { recursive: true });
  await runGit(['init', '-b', 'main'], source);
  await runGit(['config', 'user.name', 'Viewport Test'], source);
  await runGit(['config', 'user.email', 'test@getviewport.local'], source);
  await fs.writeFile(
    path.join(source, 'context', 'runbook.md'),
    'Use incident summaries when touching reliability code.',
    'utf8',
  );
  await runGit(['add', 'context/runbook.md'], source);
  await runGit(['commit', '-m', 'docs: seed context'], source);
  await runGit(['clone', '--bare', source, bareRepo], undefined);
  return { bareRepo, remoteUrl: `file://${bareRepo}` };
}

async function createProductRepo(remoteUrl: string): Promise<string> {
  const repo = path.join(root, 'product-repo');
  await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
  await fs.writeFile(
    path.join(repo, '.viewport', 'config.yaml'),
    [
      'version: 1',
      'context:',
      '  providers:',
      '    - id: team_memory',
      '      provider: github-repo',
      '      repo: viewportai/team-memory',
      `      remote: ${JSON.stringify(remoteUrl)}`,
      '      ref: main',
      '      branch: main',
      '      paths:',
      '        - context/**/*.md',
      '  resolution:',
      '    size_budget: 64kb',
      '',
    ].join('\n'),
    'utf8',
  );
  return repo;
}

function runGit(args: string[], cwd: string | undefined): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(' ')} failed\n${stderr || stdout}`.trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
