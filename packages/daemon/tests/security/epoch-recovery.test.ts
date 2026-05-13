import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createUserEpochRecoveryBackup,
  generateUserEpochRecoveryKey,
  restoreUserEpochFromRecoveryBackup,
} from '../../src/security/epoch-recovery.js';
import {
  createLocalUserEpochKeyMaterial,
  getActiveLocalUserEpoch,
  upsertLocalUserEpoch,
} from '../../src/security/epoch-store.js';
import { epochFingerprint } from '../../src/security/epoch-protocol.js';

const tmpDirs: string[] = [];

describe('user epoch recovery backups', () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('stores only encrypted user epoch backup material on the platform', async () => {
    const home = await tempHome();
    await seedUserEpoch(home);
    let storedBackup: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(
      async (url: string, init?: { method?: string; body?: string; headers?: unknown }) => {
        expectCryptoProtocolHeader(init?.headers);
        expect(url).toBe(
          'https://api.test/api/runtime/workspaces/workspace-1/crypto/user-key-backups',
        );
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(body).toMatchObject({
          credential: 'issue-token',
          schema: 'viewport.user_epoch_recovery_backup/v1',
          user_crypto_epoch_id: 'user-epoch-1',
          kdf: 'scrypt-sha256/v1',
        });
        expect(JSON.stringify(body)).not.toContain('encryptionPrivateKeyJwk');
        expect(JSON.stringify(body)).not.toContain('signingPrivateKeyJwk');
        expect(JSON.stringify(body)).not.toContain('"d"');
        storedBackup = backupResponseData('backup-1', body);
        return responseJson({ ok: true, data: storedBackup }, 201);
      },
    );

    const backup = await createUserEpochRecoveryBackup({
      target: target(),
      recoveryKey: generateUserEpochRecoveryKey(),
      home,
      fetchImpl: fetchImpl as never,
    });

    expect(backup.id).toBe('backup-1');
    expect(backup.encrypted_payload.ciphertext).toEqual(expect.any(String));
    expect(storedBackup).not.toBeNull();
  });

  it('restores a user epoch locally and immediately rotates after recovery', async () => {
    const sourceHome = await tempHome();
    const restoreHome = await tempHome();
    await seedUserEpoch(sourceHome);
    const recoveryKey = generateUserEpochRecoveryKey();
    let latestBackup: Record<string, unknown> | null = null;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(
      async (url: string, init?: { method?: string; body?: string; headers?: unknown }) => {
        expectCryptoProtocolHeader(init?.headers);
        if (init?.method === 'POST' && url.endsWith('/crypto/user-key-backups')) {
          const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          requests.push({ url, body });
          expect(JSON.stringify(body)).not.toContain('encryptionPrivateKeyJwk');
          latestBackup = backupResponseData(`backup-${requests.length}`, body);
          return responseJson({ ok: true, data: latestBackup }, 201);
        }
        if (init?.method === 'GET' && url.includes('/crypto/user-key-backups/latest')) {
          return responseJson({ ok: true, data: latestBackup });
        }
        if (init?.method === 'POST' && url.endsWith('/crypto/user-epochs')) {
          const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          requests.push({ url, body });
          const epoch = Number(body.epoch);
          const fingerprint = epochFingerprint({
            schema: 'viewport.user_crypto_epoch/v1',
            workspaceId: 'workspace-1',
            subjectType: 'user',
            subjectId: '42',
            epoch,
            encryptionPublicKeyJwk: body.encryption_public_key_jwk as never,
            signingPublicKeyJwk: body.signing_public_key_jwk as never,
            previousEpochFingerprint:
              (body.previous_epoch_fingerprint as string | undefined) ?? null,
            createdAt: 'server-fixture',
          });
          return responseJson({
            ok: true,
            data: {
              id: `user-epoch-${epoch}`,
              workspace_id: 'workspace-1',
              user_id: 42,
              epoch,
              schema: 'viewport.user_crypto_epoch/v1',
              status: 'active',
              fingerprint,
              encryption_public_key_jwk: body.encryption_public_key_jwk,
              signing_public_key_jwk: body.signing_public_key_jwk,
              previous_epoch_fingerprint: body.previous_epoch_fingerprint ?? null,
            },
          });
        }
        throw new Error(`Unexpected recovery request: ${init?.method ?? 'GET'} ${url}`);
      },
    );

    await createUserEpochRecoveryBackup({
      target: target(),
      recoveryKey,
      home: sourceHome,
      fetchImpl: fetchImpl as never,
    });

    await expect(
      restoreUserEpochFromRecoveryBackup({
        target: target(),
        recoveryKey: 'vprk_wrong',
        home: restoreHome,
        fetchImpl: fetchImpl as never,
      }),
    ).rejects.toThrow();

    const result = await restoreUserEpochFromRecoveryBackup({
      target: target(),
      recoveryKey,
      home: restoreHome,
      fetchImpl: fetchImpl as never,
    });

    expect(result.restoredEpoch.epoch).toBe(1);
    expect(result.rotatedEpoch.epoch).toBe(2);
    expect(result.rotatedEpoch.previousEpochFingerprint).toBe(result.restoredEpoch.fingerprint);
    expect(result.rotatedBackup.user_crypto_epoch_id).toBe('user-epoch-2');
    const active = await getActiveLocalUserEpoch('workspace-1', restoreHome);
    expect(active?.epoch).toBe(2);
    expect(active?.encryptionPrivateKeyJwk).toMatchObject({ d: expect.any(String) });
    expect(
      requests.some(
        (request) =>
          request.url.endsWith('/crypto/user-epochs') &&
          request.body.continuity &&
          (request.body.continuity as { payload?: { reason?: string } }).payload?.reason ===
            'recovery',
      ),
    ).toBe(true);
  });
});

async function seedUserEpoch(home: string): Promise<void> {
  const material = createLocalUserEpochKeyMaterial({
    workspaceId: 'workspace-1',
    userId: '42',
    epoch: 1,
  });
  await upsertLocalUserEpoch(
    {
      workspaceId: 'workspace-1',
      userId: '42',
      platformEpochId: 'user-epoch-1',
      epoch: 1,
      schema: 'viewport.user_crypto_epoch/v1',
      status: 'active',
      encryptionPublicKeyJwk: material.descriptor.encryptionPublicKeyJwk,
      encryptionPrivateKeyJwk: material.encryptionPrivateKeyJwk,
      signingPublicKeyJwk: material.descriptor.signingPublicKeyJwk,
      signingPrivateKeyJwk: material.signingPrivateKeyJwk,
      fingerprint: epochFingerprint(material.descriptor),
      previousEpochFingerprint: null,
    },
    home,
  );
}

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-epoch-recovery-'));
  tmpDirs.push(dir);
  return dir;
}

function target() {
  return {
    workspaceId: 'workspace-1',
    serverUrl: 'https://api.test',
    credential: 'issue-token',
  };
}

function backupResponseData(
  id: string,
  requestBody: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    workspace_id: 'workspace-1',
    user_id: 42,
    user_crypto_epoch_id: requestBody.user_crypto_epoch_id,
    schema: requestBody.schema,
    status: 'active',
    kdf: requestBody.kdf,
    kdf_params: requestBody.kdf_params,
    encrypted_payload: requestBody.encrypted_payload,
    created_at: new Date().toISOString(),
  };
}

function responseJson(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    json: async () => payload,
  } as Response;
}

function expectCryptoProtocolHeader(headers: unknown): void {
  expect(headers).toMatchObject({
    'X-Viewport-Crypto-Protocol': 'viewport.trusted_edge_crypto/v2',
  });
}
