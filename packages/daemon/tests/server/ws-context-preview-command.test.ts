import { describe, expect, it, vi } from 'vitest';
import type { ConnectedClient } from '../../src/server/hello-builder.js';

vi.mock('../../src/server/context-preview-service.js', () => ({
  previewContextCandidateForTrustedEdge: vi.fn(),
}));

import { createWsCommandHandlers } from '../../src/server/ws-command-handlers.js';
import { previewContextCandidateForTrustedEdge } from '../../src/server/context-preview-service.js';

function createClient(): ConnectedClient {
  return {
    send: vi.fn(),
    subscriptions: new Set(),
    watchedDiscoveredSessions: new Set(),
    pendingBytes: 0,
  };
}

describe('context-candidate-preview websocket command', () => {
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
      daemon: {} as any,
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

  it('returns a structured error when the trusted edge cannot preview the candidate', async () => {
    const sendAck = vi.fn();
    vi.mocked(previewContextCandidateForTrustedEdge).mockRejectedValue(
      new Error('Context candidate is not available on this trusted edge.'),
    );
    const handlers = createWsCommandHandlers({
      daemon: {} as any,
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
