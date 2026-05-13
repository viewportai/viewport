import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureUserCryptoEpoch } from '../../src/security/epoch-sync.js';
import { getActiveLocalUserEpoch } from '../../src/security/epoch-store.js';

const tmpDirs: string[] = [];

describe('epoch sync', () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('generates private user epoch material locally and publishes public material only', async () => {
    const home = await tempHome();
    const fetchImpl = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain('private');
      expect(JSON.stringify(body)).not.toContain('"d"');
      expect(JSON.stringify(body)).not.toContain('"k"');
      return responseJson({
        ok: true,
        data: {
          id: 'epoch-1',
          workspace_id: 'workspace-1',
          user_id: 42,
          epoch: 1,
          schema: 'viewport.user_crypto_epoch/v1',
          status: 'active',
          fingerprint: 'sha256:epoch-fingerprint',
          encryption_public_key_jwk: body.encryption_public_key_jwk,
          signing_public_key_jwk: body.signing_public_key_jwk,
          previous_epoch_fingerprint: null,
        },
      });
    });

    const epoch = await ensureUserCryptoEpoch({
      target: {
        workspaceId: 'workspace-1',
        serverUrl: 'https://api.test',
        credential: 'issue-token',
      },
      home,
      fetchImpl: fetchImpl as never,
    });

    expect(epoch.fingerprint).toBe('sha256:epoch-fingerprint');
    expect(epoch.userId).toBe('42');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const stored = await getActiveLocalUserEpoch('workspace-1', home);
    expect(stored?.encryptionPrivateKeyJwk).toMatchObject({ d: expect.any(String) });
    expect(stored?.signingPrivateKeyJwk).toMatchObject({ d: expect.any(String) });
  });

  it('reuses an active local epoch without publishing again', async () => {
    const home = await tempHome();
    const fetchImpl = vi.fn(async () =>
      responseJson({
        ok: true,
        data: {
          id: 'epoch-1',
          workspace_id: 'workspace-1',
          user_id: 42,
          epoch: 1,
          schema: 'viewport.user_crypto_epoch/v1',
          status: 'active',
          fingerprint: 'sha256:epoch-fingerprint',
          encryption_public_key_jwk: { kty: 'OKP', crv: 'X25519', x: 'public-x' },
          signing_public_key_jwk: { kty: 'OKP', crv: 'Ed25519', x: 'public-signing' },
          previous_epoch_fingerprint: null,
        },
      }),
    );

    await ensureUserCryptoEpoch({
      target: { workspaceId: 'workspace-1', serverUrl: 'https://api.test', credential: 'issue-token' },
      home,
      fetchImpl: fetchImpl as never,
    });
    await ensureUserCryptoEpoch({
      target: { workspaceId: 'workspace-1', serverUrl: 'https://api.test', credential: 'issue-token' },
      home,
      fetchImpl: fetchImpl as never,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-epoch-sync-'));
  tmpDirs.push(dir);
  return dir;
}

function responseJson(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payload,
  } as Response;
}
