import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceptDeviceEpochEnrollment,
  approveDeviceEpochEnrollment,
  requestDeviceEpochEnrollment,
} from '../../src/security/epoch-enrollment.js';
import {
  createLocalUserEpochKeyMaterial,
  getActiveLocalUserEpoch,
  upsertLocalUserEpoch,
} from '../../src/security/epoch-store.js';

const tmpDirs: string[] = [];

describe('epoch device enrollment', () => {
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('requests, approves, and accepts a device epoch grant without sending private material to the server', async () => {
    const existingDeviceHome = await tempHome();
    const newDeviceHome = await tempHome();
    const userEpochMaterial = createLocalUserEpochKeyMaterial({
      workspaceId: 'workspace-1',
      userId: '42',
      epoch: 1,
    });
    await upsertLocalUserEpoch(
      {
        workspaceId: 'workspace-1',
        userId: '42',
        platformEpochId: 'epoch-platform-1',
        epoch: 1,
        schema: 'viewport.user_crypto_epoch/v1',
        status: 'active',
        encryptionPublicKeyJwk: userEpochMaterial.descriptor.encryptionPublicKeyJwk,
        encryptionPrivateKeyJwk: userEpochMaterial.encryptionPrivateKeyJwk,
        signingPublicKeyJwk: userEpochMaterial.descriptor.signingPublicKeyJwk,
        signingPrivateKeyJwk: userEpochMaterial.signingPrivateKeyJwk,
        fingerprint: 'sha256:user-epoch',
        previousEpochFingerprint: null,
      },
      existingDeviceHome,
    );

    let enrollmentPublicKeys: Record<string, unknown> | null = null;
    let approvedGrant: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST' && url.endsWith('/crypto/device-enrollments')) {
        const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        expect(JSON.stringify(body)).not.toContain('"d"');
        enrollmentPublicKeys = body;
        return responseJson({
          ok: true,
          data: {
            id: 'enroll-1',
            workspace_id: 'workspace-1',
            user_id: 42,
            device_id: body.device_id,
            device_label: body.device_label,
            encryption_public_key_jwk: body.encryption_public_key_jwk,
            signing_public_key_jwk: body.signing_public_key_jwk,
            fingerprint: 'sha256:enrollment',
            nonce: body.nonce,
            status: 'pending',
            grants: [],
          },
        }, 201);
      }

      if (init?.method === 'GET' && url.includes('/crypto/device-enrollments/enroll-1')) {
        return responseJson({
          data: {
            id: 'enroll-1',
            workspace_id: 'workspace-1',
            user_id: 42,
            device_id: 'new-vps',
            device_label: 'New VPS',
            encryption_public_key_jwk: enrollmentPublicKeys?.encryption_public_key_jwk,
            signing_public_key_jwk: enrollmentPublicKeys?.signing_public_key_jwk,
            fingerprint: 'sha256:enrollment',
            nonce: enrollmentPublicKeys?.nonce,
            status: approvedGrant ? 'approved' : 'pending',
            grants: approvedGrant ? [approvedGrant] : [],
          },
        });
      }

      if (init?.method === 'POST' && url.endsWith('/crypto/device-enrollments/enroll-1/approve')) {
        const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        expect(body.user_crypto_epoch_id).toBe('epoch-platform-1');
        expect(JSON.stringify(body)).not.toContain('user-epoch-secret');
        expect(JSON.stringify(body)).not.toContain('encryptionPrivateKeyJwk');
        approvedGrant = {
          id: 'grant-1',
          user_crypto_epoch_id: body.user_crypto_epoch_id,
          recipient_fingerprint: 'sha256:enrollment',
          aad: body.aad,
          encrypted_payload: body.encrypted_payload,
        };
        return responseJson({
          ok: true,
          data: {
            id: 'enroll-1',
            workspace_id: 'workspace-1',
            user_id: 42,
            device_id: 'new-vps',
            device_label: 'New VPS',
            encryption_public_key_jwk: enrollmentPublicKeys?.encryption_public_key_jwk,
            signing_public_key_jwk: enrollmentPublicKeys?.signing_public_key_jwk,
            fingerprint: 'sha256:enrollment',
            nonce: enrollmentPublicKeys?.nonce,
            status: 'approved',
            grants: [approvedGrant],
          },
          grant: approvedGrant,
        });
      }

      if (init?.method === 'POST' && url.endsWith('/crypto/device-enrollments/enroll-1/materialized')) {
        const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        expect(body.grant_id).toBe('grant-1');
        return responseJson({
          ok: true,
          data: {
            id: 'enroll-1',
            workspace_id: 'workspace-1',
            user_id: 42,
            device_id: 'new-vps',
            device_label: 'New VPS',
            encryption_public_key_jwk: enrollmentPublicKeys?.encryption_public_key_jwk,
            signing_public_key_jwk: enrollmentPublicKeys?.signing_public_key_jwk,
            fingerprint: 'sha256:enrollment',
            nonce: enrollmentPublicKeys?.nonce,
            status: 'accepted',
            grants: [approvedGrant],
          },
        });
      }

      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });

    const target = {
      workspaceId: 'workspace-1',
      serverUrl: 'https://api.test',
      credential: 'issue-token',
    };
    const enrollment = await requestDeviceEpochEnrollment({
      target,
      deviceId: 'new-vps',
      deviceLabel: 'New VPS',
      home: newDeviceHome,
      fetchImpl: fetchImpl as never,
    });
    expect(enrollment.enrollmentId).toBe('enroll-1');

    await approveDeviceEpochEnrollment({
      target,
      enrollmentId: 'enroll-1',
      home: existingDeviceHome,
      fetchImpl: fetchImpl as never,
    });
    const acceptedEpoch = await acceptDeviceEpochEnrollment({
      target,
      enrollmentId: 'enroll-1',
      home: newDeviceHome,
      fetchImpl: fetchImpl as never,
    });

    expect(acceptedEpoch.fingerprint).toBe('sha256:user-epoch');
    expect((await getActiveLocalUserEpoch('workspace-1', newDeviceHome))?.platformEpochId).toBe(
      'epoch-platform-1',
    );
  });
});

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewport-epoch-enrollment-'));
  tmpDirs.push(dir);
  return dir;
}

function responseJson(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 201 ? 'Created' : 'OK',
    json: async () => payload,
  } as Response;
}
