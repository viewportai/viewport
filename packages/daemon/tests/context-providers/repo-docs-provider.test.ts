import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSessionResourceManifest } from '../../src/config-resolution/index.js';
import { resolveRepoDocsProvider } from '../../src/context-providers/repo-docs-provider.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-repo-docs-provider-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('repo-docs provider', () => {
  it('resolves declared markdown files under the config directory only', async () => {
    const repo = path.join(root, 'repo');
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
    await fs.writeFile(path.join(repo, 'docs', 'runbook.md'), 'Run session rotation tests.');
    await fs.writeFile(path.join(repo, 'docs', 'notes.txt'), 'ignore me');
    await fs.writeFile(path.join(root, 'outside.md'), 'outside');
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: repo_docs',
        '      provider: repo-docs',
        '      paths:',
        '        - docs/**/*.md',
        '        - ../outside.md',
        '',
      ].join('\n'),
    );

    const manifest = await resolveSessionResourceManifest({ workingDirectory: repo });
    const provider = manifest.contract.contextProviders[0];

    expect(provider).toBeDefined();
    const items = await resolveRepoDocsProvider({ provider: provider!, query: 'rotation' });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'docs/runbook.md',
      providerId: 'repo_docs',
      providerKind: 'repo-docs',
      privacy: 'local_only',
      body: 'Run session rotation tests.',
    });
    expect(items[0]?.digest).toMatch(/^sha256:/);
  });

  it('respects the manifest size budget', async () => {
    const repo = path.join(root, 'repo');
    await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
    await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
    await fs.writeFile(path.join(repo, 'docs', 'large.md'), 'a'.repeat(2048));
    await fs.writeFile(path.join(repo, 'docs', 'small.md'), 'small note');
    await fs.writeFile(
      path.join(repo, '.viewport', 'config.yaml'),
      [
        'version: 1',
        'context:',
        '  providers:',
        '    - id: repo_docs',
        '      provider: repo-docs',
        '      paths:',
        '        - docs/**/*.md',
        '  resolution:',
        '    size_budget: 1kb',
        '',
      ].join('\n'),
    );

    const manifest = await resolveSessionResourceManifest({ workingDirectory: repo });
    const items = await resolveRepoDocsProvider({
      provider: manifest.contract.contextProviders[0]!,
      sizeBudgetBytes: manifest.contract.contextResolution.sizeBudgetBytes,
    });

    expect(items.map((item) => item.title)).toEqual(['docs/small.md']);
  });
});
