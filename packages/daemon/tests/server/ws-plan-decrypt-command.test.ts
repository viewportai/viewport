import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedClient } from '../../src/server/hello-builder.js';

vi.mock('../../src/hooks/trusted-edge-plan-artifacts.js', () => ({
  decryptTrustedEdgePlanBody: vi.fn(),
  decryptTrustedEdgePlanFeedbackField: vi.fn(),
  encryptTrustedEdgePlanFeedbackField: vi.fn(),
  wrapTrustedEdgePlanBodyKey: vi.fn(),
}));

import { createWsCommandHandlers } from '../../src/server/ws-command-handlers.js';
import {
  decryptTrustedEdgePlanBody,
  decryptTrustedEdgePlanFeedbackField,
  encryptTrustedEdgePlanFeedbackField,
  wrapTrustedEdgePlanBodyKey,
} from '../../src/hooks/trusted-edge-plan-artifacts.js';

function createClient(): ConnectedClient {
  return {
    send: vi.fn(),
    subscriptions: new Set(),
    watchedDiscoveredSessions: new Set(),
    pendingBytes: 0,
  };
}

const TEST_SIGNING_KEY = 'trusted-edge-command-test-secret';

function createDaemon(runtimeTargetId = 'runtime-target-1'): any {
  return {
    configManager: {
      getDaemonConfig: () => ({
        relay: {
          workspaceId: 'workspace-1',
          runtimeTargetId,
          tokenIssuer: 'viewport-server',
          tokenAudience: 'viewport-relay',
          signingKeys: { v1: TEST_SIGNING_KEY },
          tokenClockSkewSec: 30,
        },
      }),
    },
  };
}

function capabilityToken(
  purpose: string,
  planId = 'plan-1',
  extraClaims: Record<string, unknown> = {},
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'v1' }),
    'utf8',
  ).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      role: 'trusted-edge-client',
      scope: 'trusted-edge-command',
      workspaceId: 'workspace-1',
      purpose,
      planId,
      trustedEdgeUnlockSessionId: 'unlock-session-1',
      iss: 'viewport-server',
      aud: 'viewport-relay',
      iat: now,
      exp: now + 60,
      jti: crypto.randomUUID(),
      ...extraClaims,
    }),
    'utf8',
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', TEST_SIGNING_KEY)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('trusted-edge-plan-decrypt websocket command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects decrypt requests without a scoped command capability', async () => {
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: createDaemon(),
      sendAck,
      getOrCreateBuffer: (() => ({
        getAll: () => [],
        getReplayWindow: () => ({ entries: [] }),
      })) as any,
    });

    await handlers['trusted-edge-plan-decrypt'](createClient(), {
      type: 'trusted-edge-plan-decrypt',
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      bodyEncryption: {
        schema: 'viewport.plan_body_encrypted/v1',
        algorithm: 'AES-GCM-256',
        key_ref: 'trusted-edge-plan-key',
        ciphertext: 'ciphertext',
        iv: 'iv',
        tag: 'tag',
        digest: 'sha256:ciphertext',
        aad: {},
      },
      requestId: 'plan-decrypt-req',
    });

    expect(decryptTrustedEdgePlanBody).not.toHaveBeenCalled();
    expect(sendAck).toHaveBeenCalledWith(
      expect.any(Object),
      'plan-decrypt-req',
      'error',
      'Trusted-edge command capability is required.',
      { errorCode: 'INVALID_INPUT' },
    );
  });

  it('returns decrypted plan body from the trusted edge', async () => {
    const sendAck = vi.fn();
    vi.mocked(decryptTrustedEdgePlanBody).mockResolvedValue({
      body: '## Plan\n1. Migrate safely',
      bodySha256: 'sha256:plaintext',
      keyRef: 'trusted-edge-plan-key',
    });
    const handlers = createWsCommandHandlers({
      daemon: createDaemon(),
      sendAck,
      getOrCreateBuffer: (() => ({
        getAll: () => [],
        getReplayWindow: () => ({ entries: [] }),
      })) as any,
    });

    await handlers['trusted-edge-plan-decrypt'](createClient(), {
      type: 'trusted-edge-plan-decrypt',
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      sourceRef: 'agent-hook:session-1',
      bodyEncryption: {
        schema: 'viewport.plan_body_encrypted/v1',
        algorithm: 'AES-GCM-256',
        key_ref: 'trusted-edge-plan-key',
        ciphertext: 'ciphertext',
        iv: 'iv',
        tag: 'tag',
        digest: 'sha256:ciphertext',
        aad: {},
      },
      capabilityToken: capabilityToken('trusted-edge-plan-decrypt'),
      requestId: 'plan-decrypt-req',
    });

    expect(decryptTrustedEdgePlanBody).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      sourceRef: 'agent-hook:session-1',
      envelope: expect.objectContaining({ key_ref: 'trusted-edge-plan-key' }),
      bodyKeyGrants: undefined,
    });
    expect(sendAck).toHaveBeenCalledWith(
      expect.any(Object),
      'plan-decrypt-req',
      'ok',
      undefined,
      expect.objectContaining({
        planId: 'plan-1',
        body: '## Plan\n1. Migrate safely',
        bodySha256: 'sha256:plaintext',
        keyRef: 'trusted-edge-plan-key',
      }),
    );
  });

  it('rejects capabilities unlocked for a different runtime target', async () => {
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: createDaemon('runtime-target-1'),
      sendAck,
      getOrCreateBuffer: (() => ({
        getAll: () => [],
        getReplayWindow: () => ({ entries: [] }),
      })) as any,
    });

    await handlers['trusted-edge-plan-decrypt'](createClient(), {
      type: 'trusted-edge-plan-decrypt',
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      bodyEncryption: {
        schema: 'viewport.plan_body_encrypted/v1',
        algorithm: 'AES-GCM-256',
        key_ref: 'trusted-edge-plan-key',
        ciphertext: 'ciphertext',
        iv: 'iv',
        tag: 'tag',
        digest: 'sha256:ciphertext',
        aad: {},
      },
      capabilityToken: capabilityToken('trusted-edge-plan-decrypt', 'plan-1', {
        runtimeTargetId: 'runtime-target-2',
      }),
      requestId: 'plan-decrypt-target-mismatch',
    });

    expect(decryptTrustedEdgePlanBody).not.toHaveBeenCalled();
    expect(sendAck).toHaveBeenCalledWith(
      expect.any(Object),
      'plan-decrypt-target-mismatch',
      'error',
      'Trusted-edge command capability runtimeTargetId mismatch.',
      { errorCode: 'INVALID_INPUT' },
    );
  });

  it('returns a structured error when the edge key is missing', async () => {
    const sendAck = vi.fn();
    vi.mocked(decryptTrustedEdgePlanBody).mockRejectedValue(
      new Error('Trusted edge does not have the key for this plan.'),
    );
    const handlers = createWsCommandHandlers({
      daemon: createDaemon(),
      sendAck,
      getOrCreateBuffer: (() => ({
        getAll: () => [],
        getReplayWindow: () => ({ entries: [] }),
      })) as any,
    });

    await handlers['trusted-edge-plan-decrypt'](createClient(), {
      type: 'trusted-edge-plan-decrypt',
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      bodyEncryption: {
        schema: 'viewport.plan_body_encrypted/v1',
        algorithm: 'AES-GCM-256',
        key_ref: 'trusted-edge-plan-key',
        ciphertext: 'ciphertext',
        iv: 'iv',
        tag: 'tag',
        digest: 'sha256:ciphertext',
        aad: {},
      },
      capabilityToken: capabilityToken('trusted-edge-plan-decrypt'),
      requestId: 'plan-decrypt-req',
    });

    expect(sendAck).toHaveBeenCalledWith(
      expect.any(Object),
      'plan-decrypt-req',
      'error',
      'Trusted edge does not have the key for this plan.',
      { errorCode: 'INVALID_INPUT' },
    );
  });

  it('encrypts review fields with the trusted-edge plan key', async () => {
    const sendAck = vi.fn();
    vi.mocked(encryptTrustedEdgePlanFeedbackField).mockResolvedValue({
      schema: 'viewport.plan_feedback_field_encrypted/v1',
      algorithm: 'AES-GCM-256',
      key_ref: 'trusted-edge-plan-key',
      ciphertext: 'encrypted-comment',
      iv: 'iv',
      tag: 'tag',
      digest: 'sha256:comment',
      aad: { purpose: 'plan-feedback-body' },
    });
    const handlers = createWsCommandHandlers({
      daemon: createDaemon(),
      sendAck,
      getOrCreateBuffer: (() => ({
        getAll: () => [],
        getReplayWindow: () => ({ entries: [] }),
      })) as any,
    });

    await handlers['trusted-edge-plan-encrypt-field'](createClient(), {
      type: 'trusted-edge-plan-encrypt-field',
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      bodyEncryption: {
        schema: 'viewport.plan_body_encrypted/v1',
        algorithm: 'AES-GCM-256',
        key_ref: 'trusted-edge-plan-key',
        ciphertext: 'ciphertext',
        iv: 'iv',
        tag: 'tag',
        digest: 'sha256:ciphertext',
        aad: {},
      },
      text: 'Needs one more proof step.',
      aad: { purpose: 'plan-feedback-body' },
      capabilityToken: capabilityToken('trusted-edge-plan-encrypt-field'),
      requestId: 'plan-encrypt-field-req',
    });

    expect(encryptTrustedEdgePlanFeedbackField).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      sourceRef: undefined,
      envelope: expect.objectContaining({ key_ref: 'trusted-edge-plan-key' }),
      bodyKeyGrants: undefined,
      text: 'Needs one more proof step.',
      aad: { purpose: 'plan-feedback-body' },
    });
    expect(sendAck).toHaveBeenCalledWith(
      expect.any(Object),
      'plan-encrypt-field-req',
      'ok',
      undefined,
      expect.objectContaining({
        field: expect.objectContaining({
          schema: 'viewport.plan_feedback_field_encrypted/v1',
          ciphertext: 'encrypted-comment',
        }),
      }),
    );
  });

  it('decrypts review fields with the trusted-edge plan key', async () => {
    const sendAck = vi.fn();
    vi.mocked(decryptTrustedEdgePlanFeedbackField).mockResolvedValue({
      text: 'Needs one more proof step.',
      textSha256: 'sha256:comment',
      keyRef: 'trusted-edge-plan-key',
    });
    const handlers = createWsCommandHandlers({
      daemon: createDaemon(),
      sendAck,
      getOrCreateBuffer: (() => ({
        getAll: () => [],
        getReplayWindow: () => ({ entries: [] }),
      })) as any,
    });

    await handlers['trusted-edge-plan-decrypt-field'](createClient(), {
      type: 'trusted-edge-plan-decrypt-field',
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      bodyEncryption: {
        schema: 'viewport.plan_body_encrypted/v1',
        algorithm: 'AES-GCM-256',
        key_ref: 'trusted-edge-plan-key',
        ciphertext: 'ciphertext',
        iv: 'iv',
        tag: 'tag',
        digest: 'sha256:ciphertext',
        aad: {},
      },
      fieldEncryption: {
        schema: 'viewport.plan_feedback_field_encrypted/v1',
        algorithm: 'AES-GCM-256',
        key_ref: 'trusted-edge-plan-key',
        ciphertext: 'encrypted-comment',
        iv: 'iv',
        tag: 'tag',
        digest: 'sha256:comment',
        aad: { purpose: 'plan-feedback-body' },
      },
      capabilityToken: capabilityToken('trusted-edge-plan-decrypt-field'),
      requestId: 'plan-decrypt-field-req',
    });

    expect(decryptTrustedEdgePlanFeedbackField).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      sourceRef: undefined,
      bodyEnvelope: expect.objectContaining({ key_ref: 'trusted-edge-plan-key' }),
      fieldEnvelope: expect.objectContaining({ key_ref: 'trusted-edge-plan-key' }),
      bodyKeyGrants: undefined,
    });
    expect(sendAck).toHaveBeenCalledWith(
      expect.any(Object),
      'plan-decrypt-field-req',
      'ok',
      undefined,
      expect.objectContaining({
        field: expect.objectContaining({
          text: 'Needs one more proof step.',
          keyRef: 'trusted-edge-plan-key',
        }),
      }),
    );
  });

  it('wraps trusted-edge plan body keys for share recipients', async () => {
    const sendAck = vi.fn();
    vi.mocked(wrapTrustedEdgePlanBodyKey).mockResolvedValue([
      {
        schema: 'viewport.plan_body_key_grant/v2',
        algorithm: 'x25519-hkdf-sha256-aes-256-gcm',
        recipient_type: 'user_epoch',
        recipient_epoch_id: 'user_epoch_42_1',
        recipient_fingerprint: 'sha256:user-epoch',
        key_ref: 'trusted-edge-plan-key',
        aad: { purpose: 'plan-body-key' },
        encrypted_payload: {
          schema: 'viewport.wrapped_key_envelope/v1',
          alg: 'x25519-hkdf-sha256-aes-256-gcm',
          ephemeralPublicKeyJwk: { kty: 'OKP', crv: 'X25519', x: 'ephemeral' },
          iv: 'iv',
          ciphertext: 'wrapped-key',
          tag: 'tag',
          aadDigest: 'digest',
          createdAt: '2026-05-13T00:00:00.000Z',
        },
      },
    ]);
    const handlers = createWsCommandHandlers({
      daemon: createDaemon(),
      sendAck,
      getOrCreateBuffer: (() => ({
        getAll: () => [],
        getReplayWindow: () => ({ entries: [] }),
      })) as any,
    });

    await handlers['trusted-edge-plan-wrap-key'](createClient(), {
      type: 'trusted-edge-plan-wrap-key',
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      bodyEncryption: {
        schema: 'viewport.plan_body_encrypted/v1',
        algorithm: 'AES-GCM-256',
        key_ref: 'trusted-edge-plan-key',
        ciphertext: 'ciphertext',
        iv: 'iv',
        tag: 'tag',
        digest: 'sha256:ciphertext',
        aad: {},
      },
      recipients: [
        {
          recipient_type: 'user_epoch',
          recipient_epoch_id: 'user_epoch_42_1',
          recipient_fingerprint: 'sha256:user-epoch',
          encryption_public_key_jwk: { kty: 'OKP', crv: 'X25519', x: 'public' },
        },
      ],
      capabilityToken: capabilityToken('trusted-edge-plan-wrap-key'),
      requestId: 'plan-wrap-key-req',
    });

    expect(wrapTrustedEdgePlanBodyKey).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      sourceRef: undefined,
      envelope: expect.objectContaining({ key_ref: 'trusted-edge-plan-key' }),
      bodyKeyGrants: undefined,
      recipients: [
        {
          recipient_type: 'user_epoch',
          recipient_epoch_id: 'user_epoch_42_1',
          recipient_fingerprint: 'sha256:user-epoch',
          encryption_public_key_jwk: { kty: 'OKP', crv: 'X25519', x: 'public' },
        },
      ],
    });
    expect(sendAck).toHaveBeenCalledWith(
      expect.any(Object),
      'plan-wrap-key-req',
      'ok',
      undefined,
      expect.objectContaining({
        bodyKeyGrants: [
          expect.objectContaining({
            recipient_type: 'user_epoch',
            recipient_epoch_id: 'user_epoch_42_1',
            encrypted_payload: expect.objectContaining({
              ciphertext: 'wrapped-key',
            }),
          }),
        ],
      }),
    );
  });
});
