import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addContextEntry,
  contextProjectPath,
  initContextProject,
  readContextStatus,
  resolveContextBundle,
} from '../../src/context/local-edge-store.js';

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

    const raw = await fs.readFile(contextProjectPath('project-alpha', tempHome), 'utf8');
    expect(raw).toContain('viewport.context_local_edge/seam-v0');
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
        schemaVersion: 'viewport.context_local_edge/seam-v0',
        projectId: 'project-alpha',
        userName: 'alice',
        deviceName: 'alice-laptop',
        serverSync: 'disabled',
        entryCount: 0,
      }),
    ]);
  });
});
