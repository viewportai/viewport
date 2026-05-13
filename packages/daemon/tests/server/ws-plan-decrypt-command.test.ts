import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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

function createDaemon(): any {
  return {
    configManager: {
      getDaemonConfig: () => ({
        relay: {
          workspaceId: 'workspace-1',
          tokenIssuer: 'viewport-server',
          tokenAudience: 'viewport-relay',
          signingKeys: { v1: TEST_SIGNING_KEY },
          tokenClockSkewSec: 30,
        },
      }),
    },
  };
}

function capabilityToken(purpose: string, planId = 'plan-1'): string {
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
      iss: 'viewport-server',
      aud: 'viewport-relay',
      iat: now,
      exp: now + 60,
      jti: crypto.randomUUID(),
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
        schema: 'viewport.plan_body_key_grant/v1',
        algorithm: 'RSA-OAEP-256',
        recipient_user_id: 42,
        recipient_key_id: 'recipient-key',
        key_ref: 'trusted-edge-plan-key',
        encrypted_key: 'wrapped-key',
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
          user_id: 42,
          key_id: 'recipient-key',
          public_key_jwk: { kty: 'RSA', alg: 'RSA-OAEP-256', n: 'abc', e: 'AQAB' },
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
          user_id: 42,
          key_id: 'recipient-key',
          public_key_jwk: { kty: 'RSA', alg: 'RSA-OAEP-256', n: 'abc', e: 'AQAB' },
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
            recipient_user_id: 42,
            encrypted_key: 'wrapped-key',
          }),
        ],
      }),
    );
  });
});
