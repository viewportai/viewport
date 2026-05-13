import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedClient } from '../../src/server/hello-builder.js';

vi.mock('../../src/server/context-preview-service.js', () => ({
  previewContextCandidateForTrustedEdge: vi.fn(),
}));

vi.mock('../../src/context/local-edge-store.js', () => ({
  resolveContextBundle: vi.fn(),
}));

import { createWsCommandHandlers } from '../../src/server/ws-command-handlers.js';
import { previewContextCandidateForTrustedEdge } from '../../src/server/context-preview-service.js';
import { resolveContextBundle } from '../../src/context/local-edge-store.js';

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

function capabilityToken(claims: Record<string, unknown>): string {
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
      iss: 'viewport-server',
      aud: 'viewport-relay',
      iat: now,
      exp: now + 60,
      jti: crypto.randomUUID(),
      ...claims,
    }),
    'utf8',
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', TEST_SIGNING_KEY)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('context-candidate-preview websocket command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns preview plaintext and proof over the existing command channel', async () => {
    const sendAck = vi.fn();
    vi.mocked(previewContextCandidateForTrustedEdge).mockResolvedValue({
      candidate: {
        candidateId: 'candidate-1',
        proposalEventId: 'event-1',
        payloadDigest: 'digest-1',
        title: 'Roses incident note',
        body: 'Keep the rose context scoped to the workspace.',
        source: 'web://vault-detail',
        status: 'candidate',
        actorName: 'bob-vps',
        previewProof: {
          ok: true,
          previewProofId: 'proof-1',
          expiresAt: '2026-05-13T01:02:03.000Z',
          workspaceId: 'workspace-1',
        },
      },
      previewProof: {
        ok: true,
        previewProofId: 'proof-1',
        expiresAt: '2026-05-13T01:02:03.000Z',
        workspaceId: 'workspace-1',
      },
    });

    const handlers = createWsCommandHandlers({
      daemon: createDaemon(),
      sendAck,
      getOrCreateBuffer: (() => ({
        getAll: () => [],
        getReplayWindow: () => ({ entries: [] }),
      })) as any,
    });

    await handlers['context-candidate-preview'](createClient(), {
      type: 'context-candidate-preview',
      contextResourceId: 'ctx-1',
      workspaceId: 'workspace-1',
      actorName: 'bob-vps',
      candidateEventId: 'event-1',
      capabilityToken: capabilityToken({
        purpose: 'context-candidate-preview',
        contextResourceId: 'ctx-1',
        candidateEventId: 'event-1',
      }),
      requestId: 'preview-req',
    });

    expect(previewContextCandidateForTrustedEdge).toHaveBeenCalledWith({
      contextResourceId: 'ctx-1',
      workspaceId: 'workspace-1',
      actorName: 'bob-vps',
      candidateEventId: 'event-1',
      payloadDigest: undefined,
      passphrase: undefined,
      recoveryCode: undefined,
    });
    expect(sendAck).toHaveBeenCalledWith(
      expect.any(Object),
      'preview-req',
      'ok',
      undefined,
      expect.objectContaining({
        candidate: expect.objectContaining({
          title: 'Roses incident note',
          body: 'Keep the rose context scoped to the workspace.',
          previewProof: expect.objectContaining({ previewProofId: 'proof-1' }),
        }),
      }),
    );
  });

  it('rejects candidate-specific preview commands without matching scoped capability claims', async () => {
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: createDaemon(),
      sendAck,
      getOrCreateBuffer: (() => ({
        getAll: () => [],
        getReplayWindow: () => ({ entries: [] }),
      })) as any,
    });

    await handlers['context-candidate-preview'](createClient(), {
      type: 'context-candidate-preview',
      contextResourceId: 'ctx-1',
      workspaceId: 'workspace-1',
      actorName: 'bob-vps',
      candidateEventId: 'event-1',
      capabilityToken: capabilityToken({
        purpose: 'context-candidate-preview',
        contextResourceId: 'ctx-1',
      }),
      requestId: 'preview-req',
    });

    expect(previewContextCandidateForTrustedEdge).not.toHaveBeenCalled();
    expect(sendAck).toHaveBeenCalledWith(
      expect.any(Object),
      'preview-req',
      'error',
      'Trusted-edge command capability candidateEventId mismatch.',
      { errorCode: 'INVALID_INPUT' },
    );
  });

  it('returns a structured error when the trusted edge cannot preview the candidate', async () => {
    const sendAck = vi.fn();
    vi.mocked(previewContextCandidateForTrustedEdge).mockRejectedValue(
      new Error('Context candidate is not available on this trusted edge.'),
    );
    const handlers = createWsCommandHandlers({
      daemon: createDaemon(),
      sendAck,
      getOrCreateBuffer: (() => ({
        getAll: () => [],
        getReplayWindow: () => ({ entries: [] }),
      })) as any,
    });

    await handlers['context-candidate-preview'](createClient(), {
      type: 'context-candidate-preview',
      contextResourceId: 'ctx-1',
      workspaceId: 'workspace-1',
      actorName: 'bob-vps',
      payloadDigest: 'digest-1',
      capabilityToken: capabilityToken({
        purpose: 'context-candidate-preview',
        contextResourceId: 'ctx-1',
        payloadDigest: 'digest-1',
      }),
      requestId: 'preview-req',
    });

    expect(sendAck).toHaveBeenCalledWith(
      expect.any(Object),
      'preview-req',
      'error',
      'Context candidate is not available on this trusted edge.',
      { errorCode: 'INVALID_INPUT' },
    );
  });
});

describe('context-resolve websocket command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns resolved context over the encrypted command channel', async () => {
    const sendAck = vi.fn();
    vi.mocked(resolveContextBundle).mockResolvedValue({
      manifest: {
        schemaVersion: 'viewport.context_bundle_manifest/v1',
        apiVersion: 'viewport.context_bundle_manifest/v1',
        contextResourceId: 'ctx-1',
        repoId: 'repo-1',
        actorName: 'bob-vps',
        query: 'roses',
        resolvedAt: '2026-05-13T01:02:03.000Z',
        serverSync: 'disabled',
        itemCount: 1,
        digest: 'digest-1',
        engineManifest: {},
      },
      items: [
        {
          id: 'item-1',
          title: 'Roses incident note',
          body: 'Keep the rose context scoped to the workspace.',
          source: 'web://vault-detail',
          scope: 'resource',
          trustState: 'approved',
          actorName: 'bob-vps',
          createdAt: '2026-05-13T01:02:03.000Z',
          digest: 'digest-1',
        },
      ],
    });

    const handlers = createWsCommandHandlers({
      daemon: createDaemon(),
      sendAck,
      getOrCreateBuffer: (() => ({
        getAll: () => [],
        getReplayWindow: () => ({ entries: [] }),
      })) as any,
    });

    await handlers['context-resolve'](createClient(), {
      type: 'context-resolve',
      contextResourceId: 'ctx-1',
      workspaceId: 'workspace-1',
      actorName: 'bob-vps',
      query: 'roses',
      maxItems: 25,
      includePrivate: false,
      capabilityToken: capabilityToken({
        purpose: 'context-resolve',
        contextResourceId: 'ctx-1',
      }),
      requestId: 'resolve-req',
    });

    expect(resolveContextBundle).toHaveBeenCalledWith({
      contextResourceId: 'ctx-1',
      actorName: 'bob-vps',
      query: 'roses',
      maxItems: 25,
      includePrivate: false,
      profile: undefined,
      profilePin: undefined,
      credentials: {
        passphrase: '',
        recoveryCode: '',
      },
    });
    expect(sendAck).toHaveBeenCalledWith(
      expect.any(Object),
      'resolve-req',
      'ok',
      undefined,
      expect.objectContaining({
        bundle: expect.objectContaining({
          items: [expect.objectContaining({ title: 'Roses incident note' })],
        }),
      }),
    );
  });

  it('rejects context resolve without matching scoped capability claims', async () => {
    const sendAck = vi.fn();
    const handlers = createWsCommandHandlers({
      daemon: createDaemon(),
      sendAck,
      getOrCreateBuffer: (() => ({
        getAll: () => [],
        getReplayWindow: () => ({ entries: [] }),
      })) as any,
    });

    await handlers['context-resolve'](createClient(), {
      type: 'context-resolve',
      contextResourceId: 'ctx-1',
      workspaceId: 'workspace-1',
      actorName: 'bob-vps',
      query: 'roses',
      capabilityToken: capabilityToken({
        purpose: 'context-resolve',
        contextResourceId: 'ctx-2',
      }),
      requestId: 'resolve-req',
    });

    expect(resolveContextBundle).not.toHaveBeenCalled();
    expect(sendAck).toHaveBeenCalledWith(
      expect.any(Object),
      'resolve-req',
      'error',
      'Trusted-edge command capability contextResourceId mismatch.',
      { errorCode: 'INVALID_INPUT' },
    );
  });
});
