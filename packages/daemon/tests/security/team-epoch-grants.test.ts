import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalTeamEpochKeyMaterial,
  createLocalUserEpochKeyMaterial,
  getActiveLocalTeamEpoch,
  upsertLocalTeamEpoch,
  upsertLocalUserEpoch,
} from '../../src/security/epoch-store.js';
import {
  acceptTeamEpochMemberGrants,
  grantTeamEpochToUserEpoch,
} from '../../src/security/team-epoch-grants.js';
import { epochFingerprint } from '../../src/security/epoch-protocol.js';

const tmpDirs: string[] = [];

describe('team epoch member grants', () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('wraps team epoch material to a recipient user epoch and materializes it locally', async () => {
    const teamOwnerHome = await tempHome();
    const recipientHome = await tempHome();
    const teamMaterial = createLocalTeamEpochKeyMaterial({
      workspaceId: 'workspace-1',
      teamId: 'team-public-1',
      epoch: 1,
    });
    await upsertLocalTeamEpoch(
      {
        workspaceId: 'workspace-1',
        teamId: 'team-public-1',
        platformTeamId: 'team-db-1',
        platformEpochId: 'team-epoch-platform-1',
        epoch: 1,
        schema: 'viewport.team_crypto_epoch/v1',
        status: 'active',
        encryptionPublicKeyJwk: teamMaterial.descriptor.encryptionPublicKeyJwk,
        encryptionPrivateKeyJwk: teamMaterial.encryptionPrivateKeyJwk,
        signingPublicKeyJwk: teamMaterial.descriptor.signingPublicKeyJwk,
        signingPrivateKeyJwk: teamMaterial.signingPrivateKeyJwk,
        fingerprint: 'sha256:team-epoch',
        previousEpochFingerprint: null,
      },
      teamOwnerHome,
    );
    const userMaterial = createLocalUserEpochKeyMaterial({
      workspaceId: 'workspace-1',
      userId: '42',
      epoch: 1,
    });
    await upsertLocalUserEpoch(
      {
        workspaceId: 'workspace-1',
        userId: '42',
        platformEpochId: 'user-epoch-platform-1',
        epoch: 1,
        schema: 'viewport.user_crypto_epoch/v1',
        status: 'active',
        encryptionPublicKeyJwk: userMaterial.descriptor.encryptionPublicKeyJwk,
        encryptionPrivateKeyJwk: userMaterial.encryptionPrivateKeyJwk,
        signingPublicKeyJwk: userMaterial.descriptor.signingPublicKeyJwk,
        signingPrivateKeyJwk: userMaterial.signingPrivateKeyJwk,
        fingerprint: epochFingerprint(userMaterial.descriptor),
        previousEpochFingerprint: null,
      },
      recipientHome,
    );

    let grantPayload: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(
      async (url: string, init?: { method?: string; body?: string; headers?: unknown }) => {
        expectCryptoProtocolHeader(init?.headers);
        if (init?.method === 'GET' && url.includes('/crypto/epochs')) {
          return responseJson({
            data: {
              user_epochs: [
                {
                  id: 'user-epoch-platform-1',
                  workspace_id: 'workspace-1',
                  user_id: 42,
                  epoch: 1,
                  fingerprint: epochFingerprint(userMaterial.descriptor),
                  encryption_public_key_jwk: userMaterial.descriptor.encryptionPublicKeyJwk,
                  signing_public_key_jwk: userMaterial.descriptor.signingPublicKeyJwk,
                  previous_epoch_fingerprint: null,
                },
              ],
              team_epochs: [],
            },
          });
        }

        if (
          init?.method === 'POST' &&
          url.endsWith('/crypto/team-epochs/team-epoch-platform-1/member-grants')
        ) {
          const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          expect(body.recipient_user_crypto_epoch_id).toBe('user-epoch-platform-1');
          expect(JSON.stringify(body)).not.toContain('encryptionPrivateKeyJwk');
          expect(JSON.stringify(body)).not.toContain('signingPrivateKeyJwk');
          grantPayload = {
            id: 'team-grant-1',
            team_crypto_epoch_id: 'team-epoch-platform-1',
            recipient_user_crypto_epoch_id: 'user-epoch-platform-1',
            aad: body.aad,
            encrypted_payload: body.encrypted_payload,
          };
          return responseJson({ ok: true, data: grantPayload });
        }

        if (init?.method === 'GET' && url.includes('/crypto/team-epoch-member-grants')) {
          return responseJson({ data: grantPayload ? [grantPayload] : [] });
        }

        if (
          init?.method === 'POST' &&
          url.endsWith('/crypto/team-epoch-member-grants/team-grant-1/materialized')
        ) {
          const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
          expect(body.receipt).toMatchObject({
            payload: {
              schema: 'viewport.team_epoch_member_materialization/v1',
              workspaceId: 'workspace-1',
              grantId: 'team-grant-1',
              teamCryptoEpochId: 'team-epoch-platform-1',
              teamEpochFingerprint: 'sha256:team-epoch',
              recipientUserCryptoEpochId: 'user-epoch-platform-1',
              recipientUserEpochFingerprint: epochFingerprint(userMaterial.descriptor),
            },
            signature: expect.any(String),
            signedByTeamEpochFingerprint: 'sha256:team-epoch',
          });
          return responseJson({ ok: true, data: grantPayload });
        }

        throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
      },
    );

    const target = {
      workspaceId: 'workspace-1',
      serverUrl: 'https://api.test',
      credential: 'issue-token',
    };
    await grantTeamEpochToUserEpoch({
      target,
      teamCryptoEpochId: 'team-epoch-platform-1',
      recipientUserCryptoEpochId: 'user-epoch-platform-1',
      home: teamOwnerHome,
      fetchImpl: fetchImpl as never,
    });
    const result = await acceptTeamEpochMemberGrants({
      target,
      home: recipientHome,
      fetchImpl: fetchImpl as never,
    });

    expect(result.accepted).toBe(1);
    expect(
      (await getActiveLocalTeamEpoch('workspace-1', 'team-public-1', recipientHome))
        ?.platformEpochId,
    ).toBe('team-epoch-platform-1');
  });
});

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-team-epoch-grants-'));
  tmpDirs.push(dir);
  return dir;
}

function responseJson(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => payload,
  } as Response;
}

function expectCryptoProtocolHeader(headers: unknown): void {
  expect(headers).toMatchObject({
    'X-Viewport-Crypto-Protocol': 'viewport.trusted_edge_crypto/v2',
  });
}
