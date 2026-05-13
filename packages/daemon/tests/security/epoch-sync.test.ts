import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureTeamCryptoEpoch,
  ensureUserCryptoEpoch,
  rotateTeamCryptoEpoch,
  rotateUserCryptoEpoch,
} from '../../src/security/epoch-sync.js';
import { getActiveLocalTeamEpoch, getActiveLocalUserEpoch } from '../../src/security/epoch-store.js';
import { epochFingerprint } from '../../src/security/epoch-protocol.js';

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

  it('rotates a user epoch with signed continuity and keeps private material local', async () => {
    const home = await tempHome();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      requests.push({ url, body });
      expect(JSON.stringify(body)).not.toContain('private');
      expect(JSON.stringify(body)).not.toContain('"d"');
      expect(JSON.stringify(body)).not.toContain('"k"');
      const epoch = Number(body.epoch);
      const fingerprint = epochFingerprint({
        schema: 'viewport.user_crypto_epoch/v1',
        workspaceId: 'workspace-1',
        subjectType: 'user',
        subjectId: '42',
        epoch,
        encryptionPublicKeyJwk: body.encryption_public_key_jwk as never,
        signingPublicKeyJwk: body.signing_public_key_jwk as never,
        previousEpochFingerprint: (body.previous_epoch_fingerprint as string | undefined) ?? null,
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
    });

    await ensureUserCryptoEpoch({
      target: { workspaceId: 'workspace-1', serverUrl: 'https://api.test', credential: 'issue-token' },
      home,
      fetchImpl: fetchImpl as never,
    });
    const rotated = await rotateUserCryptoEpoch({
      target: { workspaceId: 'workspace-1', serverUrl: 'https://api.test', credential: 'issue-token' },
      reason: 'device_revoked',
      home,
      fetchImpl: fetchImpl as never,
    });

    expect(rotated.epoch).toBe(2);
    const fromFingerprint = String(requests[1]?.body.previous_epoch_fingerprint);
    expect(rotated.previousEpochFingerprint).toBe(fromFingerprint);
    expect(requests[1]?.body).toMatchObject({
      credential: 'issue-token',
      epoch: 2,
      previous_epoch_fingerprint: fromFingerprint,
      continuity: {
        payload: expect.objectContaining({
          reason: 'device_revoked',
          fromEpoch: 1,
          toEpoch: 2,
          fromEpochFingerprint: fromFingerprint,
          toEpochFingerprint: expect.any(String),
        }),
        signature: expect.any(String),
        signed_by_epoch_fingerprint: fromFingerprint,
      },
    });
    const active = await getActiveLocalUserEpoch('workspace-1', home);
    expect(active?.epoch).toBe(2);
    expect(active?.encryptionPrivateKeyJwk).toMatchObject({ d: expect.any(String) });
  });

  it('generates private team epoch material locally and publishes public material only', async () => {
    const home = await tempHome();
    const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
      expect(url).toBe('https://api.test/api/runtime/workspaces/workspace-1/crypto/teams/team_public_1/epochs');
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain('private');
      expect(JSON.stringify(body)).not.toContain('"d"');
      expect(JSON.stringify(body)).not.toContain('"k"');
      return responseJson({
        ok: true,
        data: {
          id: 'team-epoch-1',
          workspace_id: 'workspace-1',
          team_id: 77,
          epoch: 1,
          schema: 'viewport.team_crypto_epoch/v1',
          status: 'active',
          fingerprint: 'sha256:team-epoch-fingerprint',
          encryption_public_key_jwk: body.encryption_public_key_jwk,
          signing_public_key_jwk: body.signing_public_key_jwk,
          previous_epoch_fingerprint: null,
        },
      });
    });

    const epoch = await ensureTeamCryptoEpoch({
      target: {
        workspaceId: 'workspace-1',
        serverUrl: 'https://api.test',
        credential: 'issue-token',
      },
      teamId: 'team_public_1',
      home,
      fetchImpl: fetchImpl as never,
    });

    expect(epoch.fingerprint).toBe('sha256:team-epoch-fingerprint');
    expect(epoch.teamId).toBe('team_public_1');
    expect(epoch.platformTeamId).toBe('77');

    const stored = await getActiveLocalTeamEpoch('workspace-1', 'team_public_1', home);
    expect(stored?.encryptionPrivateKeyJwk).toMatchObject({ d: expect.any(String) });
    expect(stored?.signingPrivateKeyJwk).toMatchObject({ d: expect.any(String) });
  });

  it('reuses an active local team epoch without publishing again', async () => {
    const home = await tempHome();
    const fetchImpl = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return responseJson({
        ok: true,
        data: {
          id: 'team-epoch-1',
          workspace_id: 'workspace-1',
          team_id: 77,
          epoch: 1,
          schema: 'viewport.team_crypto_epoch/v1',
          status: 'active',
          fingerprint: 'sha256:team-epoch-fingerprint',
          encryption_public_key_jwk: body.encryption_public_key_jwk,
          signing_public_key_jwk: body.signing_public_key_jwk,
          previous_epoch_fingerprint: null,
        },
      });
    });

    await ensureTeamCryptoEpoch({
      target: { workspaceId: 'workspace-1', serverUrl: 'https://api.test', credential: 'issue-token' },
      teamId: 'team_public_1',
      home,
      fetchImpl: fetchImpl as never,
    });
    await ensureTeamCryptoEpoch({
      target: { workspaceId: 'workspace-1', serverUrl: 'https://api.test', credential: 'issue-token' },
      teamId: 'team_public_1',
      home,
      fetchImpl: fetchImpl as never,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rotates a team epoch with signed continuity for member revocation', async () => {
    const home = await tempHome();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      requests.push({ url, body });
      const epoch = Number(body.epoch);
      const fingerprint = epochFingerprint({
        schema: 'viewport.team_crypto_epoch/v1',
        workspaceId: 'workspace-1',
        subjectType: 'team',
        subjectId: '77',
        epoch,
        encryptionPublicKeyJwk: body.encryption_public_key_jwk as never,
        signingPublicKeyJwk: body.signing_public_key_jwk as never,
        previousEpochFingerprint: (body.previous_epoch_fingerprint as string | undefined) ?? null,
        createdAt: 'server-fixture',
      });
      return responseJson({
        ok: true,
        data: {
          id: `team-epoch-${epoch}`,
          workspace_id: 'workspace-1',
          team_id: 77,
          epoch,
          schema: 'viewport.team_crypto_epoch/v1',
          status: 'active',
          fingerprint,
          encryption_public_key_jwk: body.encryption_public_key_jwk,
          signing_public_key_jwk: body.signing_public_key_jwk,
          previous_epoch_fingerprint: body.previous_epoch_fingerprint ?? null,
        },
      });
    });

    await ensureTeamCryptoEpoch({
      target: { workspaceId: 'workspace-1', serverUrl: 'https://api.test', credential: 'issue-token' },
      teamId: 'team_public_1',
      home,
      fetchImpl: fetchImpl as never,
    });
    const rotated = await rotateTeamCryptoEpoch({
      target: { workspaceId: 'workspace-1', serverUrl: 'https://api.test', credential: 'issue-token' },
      teamId: 'team_public_1',
      reason: 'member_revoked',
      home,
      fetchImpl: fetchImpl as never,
    });

    expect(rotated.epoch).toBe(2);
    const fromTeamFingerprint = String(requests[1]?.body.previous_epoch_fingerprint);
    expect(rotated.previousEpochFingerprint).toBe(fromTeamFingerprint);
    expect(requests[1]?.url).toBe('https://api.test/api/runtime/workspaces/workspace-1/crypto/teams/team_public_1/epochs');
    expect(requests[1]?.body).toMatchObject({
      credential: 'issue-token',
      epoch: 2,
      previous_epoch_fingerprint: fromTeamFingerprint,
      continuity: {
        payload: expect.objectContaining({
          reason: 'member_revoked',
          fromEpoch: 1,
          toEpoch: 2,
          fromEpochFingerprint: fromTeamFingerprint,
        }),
        signature: expect.any(String),
        signed_by_epoch_fingerprint: fromTeamFingerprint,
      },
    });
    const active = await getActiveLocalTeamEpoch('workspace-1', 'team_public_1', home);
    expect(active?.epoch).toBe(2);
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
