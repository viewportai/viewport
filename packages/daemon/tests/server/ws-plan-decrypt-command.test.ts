import { describe, expect, it, vi } from 'vitest';
import type { ConnectedClient } from '../../src/server/hello-builder.js';

vi.mock('../../src/hooks/trusted-edge-plan-artifacts.js', () => ({
  decryptTrustedEdgePlanBody: vi.fn(),
  encryptTrustedEdgePlanFeedbackField: vi.fn(),
}));

import { createWsCommandHandlers } from '../../src/server/ws-command-handlers.js';
import {
  decryptTrustedEdgePlanBody,
  encryptTrustedEdgePlanFeedbackField,
} from '../../src/hooks/trusted-edge-plan-artifacts.js';

function createClient(): ConnectedClient {
  return {
    send: vi.fn(),
    subscriptions: new Set(),
    watchedDiscoveredSessions: new Set(),
    pendingBytes: 0,
  };
}

describe('trusted-edge-plan-decrypt websocket command', () => {
  it('returns decrypted plan body from the trusted edge', async () => {
    const sendAck = vi.fn();
    vi.mocked(decryptTrustedEdgePlanBody).mockResolvedValue({
      body: '## Plan\n1. Migrate safely',
      bodySha256: 'sha256:plaintext',
      keyRef: 'trusted-edge-plan-key',
    });
    const handlers = createWsCommandHandlers({
      daemon: {} as any,
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
      requestId: 'plan-decrypt-req',
    });

    expect(decryptTrustedEdgePlanBody).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      sourceRef: 'agent-hook:session-1',
      envelope: expect.objectContaining({ key_ref: 'trusted-edge-plan-key' }),
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
      daemon: {} as any,
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
      daemon: {} as any,
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
      requestId: 'plan-encrypt-field-req',
    });

    expect(encryptTrustedEdgePlanFeedbackField).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      planId: 'plan-1',
      sourceRef: undefined,
      envelope: expect.objectContaining({ key_ref: 'trusted-edge-plan-key' }),
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
});
