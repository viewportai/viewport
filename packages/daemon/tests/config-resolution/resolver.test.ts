import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveSessionResourceManifest,
  resolveSessionResourceManifestSync,
} from '../../src/config-resolution/resolver.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-config-resolution-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('viewport config resolver', () => {
  it('resolves a single repo config into a session resource manifest', async () => {
    const repo = await makeRepo('viewport', {
      name: 'viewport-daemon',
      resources: {
        contexts: ['ctx_viewport_architecture'],
        workflows: [{ id: 'wf_daemon_pr_review', required: true }],
      },
    });

    const manifest = await resolveSessionResourceManifest({
      workingDirectory: path.join(repo, 'packages', 'daemon'),
    });

    expect(manifest.schema).toBe('viewport.session_resource_manifest/v1');
    expect(manifest.configSources).toHaveLength(1);
    expect(manifest.configSources[0]?.path).toBe(path.join(repo, '.viewport', 'config.json'));
    expect(manifest.resources.contexts.map((resource) => resource.id)).toEqual([
      'ctx_viewport_architecture',
    ]);
    expect(manifest.resources.workflows).toMatchObject([
      { id: 'wf_daemon_pr_review', required: true },
    ]);
    expect(manifest.conflicts).toEqual([]);
    expect(manifest.manifestDigest).toMatch(/^sha256:/);
  });

  it('merges additive resources from multiple child repo configs', async () => {
    await makeRepo('repo-a', {
      resources: {
        contexts: ['ctx_a'],
        workflows: ['wf_shared'],
      },
    });
    await makeRepo('repo-b', {
      resources: {
        contexts: ['ctx_b'],
        workflows: ['wf_shared'],
      },
    });

    const manifest = resolveSessionResourceManifestSync({ workingDirectory: root });

    expect(manifest.resources.contexts.map((resource) => resource.id)).toEqual(['ctx_a', 'ctx_b']);
    expect(manifest.resources.workflows.map((resource) => resource.id)).toEqual(['wf_shared']);
    expect(manifest.warnings.map((warning) => warning.code)).toContain('multiple_configs_found');
  });

  it('does not let daemon-local config shadow child repo resource configs', async () => {
    await fs.mkdir(path.join(root, '.viewport'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.viewport', 'config.json'),
      JSON.stringify({ daemon: { profile: 'local' } }, null, 2),
    );
    await makeRepo('repo-a', {
      resources: {
        contexts: ['ctx_a'],
      },
    });

    const manifest = resolveSessionResourceManifestSync({ workingDirectory: root });

    expect(manifest.configSources.map((source) => source.path)).toEqual([
      path.join(root, 'repo-a', '.viewport', 'config.json'),
    ]);
    expect(manifest.resources.contexts.map((resource) => resource.id)).toEqual(['ctx_a']);
  });

  it('records conflicting defaults without silently choosing', async () => {
    await makeRepo('repo-a', {
      defaults: { inboxRoute: 'team_engineering' },
      resources: { contexts: ['ctx_a'] },
    });
    await makeRepo('repo-b', {
      defaults: { inboxRoute: 'team_marketing' },
      resources: { contexts: ['ctx_b'] },
    });

    const manifest = resolveSessionResourceManifestSync({ workingDirectory: root });

    expect(manifest.conflicts).toEqual([
      {
        field: 'defaults.inboxRoute',
        resolution: 'requires_user_selection',
        values: expect.arrayContaining([
          expect.objectContaining({ value: 'team_engineering' }),
          expect.objectContaining({ value: 'team_marketing' }),
        ]),
      },
    ]);
  });

  it('returns an unconfigured manifest when no config exists', async () => {
    const manifest = resolveSessionResourceManifestSync({ workingDirectory: root });

    expect(manifest.configSources).toEqual([]);
    expect(manifest.resources.contexts).toEqual([]);
    expect(manifest.warnings).toEqual([
      expect.objectContaining({
        code: 'no_config_found',
      }),
    ]);
  });
});

async function makeRepo(name: string, config: Record<string, unknown>): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(path.join(repo, '.viewport'), { recursive: true });
  await fs.mkdir(path.join(repo, 'packages', 'daemon'), { recursive: true });
  await fs.writeFile(
    path.join(repo, '.viewport', 'config.json'),
    JSON.stringify(
      {
        $schema: 'https://getviewport.dev/schemas/viewport-config-v1.json',
        version: 1,
        ...config,
      },
      null,
      2,
    ),
  );
  return repo;
}
