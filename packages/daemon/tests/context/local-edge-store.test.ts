import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addContextEntry,
  acceptContextDeviceApproval,
  approveContextDeviceRequest,
  createContextDeviceRequest,
  exportContextIdentity,
  importContextIdentity,
  initContextResource,
  joinContextResource,
  readContextStatus,
  resolveContextBundle,
  writeContextProfile,
} from '../../src/context/local-edge-store.js';
import { proposeContextEntry } from '../../src/context/local-edge-candidates.js';
import {
  processPendingContextGrants,
  processPendingContextRevocations,
  pullContextEvents,
  pushContextEvents,
} from '../../src/context/local-edge-sync.js';
import { contextMetadataPath } from '../../src/context/local-edge-paths.js';
import {
  createLocalUserEpochKeyMaterial,
  createLocalTeamEpochKeyMaterial,
  upsertLocalUserEpoch,
  upsertLocalTeamEpoch,
} from '../../src/security/epoch-store.js';
import {
  TRUSTED_EDGE_CRYPTO_PROTOCOL_HEADER,
  TRUSTED_EDGE_CRYPTO_PROTOCOL_VERSION,
  epochFingerprint,
} from '../../src/security/epoch-protocol.js';

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

  it('stores local context encrypted and resolves it with credentials or an approved device', async () => {
    await initContextResource({
      contextResourceId: 'context-alpha',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      keyStore: 'file',
      home: tempHome,
    });

    await addContextEntry({
      contextResourceId: 'context-alpha',
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
      contextResourceId: 'context-alpha',
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
        contextResourceId: 'context-alpha',
        actorName: 'alice-laptop',
        query: 'authorization',
        home: tempHome,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ items: expect.arrayContaining([bundle.items[0]]) }),
    );

    await expect(
      resolveContextBundle({
        contextResourceId: 'context-alpha',
        actorName: 'alice-desktop',
        query: 'authorization',
        credentials: { ...credentials, recoveryCode: 'wrong' },
        home: tempHome,
      }),
    ).rejects.toThrow();
  });

  it('reports local status without decrypting bodies', async () => {
    await initContextResource({
      contextResourceId: 'context-alpha',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      keyStore: 'file',
      home: tempHome,
    });

    const status = await readContextStatus({ home: tempHome });
    await expect(
      fs.access(contextMetadataPath('context-alpha', tempHome)),
    ).resolves.toBeUndefined();

    expect(status.contexts).toEqual([
      expect.objectContaining({
        schemaVersion: 'viewport.context_event/v1',
        contextResourceId: 'context-alpha',
        userName: 'alice',
        deviceName: 'alice-laptop',
        serverSync: 'disabled',
        entryCount: 0,
      }),
    ]);
  });

  it('enforces profile registry pins when resolving canonical bundles', async () => {
    await initContextResource({
      contextResourceId: 'context-alpha',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      keyStore: 'file',
      home: tempHome,
    });

    await addContextEntry({
      contextResourceId: 'context-alpha',
      actorName: 'alice-laptop',
      title: 'Auth review standard',
      body: 'Code reviews touching auth need session rotation regression proof.',
      source: 'git://api/context-profiles/code-review.json',
      credentials,
      home: tempHome,
    });
    await addContextEntry({
      contextResourceId: 'context-alpha',
      actorName: 'alice-laptop',
      title: 'Release window',
      body: 'Deployments use the release calendar.',
      source: 'git://api/context-profiles/release.json',
      credentials,
      home: tempHome,
    });

    const profile = await writeContextProfile({
      contextResourceId: 'context-alpha',
      name: 'code-review',
      packs: ['project-standards'],
      query: 'auth review',
      maxItems: 1,
      credentials,
      home: tempHome,
    });

    await expect(
      resolveContextBundle({
        contextResourceId: 'context-alpha',
        actorName: 'alice-laptop',
        query: '',
        profile: 'code-review',
        profilePin: { path: profile.path, digest: 'sha256:bad' },
        credentials,
        home: tempHome,
      }),
    ).rejects.toMatchObject({ code: 'CONTEXT_PROFILE_PIN_MISMATCH' });

    const bundle = await resolveContextBundle({
      contextResourceId: 'context-alpha',
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

  it('pushes and pulls only canonical encrypted events through the platform sync API', async () => {
    await initContextResource({
      contextResourceId: 'context-alpha',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      keyStore: 'file',
      home: tempHome,
    });
    await addContextEntry({
      contextResourceId: 'context-alpha',
      actorName: 'alice-laptop',
      title: 'Sync policy',
      body: 'Context sync must never send plaintext.',
      credentials,
      home: tempHome,
    });

    let pushedEvents: unknown[] = [];
    const pullBodies: Array<Record<string, unknown>> = [];
    const protocolHeaders: Array<string | null> = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      protocolHeaders.push(headerValue(init?.headers, TRUSTED_EDGE_CRYPTO_PROTOCOL_HEADER));
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (String(url).endsWith('/push')) {
        pushedEvents = body.events;
        expect(JSON.stringify(pushedEvents)).toContain('viewport.context_event/v1');
        expect(JSON.stringify(pushedEvents)).not.toContain(
          'Context sync must never send plaintext.',
        );
        return jsonResponse({ ok: true, accepted: pushedEvents.length, events: [] }, 202);
      }

      pullBodies.push(body);
      return jsonResponse({
        data: body.after_received_at
          ? []
          : pushedEvents.map((event, index) => ({
              id: index + 1,
              received_at: `2026-05-06T21:00:0${index}.000Z`,
              signed_event: event,
            })),
      });
    };

    const push = await pushContextEvents({
      contextResourceId: 'context-alpha',
      serverUrl: 'https://app.getviewport.test',
      credential: 'runtime-token',
      fetchImpl,
      home: tempHome,
    });

    expect(push.accepted).toBeGreaterThan(0);
    expect(push.pushed).toBe(push.accepted);

    const pull = await pullContextEvents({
      contextResourceId: 'context-alpha',
      serverUrl: 'https://app.getviewport.test',
      credential: 'runtime-token',
      actorName: 'alice-laptop',
      credentials,
      fetchImpl,
      home: tempHome,
    });

    expect(pull.pulled).toBe(push.pushed);
    expect(pull.imported).toBe(0);

    const secondPull = await pullContextEvents({
      contextResourceId: 'context-alpha',
      serverUrl: 'https://app.getviewport.test',
      credential: 'runtime-token',
      actorName: 'alice-laptop',
      credentials,
      fetchImpl,
      home: tempHome,
    });

    expect(secondPull.pulled).toBe(0);
    expect(protocolHeaders).toEqual([
      TRUSTED_EDGE_CRYPTO_PROTOCOL_VERSION,
      TRUSTED_EDGE_CRYPTO_PROTOCOL_VERSION,
      TRUSTED_EDGE_CRYPTO_PROTOCOL_VERSION,
    ]);
    expect(pullBodies[0]).not.toHaveProperty('after_received_at');
    expect(pullBodies[1]).toMatchObject({
      after_received_at: `2026-05-06T21:00:0${pushedEvents.length - 1}.000Z`,
    });
  });

  it('emits pending workspace crypto grants to recipient user epochs', async () => {
    const bobHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-bob-'));
    try {
      await initContextResource({
        contextResourceId: 'context-alpha',
        userName: 'alice',
        deviceName: 'alice-laptop',
        credentials,
        keyStore: 'file',
        home: tempHome,
      });
      await addContextEntry({
        contextResourceId: 'context-alpha',
        actorName: 'alice-laptop',
        title: 'Initial shared context',
        body: 'Tenant routing migrations require a rollback runbook.',
        credentials,
        home: tempHome,
      });
      await initContextResource({
        contextResourceId: 'bob-bootstrap',
        userName: 'bob',
        deviceName: 'bob-vps',
        credentials: {
          passphrase: 'bob-passphrase',
          recoveryCode: 'bob-recovery',
        },
        keyStore: 'file',
        home: bobHome,
      });

      const bobUserEpochMaterial = createLocalUserEpochKeyMaterial({
        workspaceId: 'workspace-alpha',
        userId: 'bob-user-1',
        epoch: 1,
      });
      const bobUserEpochFingerprint = epochFingerprint(bobUserEpochMaterial.descriptor);
      await upsertLocalUserEpoch(
        {
          workspaceId: 'workspace-alpha',
          userId: 'bob-user-1',
          platformEpochId: 'user_epoch_bob_1',
          epoch: 1,
          schema: 'viewport.user_crypto_epoch/v1',
          status: 'active',
          encryptionPublicKeyJwk: bobUserEpochMaterial.descriptor.encryptionPublicKeyJwk,
          encryptionPrivateKeyJwk: bobUserEpochMaterial.encryptionPrivateKeyJwk,
          signingPublicKeyJwk: bobUserEpochMaterial.descriptor.signingPublicKeyJwk,
          signingPrivateKeyJwk: bobUserEpochMaterial.signingPrivateKeyJwk,
          fingerprint: bobUserEpochFingerprint,
          previousEpochFingerprint: null,
        },
        bobHome,
      );
      const aliceLaptopIdentity = exportContextIdentity({ name: 'alice-laptop', home: tempHome });
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      let pushedGrantEvents: unknown[] = [];

      const result = await processPendingContextGrants({
        contextResourceId: 'context-alpha',
        workspaceId: 'workspace-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'alice-laptop',
        credentials,
        home: tempHome,
        fetchImpl: async (url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          calls.push({ url: String(url), body });

          if (String(url).endsWith('/grants/pending')) {
            return jsonResponse({
              grants: [
                {
                  id: 'cvcg_pending_1',
                  context_resource_id: 'context-alpha',
                  recipient_identity: null,
                  user_epoch: {
                    id: 'user_epoch_bob_1',
                    user_id: 'bob-user-1',
                    epoch: 1,
                    fingerprint: bobUserEpochFingerprint,
                    encryption_public_key_jwk:
                      bobUserEpochMaterial.descriptor.encryptionPublicKeyJwk,
                    signing_public_key_jwk: bobUserEpochMaterial.descriptor.signingPublicKeyJwk,
                  },
                },
              ],
            });
          }

          if (String(url).endsWith('/events/push')) {
            const payload = String(init?.body ?? '');
            expect(payload).toContain('member.granted');
            expect(payload).toContain('user-epoch:user_epoch_bob_1');
            expect(payload).toContain('ciphertext');
            expect(payload).not.toContain('bob-passphrase');
            expect(payload).not.toContain('correct horse battery staple');
            pushedGrantEvents = Array.isArray(body.events) ? body.events : [];
            return jsonResponse({
              ok: true,
              accepted: Array.isArray(body.events) ? body.events.length : 0,
            });
          }

          if (String(url).endsWith('/grants/mark-emitted')) {
            expect(body).toMatchObject({
              credential: 'runtime-token',
              crypto_grant_id: 'cvcg_pending_1',
            });
            expect(typeof body.grant_event_id).toBe('string');
            expect(typeof body.key_epoch).toBe('number');
            return jsonResponse({ ok: true });
          }

          throw new Error(`Unexpected grant sync URL: ${String(url)}`);
        },
      });

      expect(result).toEqual({
        emitted: 1,
        missingIdentity: 0,
        pushed: expect.any(Number),
      });
      expect(result.pushed).toBeGreaterThan(0);
      expect(calls.map((call) => call.url)).toEqual([
        'https://app.getviewport.test/api/runtime/workspaces/workspace-alpha/context-vault/grants/pending',
        'https://app.getviewport.test/api/runtime/workspaces/workspace-alpha/context-vault/events/push',
        'https://app.getviewport.test/api/runtime/workspaces/workspace-alpha/context-vault/grants/mark-emitted',
      ]);

      await joinContextResource({
        contextResourceId: 'context-alpha',
        userName: 'bob',
        deviceName: 'bob-vps',
        credentials: {
          passphrase: 'bob-passphrase',
          recoveryCode: 'bob-recovery',
        },
        keyStore: 'file',
        home: bobHome,
      });

      const pull = await pullContextEvents({
        contextResourceId: 'context-alpha',
        workspaceId: 'workspace-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'bob-vps',
        credentials: {
          passphrase: 'bob-passphrase',
          recoveryCode: 'bob-recovery',
        },
        home: bobHome,
        fetchImpl: async (url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          if (String(url).endsWith('/events/pull')) {
            return jsonResponse({
              data: pushedGrantEvents.map((event, index) => ({
                id: index + 1,
                received_at: `2026-05-13T05:10:0${index}.000Z`,
                signed_event: event,
              })),
              public_identities: [
                {
                  name: 'alice-laptop',
                  fingerprint: 'sha256:test-alice-laptop',
                  public_identity: aliceLaptopIdentity,
                },
              ],
            });
          }
          if (String(url).endsWith('/grants/materialized')) {
            expect(body).toMatchObject({
              credential: 'runtime-token',
              context_resource_id: 'context-alpha',
            });
            expect(body.receipts).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  payload: expect.objectContaining({
                    schema: 'viewport.context_vault_grant_materialization/v1',
                    contextResourceId: 'context-alpha',
                    grantEventId: expect.any(String),
                    recipientName: `user-epoch:user_epoch_bob_1:${bobUserEpochFingerprint}`,
                  }),
                  signature: expect.any(String),
                  signed_by_epoch_fingerprint: bobUserEpochFingerprint,
                }),
              ]),
            );
            return jsonResponse({ ok: true, materialized: 1 });
          }
          throw new Error(`Unexpected pull URL: ${String(url)}`);
        },
      });

      expect(pull.materializedGrants).toBe(1);

      const beforeRevokeBundle = await resolveContextBundle({
        contextResourceId: 'context-alpha',
        actorName: 'bob-vps',
        query: 'rollback runbook',
        credentials: {
          passphrase: 'bob-passphrase',
          recoveryCode: 'bob-recovery',
        },
        home: bobHome,
      });
      expect(beforeRevokeBundle.items).toEqual([
        expect.objectContaining({
          title: 'Initial shared context',
          body: 'Tenant routing migrations require a rollback runbook.',
        }),
      ]);

      let pushedRevocationEvents: unknown[] = [];
      const revokeCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const revokeResult = await processPendingContextRevocations({
        contextResourceId: 'context-alpha',
        workspaceId: 'workspace-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'alice-laptop',
        credentials,
        home: tempHome,
        fetchImpl: async (url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          revokeCalls.push({ url: String(url), body });

          if (String(url).endsWith('/grants/revocations/pending')) {
            return jsonResponse({
              revocations: [
                {
                  id: 'cvcg_pending_1',
                  context_resource_id: 'context-alpha',
                  recipient_identity_name: `user-epoch:user_epoch_bob_1:${bobUserEpochFingerprint}`,
                },
              ],
            });
          }

          if (String(url).endsWith('/events/push')) {
            const payload = String(init?.body ?? '');
            expect(payload).toContain('member.revoked');
            expect(payload).toContain('key.rotated');
            expect(payload).toContain('ciphertext');
            expect(payload).not.toContain('bob-passphrase');
            expect(payload).not.toContain('correct horse battery staple');
            pushedRevocationEvents = Array.isArray(body.events) ? body.events : [];
            return jsonResponse({
              ok: true,
              accepted: Array.isArray(body.events) ? body.events.length : 0,
            });
          }

          if (String(url).endsWith('/grants/mark-revoked')) {
            expect(body).toMatchObject({
              credential: 'runtime-token',
              crypto_grant_id: 'cvcg_pending_1',
            });
            expect(typeof body.revoke_event_id).toBe('string');
            expect(body.rotation_event_ids).toEqual(expect.arrayContaining([expect.any(String)]));
            expect(body.rotation_events).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  event_id: expect.any(String),
                }),
              ]),
            );
            expect(typeof body.key_epoch).toBe('number');
            return jsonResponse({ ok: true });
          }

          throw new Error(`Unexpected revoke sync URL: ${String(url)}`);
        },
      });

      expect(revokeResult.revoked).toBe(1);
      expect(revokeResult.pushed).toBeGreaterThan(0);
      expect(revokeCalls.map((call) => call.url)).toEqual([
        'https://app.getviewport.test/api/runtime/workspaces/workspace-alpha/context-vault/grants/revocations/pending',
        'https://app.getviewport.test/api/runtime/workspaces/workspace-alpha/context-vault/events/push',
        'https://app.getviewport.test/api/runtime/workspaces/workspace-alpha/context-vault/grants/mark-revoked',
      ]);

      await addContextEntry({
        contextResourceId: 'context-alpha',
        actorName: 'alice-laptop',
        title: 'Future rotated context',
        body: 'Future tenant cutovers require the rotated repo key.',
        credentials,
        home: tempHome,
      });

      let pushedAfterRevocationEvents: unknown[] = [];
      await pushContextEvents({
        contextResourceId: 'context-alpha',
        workspaceId: 'workspace-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        home: tempHome,
        fetchImpl: async (url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          if (String(url).endsWith('/events/push')) {
            const payload = String(init?.body ?? '');
            expect(payload).toContain('ciphertext');
            expect(payload).not.toContain('Future rotated context');
            expect(payload).not.toContain('Future tenant cutovers require the rotated repo key.');
            pushedAfterRevocationEvents = Array.isArray(body.events) ? body.events : [];
            return jsonResponse({
              ok: true,
              accepted: Array.isArray(body.events) ? body.events.length : 0,
            });
          }
          throw new Error(`Unexpected future push URL: ${String(url)}`);
        },
      });

      const postRevokePullEvents = [...pushedRevocationEvents, ...pushedAfterRevocationEvents];
      await pullContextEvents({
        contextResourceId: 'context-alpha',
        workspaceId: 'workspace-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'bob-vps',
        credentials: {
          passphrase: 'bob-passphrase',
          recoveryCode: 'bob-recovery',
        },
        home: bobHome,
        fetchImpl: async (url) => {
          if (String(url).endsWith('/events/pull')) {
            return jsonResponse({
              data: postRevokePullEvents.map((event, index) => ({
                id: index + 100,
                received_at: `2026-05-13T05:11:${String(index).padStart(2, '0')}.000Z`,
                signed_event: event,
              })),
            });
          }
          if (String(url).endsWith('/grants/materialized')) {
            return jsonResponse({ ok: true, materialized: 0 });
          }
          throw new Error(`Unexpected post-revoke pull URL: ${String(url)}`);
        },
      });

      const afterRevokeBundle = await resolveContextBundle({
        contextResourceId: 'context-alpha',
        actorName: 'bob-vps',
        query: 'tenant',
        credentials: {
          passphrase: 'bob-passphrase',
          recoveryCode: 'bob-recovery',
        },
        home: bobHome,
      });
      expect(afterRevokeBundle.items).toEqual([
        expect.objectContaining({
          title: 'Initial shared context',
          body: 'Tenant routing migrations require a rollback runbook.',
        }),
      ]);
      expect(afterRevokeBundle.items).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: 'Future rotated context',
            body: 'Future tenant cutovers require the rotated repo key.',
          }),
        ]),
      );
    } finally {
      await fs.rm(bobHome, { recursive: true, force: true });
    }
  });

  it('emits and materializes context grants addressed to a team epoch', async () => {
    const bobHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-team-bob-'));
    try {
      await initContextResource({
        contextResourceId: 'context-alpha',
        userName: 'alice',
        deviceName: 'alice-laptop',
        credentials,
        keyStore: 'file',
        home: tempHome,
      });
      await addContextEntry({
        contextResourceId: 'context-alpha',
        actorName: 'alice-laptop',
        title: 'Team-only context',
        body: 'Shard routing decisions require tenant database isolation proof.',
        credentials,
        home: tempHome,
      });
      await initContextResource({
        contextResourceId: 'bob-bootstrap',
        userName: 'bob',
        deviceName: 'bob-vps',
        credentials: {
          passphrase: 'bob-passphrase',
          recoveryCode: 'bob-recovery',
        },
        keyStore: 'file',
        home: bobHome,
      });

      const teamMaterial = createLocalTeamEpochKeyMaterial({
        workspaceId: 'workspace-alpha',
        teamId: 'team-platform-1',
        epoch: 1,
      });
      const teamFingerprint = epochFingerprint(teamMaterial.descriptor);
      await upsertLocalTeamEpoch(
        {
          workspaceId: 'workspace-alpha',
          teamId: 'team-platform-1',
          platformTeamId: 'team-platform-1',
          platformEpochId: 'team_epoch_1',
          epoch: 1,
          schema: 'viewport.team_crypto_epoch/v1',
          status: 'active',
          encryptionPublicKeyJwk: teamMaterial.descriptor.encryptionPublicKeyJwk,
          encryptionPrivateKeyJwk: teamMaterial.encryptionPrivateKeyJwk,
          signingPublicKeyJwk: teamMaterial.descriptor.signingPublicKeyJwk,
          signingPrivateKeyJwk: teamMaterial.signingPrivateKeyJwk,
          fingerprint: teamFingerprint,
          previousEpochFingerprint: null,
        },
        bobHome,
      );

      const aliceLaptopIdentity = exportContextIdentity({ name: 'alice-laptop', home: tempHome });
      let pushedEvents: unknown[] = [];

      const result = await processPendingContextGrants({
        contextResourceId: 'context-alpha',
        workspaceId: 'workspace-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'alice-laptop',
        credentials,
        home: tempHome,
        fetchImpl: async (url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

          if (String(url).endsWith('/grants/pending')) {
            return jsonResponse({
              grants: [
                {
                  id: 'cvcg_team_pending_1',
                  context_resource_id: 'context-alpha',
                  subject_type: 'team',
                  subject_id: 'team-platform-1',
                  recipient_identity: null,
                  team_epoch: {
                    id: 'team_epoch_1',
                    team_id: 'team-platform-1',
                    epoch: 1,
                    fingerprint: teamFingerprint,
                    encryption_public_key_jwk: teamMaterial.descriptor.encryptionPublicKeyJwk,
                    signing_public_key_jwk: teamMaterial.descriptor.signingPublicKeyJwk,
                  },
                },
              ],
            });
          }

          if (String(url).endsWith('/events/push')) {
            const payload = String(init?.body ?? '');
            expect(payload).toContain('member.granted');
            expect(payload).toContain('team-epoch:team_epoch_1');
            expect(payload).toContain('ciphertext');
            expect(payload).not.toContain('Shard routing decisions');
            pushedEvents = Array.isArray(body.events) ? body.events : [];
            return jsonResponse({
              ok: true,
              accepted: Array.isArray(body.events) ? body.events.length : 0,
            });
          }

          if (String(url).endsWith('/grants/mark-emitted')) {
            expect(body).toMatchObject({
              credential: 'runtime-token',
              crypto_grant_id: 'cvcg_team_pending_1',
            });
            expect(String(body.recipient_identity_name)).toContain('team-epoch:team_epoch_1');
            return jsonResponse({ ok: true });
          }

          throw new Error(`Unexpected team grant sync URL: ${String(url)}`);
        },
      });

      expect(result.emitted).toBe(1);
      expect(result.missingIdentity).toBe(0);
      expect(result.pushed).toBeGreaterThan(0);

      await joinContextResource({
        contextResourceId: 'context-alpha',
        userName: 'bob',
        deviceName: 'bob-vps',
        credentials: {
          passphrase: 'bob-passphrase',
          recoveryCode: 'bob-recovery',
        },
        keyStore: 'file',
        home: bobHome,
      });

      const pull = await pullContextEvents({
        contextResourceId: 'context-alpha',
        workspaceId: 'workspace-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'bob-vps',
        credentials: {
          passphrase: 'bob-passphrase',
          recoveryCode: 'bob-recovery',
        },
        home: bobHome,
        fetchImpl: async (url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          if (String(url).endsWith('/events/pull')) {
            return jsonResponse({
              data: pushedEvents.map((event, index) => ({
                id: index + 1,
                received_at: `2026-05-13T05:20:0${index}.000Z`,
                signed_event: event,
              })),
              public_identities: [
                {
                  name: 'alice-laptop',
                  fingerprint: 'sha256:test-alice-laptop',
                  public_identity: aliceLaptopIdentity,
                },
              ],
            });
          }
          if (String(url).endsWith('/grants/materialized')) {
            expect(body.receipts).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  payload: expect.objectContaining({
                    schema: 'viewport.context_vault_grant_materialization/v1',
                    contextResourceId: 'context-alpha',
                    grantEventId: expect.any(String),
                    recipientName: `team-epoch:team_epoch_1:${teamFingerprint}`,
                  }),
                  signature: expect.any(String),
                  signed_by_epoch_fingerprint: teamFingerprint,
                }),
              ]),
            );
            return jsonResponse({ ok: true, materialized: 1 });
          }
          throw new Error(`Unexpected team pull URL: ${String(url)}`);
        },
      });

      expect(pull.materializedGrants).toBe(1);

      const bundle = await resolveContextBundle({
        contextResourceId: 'context-alpha',
        actorName: 'bob-vps',
        query: 'tenant database isolation',
        credentials: {
          passphrase: 'bob-passphrase',
          recoveryCode: 'bob-recovery',
        },
        home: bobHome,
      });
      expect(bundle.items).toEqual([
        expect.objectContaining({
          title: 'Team-only context',
          body: 'Shard routing decisions require tenant database isolation proof.',
        }),
      ]);

      let pushedTeamRevocationEvents: unknown[] = [];
      const teamRevokeResult = await processPendingContextRevocations({
        contextResourceId: 'context-alpha',
        workspaceId: 'workspace-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'alice-laptop',
        credentials,
        home: tempHome,
        fetchImpl: async (url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

          if (String(url).endsWith('/grants/revocations/pending')) {
            return jsonResponse({
              revocations: [
                {
                  id: 'cvcg_team_pending_1',
                  context_resource_id: 'context-alpha',
                  recipient_identity_name: `team-epoch:team_epoch_1:${teamFingerprint}`,
                },
              ],
            });
          }

          if (String(url).endsWith('/events/push')) {
            const payload = String(init?.body ?? '');
            expect(payload).toContain('member.revoked');
            expect(payload).toContain('key.rotated');
            expect(payload).toContain('ciphertext');
            expect(payload).not.toContain('Team future context');
            pushedTeamRevocationEvents = Array.isArray(body.events) ? body.events : [];
            return jsonResponse({
              ok: true,
              accepted: Array.isArray(body.events) ? body.events.length : 0,
            });
          }

          if (String(url).endsWith('/grants/mark-revoked')) {
            expect(body).toMatchObject({
              credential: 'runtime-token',
              crypto_grant_id: 'cvcg_team_pending_1',
            });
            expect(body.rotation_event_ids).toEqual(expect.arrayContaining([expect.any(String)]));
            return jsonResponse({ ok: true });
          }

          throw new Error(`Unexpected team revoke URL: ${String(url)}`);
        },
      });

      expect(teamRevokeResult.revoked).toBe(1);

      await addContextEntry({
        contextResourceId: 'context-alpha',
        actorName: 'alice-laptop',
        title: 'Team future context',
        body: 'Future shard migrations require the rotated team repo key.',
        credentials,
        home: tempHome,
      });

      let pushedAfterTeamRevocationEvents: unknown[] = [];
      await pushContextEvents({
        contextResourceId: 'context-alpha',
        workspaceId: 'workspace-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        home: tempHome,
        fetchImpl: async (url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          if (String(url).endsWith('/events/push')) {
            const payload = String(init?.body ?? '');
            expect(payload).toContain('ciphertext');
            expect(payload).not.toContain('Team future context');
            expect(payload).not.toContain(
              'Future shard migrations require the rotated team repo key.',
            );
            pushedAfterTeamRevocationEvents = Array.isArray(body.events) ? body.events : [];
            return jsonResponse({
              ok: true,
              accepted: Array.isArray(body.events) ? body.events.length : 0,
            });
          }
          throw new Error(`Unexpected team future push URL: ${String(url)}`);
        },
      });

      const postTeamRevokeEvents = [
        ...pushedTeamRevocationEvents,
        ...pushedAfterTeamRevocationEvents,
      ];
      await pullContextEvents({
        contextResourceId: 'context-alpha',
        workspaceId: 'workspace-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'bob-vps',
        credentials: {
          passphrase: 'bob-passphrase',
          recoveryCode: 'bob-recovery',
        },
        home: bobHome,
        fetchImpl: async (url) => {
          if (String(url).endsWith('/events/pull')) {
            return jsonResponse({
              data: postTeamRevokeEvents.map((event, index) => ({
                id: index + 200,
                received_at: `2026-05-13T05:21:${String(index).padStart(2, '0')}.000Z`,
                signed_event: event,
              })),
            });
          }
          if (String(url).endsWith('/grants/materialized')) {
            return jsonResponse({ ok: true, materialized: 0 });
          }
          throw new Error(`Unexpected team post-revoke pull URL: ${String(url)}`);
        },
      });

      const afterTeamRevokeBundle = await resolveContextBundle({
        contextResourceId: 'context-alpha',
        actorName: 'bob-vps',
        query: 'shard migrations',
        credentials: {
          passphrase: 'bob-passphrase',
          recoveryCode: 'bob-recovery',
        },
        home: bobHome,
      });
      expect(afterTeamRevokeBundle.items).toEqual([
        expect.objectContaining({
          title: 'Team-only context',
          body: 'Shard routing decisions require tenant database isolation proof.',
        }),
      ]);
      expect(afterTeamRevokeBundle.items).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: 'Team future context',
            body: 'Future shard migrations require the rotated team repo key.',
          }),
        ]),
      );
    } finally {
      await fs.rm(bobHome, { recursive: true, force: true });
    }
  });

  it('applies platform context candidate approvals at the trusted edge for future bundles', async () => {
    await initContextResource({
      contextResourceId: 'context-alpha',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      keyStore: 'file',
      home: tempHome,
    });

    const candidate = await proposeContextEntry({
      contextResourceId: 'context-alpha',
      actorName: 'alice-laptop',
      title: 'Auth review candidate',
      body: 'Agent runs touching auth must include session rotation proof.',
      source: 'workflow://pr-review',
      sourceKind: 'workflow',
      credentials,
      home: tempHome,
    });

    const decision = signedDecision({
      schema_version: 'viewport.context_candidate_decision/v1',
      id: 'ctxd_inbox_1',
      inbox_item_id: 'inbox_1',
      repo_id: 'context-alpha',
      candidate_event_id: candidate.id,
      payload_digest: candidate.bodyDigest,
      decision: 'approved',
      message: 'Promote from Inbox review.',
      decided_at: '2026-05-07T16:00:00.000Z',
      decided_by_user_id: '42',
    });

    const pull = await pullContextEvents({
      contextResourceId: 'context-alpha',
      serverUrl: 'https://app.getviewport.test',
      credential: 'runtime-token',
      actorName: 'alice-laptop',
      credentials,
      trustedDecisionKeys: pinnedKeysFor(decision),
      fetchImpl: async () =>
        jsonResponse({
          data: [],
          candidate_decisions: [decision],
        }),
      home: tempHome,
    });

    expect(pull.pulled).toBe(0);
    expect(pull.appliedCandidateDecisions).toBe(1);
    expect(pull.pendingCandidateDecisions).toBe(0);

    const bundle = await resolveContextBundle({
      contextResourceId: 'context-alpha',
      actorName: 'alice-laptop',
      query: 'session rotation proof',
      credentials,
      home: tempHome,
    });

    expect(bundle.items).toEqual([
      expect.objectContaining({
        title: 'Auth review candidate',
        body: 'Agent runs touching auth must include session rotation proof.',
      }),
    ]);

    const raw = await readTree(path.join(tempHome, 'repos', 'context-alpha', 'events'));
    expect(raw).toContain('candidate.approved');
    expect(raw).toContain('entry.approved');
    expect(raw).not.toContain('Agent runs touching auth');

    let pushedAfterApproval = '';
    const push = await pushContextEvents({
      contextResourceId: 'context-alpha',
      serverUrl: 'https://app.getviewport.test',
      credential: 'runtime-token',
      fetchImpl: async (_url, init) => {
        pushedAfterApproval = String(init?.body ?? '');
        const body = JSON.parse(pushedAfterApproval);
        return jsonResponse({ ok: true, accepted: body.events.length }, 202);
      },
      home: tempHome,
    });

    expect(push.accepted).toBeGreaterThan(0);
    expect(pushedAfterApproval).toContain('candidate.approved');
    expect(pushedAfterApproval).toContain('entry.approved');
    expect(pushedAfterApproval).toContain('candidate_decision_applications');
    expect(pushedAfterApproval).toContain('ctxd_inbox_1');
    expect(pushedAfterApproval).not.toContain('Agent runs touching auth');
  });

  it('routes candidate decisions by context resource id and records skipped mismatches', async () => {
    await initContextResource({
      contextResourceId: 'ctx-auth-policy',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      keyStore: 'file',
      home: tempHome,
    });

    const candidate = await proposeContextEntry({
      contextResourceId: 'ctx-auth-policy',
      actorName: 'alice-laptop',
      title: 'Resource-scoped candidate',
      body: 'This candidate only belongs to the auth policy context resource.',
      sourceKind: 'workflow',
      credentials,
      home: tempHome,
    });

    let proposedEventPayload = '';
    await pushContextEvents({
      contextResourceId: 'ctx-auth-policy',
      serverUrl: 'https://app.getviewport.test',
      credential: 'runtime-token',
      fetchImpl: async (_url, init) => {
        proposedEventPayload = String(init?.body ?? '');
        const body = JSON.parse(proposedEventPayload);
        return jsonResponse({ ok: true, accepted: body.events.length }, 202);
      },
      home: tempHome,
    });

    expect(proposedEventPayload).toContain('"contextResourceId":"ctx-auth-policy"');
    expect(proposedEventPayload).not.toContain('This candidate only belongs');

    const mismatchedDecision = signedDecision({
      schema_version: 'viewport.context_candidate_decision/v1',
      id: 'ctxd_wrong_resource',
      inbox_item_id: 'inbox_wrong_resource',
      repo_id: 'ctx-auth-policy',
      context_resource_id: 'ctx-release-policy',
      candidate_event_id: candidate.id,
      payload_digest: candidate.bodyDigest,
      decision: 'approved',
      decided_at: '2026-05-07T17:00:00.000Z',
      decided_by_user_id: '42',
    });

    const pull = await pullContextEvents({
      contextResourceId: 'ctx-auth-policy',
      serverUrl: 'https://app.getviewport.test',
      credential: 'runtime-token',
      actorName: 'alice-laptop',
      credentials,
      trustedDecisionKeys: pinnedKeysFor(mismatchedDecision),
      fetchImpl: async () =>
        jsonResponse({
          data: [],
          candidate_decisions: [mismatchedDecision],
        }),
      home: tempHome,
    });

    expect(pull.appliedCandidateDecisions).toBe(0);

    let pushedApplications = '';
    await pushContextEvents({
      contextResourceId: 'ctx-auth-policy',
      serverUrl: 'https://app.getviewport.test',
      credential: 'runtime-token',
      fetchImpl: async (_url, init) => {
        pushedApplications = String(init?.body ?? '');
        const body = JSON.parse(pushedApplications);
        return jsonResponse({ ok: true, accepted: body.events.length }, 202);
      },
      home: tempHome,
    });

    expect(pushedApplications).toContain('candidate_decision_applications');
    expect(pushedApplications).toContain('"context_resource_id":"ctx-release-policy"');
    expect(pushedApplications).toContain('context_resource_mismatch');
  });

  it('rejects unsigned platform candidate decisions before they can become engine events', async () => {
    await initContextResource({
      contextResourceId: 'context-alpha',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      keyStore: 'file',
      home: tempHome,
    });

    const candidate = await proposeContextEntry({
      contextResourceId: 'context-alpha',
      actorName: 'alice-laptop',
      title: 'Unsigned candidate',
      body: 'Unsigned decisions must not promote context.',
      sourceKind: 'workflow',
      credentials,
      home: tempHome,
    });

    await expect(
      pullContextEvents({
        contextResourceId: 'context-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'alice-laptop',
        credentials,
        trustedDecisionKeys: { 'platform-v1': crypto.randomBytes(32).toString('base64') },
        fetchImpl: async () =>
          jsonResponse({
            data: [],
            candidate_decisions: [
              {
                schema_version: 'viewport.context_candidate_decision/v1',
                id: 'ctxd_unsigned',
                repo_id: 'context-alpha',
                candidate_event_id: candidate.id,
                payload_digest: candidate.bodyDigest,
                decision: 'approved',
              },
            ],
          }),
        home: tempHome,
      }),
    ).rejects.toThrow(/missing a platform signature/i);
  });

  it('rejects tampered platform candidate decision signatures', async () => {
    await initContextResource({
      contextResourceId: 'context-alpha',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      keyStore: 'file',
      home: tempHome,
    });

    const candidate = await proposeContextEntry({
      contextResourceId: 'context-alpha',
      actorName: 'alice-laptop',
      title: 'Tampered candidate',
      body: 'Tampered decisions must not promote context.',
      sourceKind: 'workflow',
      credentials,
      home: tempHome,
    });

    const decision = signedDecision({
      schema_version: 'viewport.context_candidate_decision/v1',
      id: 'ctxd_tampered',
      inbox_item_id: 'inbox_tampered',
      repo_id: 'context-alpha',
      candidate_event_id: candidate.id,
      payload_digest: candidate.bodyDigest,
      decision: 'approved',
      decided_at: '2026-05-07T16:00:00.000Z',
      decided_by_user_id: '42',
    });
    decision.decision = 'rejected';

    await expect(
      pullContextEvents({
        contextResourceId: 'context-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'alice-laptop',
        credentials,
        trustedDecisionKeys: pinnedKeysFor(decision),
        fetchImpl: async () => jsonResponse({ data: [], candidate_decisions: [decision] }),
        home: tempHome,
      }),
    ).rejects.toThrow(/digest mismatch|signature/i);
  });

  it('rejects candidate decisions signed by an unpinned platform key', async () => {
    await initContextResource({
      contextResourceId: 'context-alpha',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      keyStore: 'file',
      home: tempHome,
    });

    const candidate = await proposeContextEntry({
      contextResourceId: 'context-alpha',
      actorName: 'alice-laptop',
      title: 'Self-signed candidate',
      body: 'Self-signed decisions must not promote context.',
      sourceKind: 'workflow',
      credentials,
      home: tempHome,
    });

    const decision = signedDecision({
      schema_version: 'viewport.context_candidate_decision/v1',
      id: 'ctxd_self_signed',
      inbox_item_id: 'inbox_self_signed',
      repo_id: 'context-alpha',
      candidate_event_id: candidate.id,
      payload_digest: candidate.bodyDigest,
      decision: 'approved',
      decided_at: '2026-05-07T16:00:00.000Z',
      decided_by_user_id: '42',
    });

    await expect(
      pullContextEvents({
        contextResourceId: 'context-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'alice-laptop',
        credentials,
        trustedDecisionKeys: {
          [decision.platform_signature.kid]: crypto.randomBytes(32).toString('base64'),
        },
        fetchImpl: async () => jsonResponse({ data: [], candidate_decisions: [decision] }),
        home: tempHome,
      }),
    ).rejects.toThrow(/did not match the pinned key/i);
  });

  it('converges when two trusted edges apply the same signed candidate decision', async () => {
    const desktopHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-context-desktop-'));
    try {
      await initContextResource({
        contextResourceId: 'context-alpha',
        userName: 'alice',
        deviceName: 'alice-laptop',
        credentials,
        keyStore: 'file',
        home: tempHome,
      });
      const candidate = await proposeContextEntry({
        contextResourceId: 'context-alpha',
        actorName: 'alice-laptop',
        title: 'Race-safe candidate',
        body: 'Concurrent trusted edges should not duplicate approved context.',
        sourceKind: 'workflow',
        credentials,
        home: tempHome,
      });

      let platformEvents: unknown[] = [];
      await pushContextEvents({
        contextResourceId: 'context-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          platformEvents = body.events as unknown[];
          return jsonResponse({ ok: true, accepted: platformEvents.length }, 202);
        },
        home: tempHome,
      });

      const request = createContextDeviceRequest({
        deviceName: 'alice-desktop',
        code: '123456',
        keyStore: 'file',
        home: desktopHome,
      });
      const approval = await approveContextDeviceRequest({
        userName: 'alice',
        request,
        code: '123456',
        credentials,
        home: tempHome,
      });
      await acceptContextDeviceApproval({
        userName: 'alice',
        deviceName: 'alice-desktop',
        approval,
        code: '123456',
        keyStore: 'file',
        home: desktopHome,
      });
      await joinContextResource({
        contextResourceId: 'context-alpha',
        userName: 'alice',
        deviceName: 'alice-desktop',
        credentials,
        keyStore: 'file',
        home: desktopHome,
      });
      importContextIdentity({
        identity: exportContextIdentity({ name: 'alice-laptop', home: tempHome }),
        home: desktopHome,
      });
      importContextIdentity({
        identity: exportContextIdentity({ name: 'alice-desktop', home: desktopHome }),
        home: tempHome,
      });

      await pullContextEvents({
        contextResourceId: 'context-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'alice-desktop',
        credentials,
        fetchImpl: async () =>
          jsonResponse({
            data: platformEvents.map((event, index) => ({
              received_at: `2026-05-07T16:10:0${index}.000Z`,
              signed_event: event,
            })),
          }),
        home: desktopHome,
      });

      const decision = signedDecision({
        schema_version: 'viewport.context_candidate_decision/v1',
        id: 'ctxd_multi_edge',
        inbox_item_id: 'inbox_multi_edge',
        repo_id: 'context-alpha',
        candidate_event_id: candidate.id,
        payload_digest: candidate.bodyDigest,
        decision: 'approved',
        decided_at: '2026-05-07T16:15:00.000Z',
        decided_by_user_id: '42',
      });
      const trustedDecisionKeys = pinnedKeysFor(decision);

      const laptopDecision = await pullContextEvents({
        contextResourceId: 'context-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'alice-laptop',
        credentials,
        trustedDecisionKeys,
        fetchImpl: async () => jsonResponse({ data: [], candidate_decisions: [decision] }),
        home: tempHome,
      });
      const desktopDecision = await pullContextEvents({
        contextResourceId: 'context-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'alice-desktop',
        credentials,
        trustedDecisionKeys,
        fetchImpl: async () => jsonResponse({ data: [], candidate_decisions: [decision] }),
        home: desktopHome,
      });

      expect(laptopDecision.appliedCandidateDecisions).toBe(1);
      expect(desktopDecision.appliedCandidateDecisions).toBe(1);

      const approvedEvents: unknown[] = [];
      await pushContextEvents({
        contextResourceId: 'context-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          approvedEvents.push(...(body.events as unknown[]));
          return jsonResponse({ ok: true, accepted: body.events.length }, 202);
        },
        home: tempHome,
      });
      await pushContextEvents({
        contextResourceId: 'context-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}'));
          approvedEvents.push(...(body.events as unknown[]));
          return jsonResponse({ ok: true, accepted: body.events.length }, 202);
        },
        home: desktopHome,
      });
      await pullContextEvents({
        contextResourceId: 'context-alpha',
        serverUrl: 'https://app.getviewport.test',
        credential: 'runtime-token',
        actorName: 'alice-laptop',
        credentials,
        trustedDecisionKeys,
        fetchImpl: async () =>
          jsonResponse({
            data: approvedEvents.map((event, index) => ({
              received_at: `2026-05-07T16:20:${String(index).padStart(2, '0')}.000Z`,
              signed_event: event,
            })),
          }),
        home: tempHome,
      });

      const bundle = await resolveContextBundle({
        contextResourceId: 'context-alpha',
        actorName: 'alice-laptop',
        query: 'Concurrent trusted edges',
        credentials,
        home: tempHome,
      });

      expect(bundle.items).toHaveLength(1);
      expect(bundle.items[0]?.body).toBe(
        'Concurrent trusted edges should not duplicate approved context.',
      );
    } finally {
      await fs.rm(desktopHome, { recursive: true, force: true });
    }
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

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function headerValue(headers: RequestInit['headers'] | undefined, name: string): string | null {
    if (!headers) return null;
    if (headers instanceof Headers) return headers.get(name);
    if (Array.isArray(headers)) {
      const match = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
      return match?.[1] ?? null;
    }
    const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return typeof match?.[1] === 'string' ? match[1] : null;
  }

  function signedDecision<T extends Record<string, unknown>>(
    record: T,
  ): T & {
    platform_signature: {
      algorithm: 'Ed25519';
      kid: string;
      public_key: string;
      signature: string;
      signed_payload_digest: string;
    };
  } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const rawPublicKey = publicDer.subarray(-32);
    const payload = canonicalJson({
      schema_version: record.schema_version,
      id: record.id,
      inbox_item_id: record.inbox_item_id ?? null,
      repo_id: record.repo_id,
      context_resource_id: record.context_resource_id ?? record.repo_id,
      candidate_event_id: record.candidate_event_id,
      payload_digest: record.payload_digest ?? null,
      decision: record.decision,
      message: record.message ?? null,
      decided_at: record.decided_at ?? null,
      decided_by_user_id: record.decided_by_user_id ?? null,
    });
    return {
      ...record,
      platform_signature: {
        algorithm: 'Ed25519',
        kid: 'platform-v1',
        public_key: rawPublicKey.toString('base64'),
        signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64'),
        signed_payload_digest: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
      },
    };
  }

  function pinnedKeysFor(record: {
    platform_signature: { kid: string; public_key: string };
  }): Record<string, string> {
    return { [record.platform_signature.kid]: record.platform_signature.public_key };
  }

  function canonicalJson(value: unknown): string {
    return JSON.stringify(sortKeys(value));
  }

  function sortKeys(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(sortKeys);
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
});
