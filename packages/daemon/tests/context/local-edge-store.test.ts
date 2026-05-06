import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addContextEntry,
  archivedContextProjectPath,
  contextProjectPath,
  initContextProject,
  readContextStatus,
  resolveContextBundle,
  writeContextProfile,
} from '../../src/context/local-edge-store.js';
import {
  createProjectKey,
  digestText,
  encryptText,
  wrapProjectKey,
} from '../../src/context/local-edge-crypto.js';

describe('local trusted-edge context store', () => {
  let tempHome: string;
  const credentials = {
    passphrase: 'correct horse battery staple',
    recoveryCode: 'recovery-code-1',
  };

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-'));
  });

  afterEach(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('stores local context encrypted and resolves it only with credentials', async () => {
    await initContextProject({
      projectId: 'project-alpha',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      home: tempHome,
    });

    await addContextEntry({
      projectId: 'project-alpha',
      actorName: 'alice-laptop',
      title: 'Auth convention',
      body: 'Use policy classes for authorization checks.',
      credentials,
      home: tempHome,
    });

    const raw = await readTree(tempHome);
    expect(raw).toContain('viewport.context_event/v1');
    expect(raw).not.toContain('Auth convention');
    expect(raw).not.toContain('Use policy classes');
    expect(raw).toContain('ciphertext');

    const bundle = await resolveContextBundle({
      projectId: 'project-alpha',
      actorName: 'alice-laptop',
      query: 'authorization',
      credentials,
      home: tempHome,
    });

    expect(bundle.manifest.serverSync).toBe('disabled');
    expect(bundle.manifest.schemaVersion).toBe('viewport.context_bundle_manifest/v1');
    expect(bundle.manifest.apiVersion).toBe('viewport.context_bundle_manifest/v1');
    expect(bundle.manifest.itemCount).toBe(1);
    expect(bundle.items[0]?.body).toBe('Use policy classes for authorization checks.');

    await expect(
      resolveContextBundle({
        projectId: 'project-alpha',
        actorName: 'alice-laptop',
        query: 'authorization',
        credentials: { ...credentials, recoveryCode: 'wrong' },
        home: tempHome,
      }),
    ).rejects.toThrow();
  });

  it('reports local status without decrypting bodies', async () => {
    await initContextProject({
      projectId: 'project-alpha',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      home: tempHome,
    });

    const status = await readContextStatus({ home: tempHome });

    expect(status.projects).toEqual([
      expect.objectContaining({
        schemaVersion: 'viewport.context_event/v1',
        projectId: 'project-alpha',
        userName: 'alice',
        deviceName: 'alice-laptop',
        serverSync: 'disabled',
        entryCount: 0,
      }),
    ]);
  });

  it('migrates seam-v0 projects into canonical engine events and archives the seam file', async () => {
    const projectKey = createProjectKey();
    const createdAt = new Date().toISOString();
    const legacy = {
      schemaVersion: 'viewport.context_local_edge/seam-v0',
      projectId: 'project-alpha',
      userName: 'alice',
      deviceName: 'alice-laptop',
      serverSync: 'disabled',
      createdAt,
      updatedAt: createdAt,
      wrappedProjectKey: wrapProjectKey(projectKey, credentials),
      entries: [
        {
          id: 'ctx_legacy',
          scope: 'project',
          title: encryptText('Legacy migration rule', projectKey),
          titleDigest: digestText('Legacy migration rule'),
          body: encryptText('Seam data migrates without plaintext leakage.', projectKey),
          bodyDigest: digestText('Seam data migrates without plaintext leakage.'),
          source: 'manual://legacy',
          trustState: 'approved',
          actorName: 'alice-laptop',
          createdAt,
        },
      ],
    };
    await fs.mkdir(path.dirname(contextProjectPath('project-alpha', tempHome)), {
      recursive: true,
    });
    await fs.writeFile(
      contextProjectPath('project-alpha', tempHome),
      `${JSON.stringify(legacy)}\n`,
    );

    const bundle = await resolveContextBundle({
      projectId: 'project-alpha',
      actorName: 'alice-laptop',
      query: 'migrates',
      credentials,
      home: tempHome,
    });

    expect(bundle.manifest.schemaVersion).toBe('viewport.context_bundle_manifest/v1');
    expect(bundle.items[0]?.title).toBe('Legacy migration rule');
    await expect(
      fs.stat(archivedContextProjectPath('project-alpha', tempHome)),
    ).resolves.toBeTruthy();
    await expect(fs.stat(contextProjectPath('project-alpha', tempHome))).rejects.toThrow();

    const canonicalEvents = await readTree(path.join(tempHome, 'repos', 'project-alpha', 'events'));
    expect(canonicalEvents).toContain('viewport.context_event/v1');
    expect(canonicalEvents).not.toContain('Legacy migration rule');
    expect(canonicalEvents).not.toContain('Seam data migrates');

    const archived = await fs.readFile(
      archivedContextProjectPath('project-alpha', tempHome),
      'utf8',
    );
    expect(archived).toContain('viewport.context_local_edge/seam-v0');
    expect(archived).not.toContain('Legacy migration rule');
    expect(archived).not.toContain('Seam data migrates');
  });

  it('enforces profile registry pins when resolving canonical bundles', async () => {
    await initContextProject({
      projectId: 'project-alpha',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      home: tempHome,
    });

    await addContextEntry({
      projectId: 'project-alpha',
      actorName: 'alice-laptop',
      title: 'Auth review standard',
      body: 'Code reviews touching auth need session rotation regression proof.',
      source: 'git://api/context-profiles/code-review.json',
      credentials,
      home: tempHome,
    });
    await addContextEntry({
      projectId: 'project-alpha',
      actorName: 'alice-laptop',
      title: 'Release window',
      body: 'Deployments use the release calendar.',
      source: 'git://api/context-profiles/release.json',
      credentials,
      home: tempHome,
    });

    const profile = await writeContextProfile({
      projectId: 'project-alpha',
      name: 'code-review',
      packs: ['project-standards'],
      query: 'auth review',
      maxItems: 1,
      credentials,
      home: tempHome,
    });

    await expect(
      resolveContextBundle({
        projectId: 'project-alpha',
        actorName: 'alice-laptop',
        query: '',
        profile: 'code-review',
        profilePin: { path: profile.path, digest: 'sha256:bad' },
        credentials,
        home: tempHome,
      }),
    ).rejects.toMatchObject({ code: 'CONTEXT_PROFILE_PIN_MISMATCH' });

    const bundle = await resolveContextBundle({
      projectId: 'project-alpha',
      actorName: 'alice-laptop',
      query: '',
      profile: 'code-review',
      profilePin: { path: profile.path, digest: profile.digest },
      credentials,
      home: tempHome,
    });

    expect(bundle.items).toHaveLength(1);
    expect(bundle.items[0]?.title).toBe('Auth review standard');
    expect(bundle.manifest.engineManifest.profile).toMatchObject({
      path: profile.path,
      digest: profile.digest,
    });
  });

  it.skip('used seam-v0 as the local context record schema before the canonical engine landed', () => {
    // Historical guard for PR #43 before the canonical Context Vault engine replaced
    // the seam internals. New records must assert viewport.context_event/v1 instead.
  });

  async function readTree(dir: string): Promise<string> {
    let output = '';
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        output += await readTree(fullPath);
      } else {
        output += await fs.readFile(fullPath, 'utf8');
      }
    }
    return output;
  }
});
