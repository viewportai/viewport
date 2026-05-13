import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decryptTrustedEdgePlanBody,
  publishTrustedEdgePlanWrappingKey,
  saveTrustedEdgePlanDraft,
  wrapTrustedEdgePlanBodyKey,
} from '../../src/hooks/trusted-edge-plan-artifacts.js';

describe('trusted-edge plan artifacts', () => {
  it('encrypts plan hook bodies before upload and decrypts only with the local edge key', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-plan-artifact-'));
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      requests.push({ url, body });
      return new Response(
        JSON.stringify({
          data: {
            id: 'plan-trusted-edge-1',
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    };

    const result = await saveTrustedEdgePlanDraft({
      home,
      fetchImpl: fetchImpl as any,
      target: {
        workspaceId: 'workspace-1',
        serverUrl: 'https://api.getviewport.test',
        credential: 'issue-token',
      },
      event: {
        sessionId: 'session-1',
        adapter: 'claude',
        title: 'Trusted edge plan',
        summary: 'Encrypted before upload.',
        body: '## Plan\n1. Do not leak plaintext',
        source: 'claude',
        sourceRef: 'agent-hook:session-1',
        metadata: { model: 'sonnet' },
      },
    });

    expect(result.planId).toBe('plan-trusted-edge-1');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(
      'https://api.getviewport.test/api/runtime/workspaces/workspace-1/plan-encryption-keys',
    );
    expect(JSON.stringify(requests[0]?.body)).not.toContain('private_key');
    expect(requests[1]?.url).toBe(
      'https://api.getviewport.test/api/runtime/workspaces/workspace-1/agent-hooks/plans',
    );
    expect(JSON.stringify(requests[1]?.body)).not.toContain('Do not leak plaintext');
    expect(requests[1]?.body).toMatchObject({
      credential: 'issue-token',
      body_encryption: expect.objectContaining({
        schema: 'viewport.plan_body_encrypted/v1',
        algorithm: 'AES-GCM-256',
        tag: expect.any(String),
      }),
    });

    const decrypted = await decryptTrustedEdgePlanBody({
      home,
      workspaceId: 'workspace-1',
      planId: 'plan-trusted-edge-1',
      sourceRef: 'agent-hook:session-1',
      envelope: result.envelope,
    });
    expect(decrypted.body).toBe('## Plan\n1. Do not leak plaintext');

    await fs.rm(home, { recursive: true, force: true });
  });

  it('wraps trusted-edge plan keys for another trusted edge without server plaintext', async () => {
    const ownerHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-plan-owner-'));
    const recipientHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vpd-plan-recipient-'));
    const fetchImpl = async () =>
      new Response(JSON.stringify({ data: { id: 'plan-trusted-edge-2' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });

    const target = {
      workspaceId: 'workspace-1',
      serverUrl: 'https://api.getviewport.test',
      credential: 'issue-token',
    };
    const saved = await saveTrustedEdgePlanDraft({
      home: ownerHome,
      fetchImpl: fetchImpl as any,
      target,
      event: {
        sessionId: 'session-2',
        adapter: 'claude',
        title: 'Shared trusted edge plan',
        summary: 'Recipient decrypts locally.',
        body: '## Shared Plan\nOnly recipient daemon should unwrap this.',
        source: 'claude',
        sourceRef: 'agent-hook:session-2',
        metadata: {},
      },
    });
    const recipientKey = await publishTrustedEdgePlanWrappingKey({
      home: recipientHome,
      target,
      fetchImpl: fetchImpl as any,
    });

    const grants = await wrapTrustedEdgePlanBodyKey({
      home: ownerHome,
      workspaceId: 'workspace-1',
      planId: saved.planId,
      sourceRef: saved.sourceRef,
      envelope: saved.envelope,
      recipients: [
        {
          user_id: 42,
          key_id: recipientKey.keyId,
          public_key_jwk: recipientKey.publicKeyJwk,
        },
      ],
    });

    expect(JSON.stringify(grants)).not.toContain('Shared Plan');
    const decrypted = await decryptTrustedEdgePlanBody({
      home: recipientHome,
      workspaceId: 'workspace-1',
      planId: saved.planId,
      sourceRef: saved.sourceRef,
      envelope: saved.envelope,
      bodyKeyGrants: grants,
    });
    expect(decrypted.body).toContain('Only recipient daemon should unwrap this.');

    await fs.rm(ownerHome, { recursive: true, force: true });
    await fs.rm(recipientHome, { recursive: true, force: true });
  });
});
