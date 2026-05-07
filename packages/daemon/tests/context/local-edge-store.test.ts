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
import { proposeContextEntry } from '../../src/context/local-edge-candidates.js';
import { pullContextEvents, pushContextEvents } from '../../src/context/local-edge-sync.js';
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
      keyStore: 'file',
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
      keyStore: 'file',
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
      keyStore: 'file',
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

  it('pushes and pulls only canonical encrypted events through the platform sync API', async () => {
    await initContextProject({
      projectId: 'project-alpha',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      keyStore: 'file',
      home: tempHome,
    });
    await addContextEntry({
      projectId: 'project-alpha',
      actorName: 'alice-laptop',
      title: 'Sync policy',
      body: 'Context sync must never send plaintext.',
      credentials,
      home: tempHome,
    });

    let pushedEvents: unknown[] = [];
    const pullBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
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
      projectId: 'project-alpha',
      serverUrl: 'https://app.getviewport.test',
      credential: 'runtime-token',
      fetchImpl,
      home: tempHome,
    });

    expect(push.accepted).toBeGreaterThan(0);
    expect(push.pushed).toBe(push.accepted);

    const pull = await pullContextEvents({
      projectId: 'project-alpha',
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
      projectId: 'project-alpha',
      serverUrl: 'https://app.getviewport.test',
      credential: 'runtime-token',
      actorName: 'alice-laptop',
      credentials,
      fetchImpl,
      home: tempHome,
    });

    expect(secondPull.pulled).toBe(0);
    expect(pullBodies[0]).not.toHaveProperty('after_received_at');
    expect(pullBodies[1]).toMatchObject({
      after_received_at: `2026-05-06T21:00:0${pushedEvents.length - 1}.000Z`,
    });
  });

  it('applies platform context candidate approvals at the trusted edge for future bundles', async () => {
    await initContextProject({
      projectId: 'project-alpha',
      userName: 'alice',
      deviceName: 'alice-laptop',
      credentials,
      keyStore: 'file',
      home: tempHome,
    });

    const candidate = await proposeContextEntry({
      projectId: 'project-alpha',
      actorName: 'alice-laptop',
      title: 'Auth review candidate',
      body: 'Agent runs touching auth must include session rotation proof.',
      source: 'workflow://pr-review',
      sourceKind: 'workflow',
      credentials,
      home: tempHome,
    });

    const pull = await pullContextEvents({
      projectId: 'project-alpha',
      serverUrl: 'https://app.getviewport.test',
      credential: 'runtime-token',
      actorName: 'alice-laptop',
      credentials,
      fetchImpl: async () =>
        jsonResponse({
          data: [],
          candidate_decisions: [
            {
              schema_version: 'viewport.context_candidate_decision/v1',
              id: 'ctxd_inbox_1',
              repo_id: 'project-alpha',
              candidate_event_id: candidate.id,
              payload_digest: candidate.bodyDigest,
              decision: 'approved',
              message: 'Promote from Inbox review.',
              decided_at: '2026-05-07T16:00:00.000Z',
            },
          ],
        }),
      home: tempHome,
    });

    expect(pull.pulled).toBe(0);
    expect(pull.appliedCandidateDecisions).toBe(1);
    expect(pull.pendingCandidateDecisions).toBe(0);

    const bundle = await resolveContextBundle({
      projectId: 'project-alpha',
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

    const raw = await readTree(path.join(tempHome, 'repos', 'project-alpha', 'events'));
    expect(raw).toContain('candidate.approved');
    expect(raw).toContain('entry.approved');
    expect(raw).not.toContain('Agent runs touching auth');

    let pushedAfterApproval = '';
    const push = await pushContextEvents({
      projectId: 'project-alpha',
      serverUrl: 'https://app.getviewport.test',
      credential: 'runtime-token',
      fetchImpl: async (_url, init) => {
        pushedAfterApproval = String(init?.body ?? '');
        return jsonResponse(
          { ok: true, accepted: JSON.parse(pushedAfterApproval).events.length },
          202,
        );
      },
      home: tempHome,
    });

    expect(push.accepted).toBeGreaterThan(0);
    expect(pushedAfterApproval).toContain('candidate.approved');
    expect(pushedAfterApproval).toContain('entry.approved');
    expect(pushedAfterApproval).not.toContain('Agent runs touching auth');
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

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
});
