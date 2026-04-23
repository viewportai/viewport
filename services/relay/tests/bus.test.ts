import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { RelayBusClient } from '../src/bus.js';
import { loadConfig } from '../src/config.js';
import { RelayLogger } from '../src/logger.js';
import { RelayMetrics } from '../src/metrics.js';
import { postInternalJson } from '../src/internal-api.js';

vi.mock('../src/internal-api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/internal-api.js')>(
    '../src/internal-api.js',
  );
  return {
    ...actual,
    resolveInternalApiTlsRejectUnauthorized: () => true,
    postInternalJson: vi.fn(),
  };
});

describe('relay bus client', () => {
  function signFrame(input: {
    workspaceId: string;
    projectMachineBindingId?: string;
    machineId?: string;
    sourceRelayId: string;
    targetRelayId: string | null;
    direction: 'client_to_daemon' | 'daemon_to_clients';
    payload: string;
    issuedAtMs: number;
    key: string;
  }): string {
    const base = [
      input.workspaceId,
      input.projectMachineBindingId ?? '',
      input.machineId ?? '',
      input.sourceRelayId,
      input.targetRelayId ?? '',
      input.direction,
      String(input.issuedAtMs),
      input.payload,
    ].join('\n');
    return crypto.createHmac('sha256', input.key).update(base, 'utf8').digest('base64url');
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clamps pull waitMs and filters invalid frames', async () => {
    const now = Date.now();
    const mockedPost = vi.mocked(postInternalJson);
    mockedPost.mockResolvedValue({
      status: 200,
      json: {
        ok: true,
        frames: [
          { id: 0, workspaceId: 'w', sourceRelayId: 'relay-b', direction: 'client_to_daemon', payload: 'a' },
          {
            id: 1,
            workspaceId: 'w',
            sourceRelayId: 'relay-a',
            direction: 'client_to_daemon',
            payload: 'b',
            issuedAtMs: now - 1,
            signature: signFrame({
              workspaceId: 'w',
              sourceRelayId: 'relay-a',
              targetRelayId: null,
              direction: 'client_to_daemon',
              payload: 'b',
              issuedAtMs: now - 1,
              key: 'bus-hmac',
            }),
          },
          {
            id: 2,
            workspaceId: 'w',
            sourceRelayId: 'relay-b',
            direction: 'client_to_daemon',
            payload: 'c',
            targetRelayId: 'relay-a',
            issuedAtMs: now,
            signature: signFrame({
              workspaceId: 'w',
              sourceRelayId: 'relay-b',
              targetRelayId: 'relay-a',
              direction: 'client_to_daemon',
              payload: 'c',
              issuedAtMs: now,
              key: 'bus-hmac',
            }),
          },
        ],
      },
    });

    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_ID: 'relay-a',
      RELAY_INTERNAL_KEY: 'key',
      RELAY_BUS_ENABLED: '1',
      RELAY_BUS_HMAC_KEY: 'bus-hmac',
      RELAY_BUS_PULL_WAIT_MS: '9999',
    });
    const client = new RelayBusClient(config, new RelayLogger(5), new RelayMetrics());
    const frames = await client.pull();

    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe(2);
    const body = mockedPost.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(body?.waitMs).toBe(2000);
  });

  it('drops bus frames that exceed max relay frame bytes', async () => {
    const mockedPost = vi.mocked(postInternalJson);
    mockedPost.mockResolvedValue({
      status: 200,
      json: {
        ok: true,
        frames: [
          {
            id: 50,
            workspaceId: 'workspace_demo',
            sourceRelayId: 'relay-b',
            targetRelayId: 'relay-a',
            direction: 'client_to_daemon',
            payload: 'x'.repeat(2048),
          },
        ],
      },
    });

    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_ID: 'relay-a',
      RELAY_INTERNAL_KEY: 'key',
      RELAY_BUS_ENABLED: '1',
      RELAY_BUS_HMAC_KEY: 'bus-hmac',
      RELAY_MAX_FRAME_BYTES: '1024',
    });
    const client = new RelayBusClient(config, new RelayLogger(5), new RelayMetrics());
    const pulled = await client.pull();
    expect(pulled).toEqual([]);
  });

  it('drops bus frames explicitly targeted to a different relay', async () => {
    const mockedPost = vi.mocked(postInternalJson);
    mockedPost.mockResolvedValue({
      status: 200,
      json: {
        ok: true,
        frames: [
          {
            id: 60,
            workspaceId: 'workspace_demo',
            sourceRelayId: 'relay-b',
            targetRelayId: 'relay-c',
            direction: 'client_to_daemon',
            payload: 'payload',
          },
        ],
      },
    });

    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_ID: 'relay-a',
      RELAY_INTERNAL_KEY: 'key',
      RELAY_BUS_ENABLED: '1',
      RELAY_BUS_HMAC_KEY: 'bus-hmac',
    });
    const client = new RelayBusClient(config, new RelayLogger(5), new RelayMetrics());
    const pulled = await client.pull();
    expect(pulled).toEqual([]);
  });

  it('publishes client-to-daemon frames to targeted relay', async () => {
    const mockedPost = vi.mocked(postInternalJson);
    mockedPost.mockResolvedValue({
      status: 200,
      json: { ok: true },
    });

    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_ID: 'relay-a',
      RELAY_INTERNAL_KEY: 'key',
      RELAY_BUS_ENABLED: '1',
      RELAY_BUS_HMAC_KEY: 'bus-hmac',
    });
    const client = new RelayBusClient(config, new RelayLogger(5), new RelayMetrics());
    const ok = await client.publishClientToDaemon('workspace_demo', 'payload', 'relay-b');
    expect(ok).toBe(true);

    const body = mockedPost.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(body?.direction).toBe('client_to_daemon');
    expect(body?.targetRelayId).toBe('relay-b');
  });

  it('signs and verifies bus frames when RELAY_BUS_HMAC_KEY is configured', async () => {
    const mockedPost = vi.mocked(postInternalJson);
    mockedPost
      .mockResolvedValueOnce({
        status: 200,
        json: { ok: true },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          ok: true,
          frames: [
            {
              id: 10,
              workspaceId: 'workspace_demo',
              sourceRelayId: 'relay-b',
              targetRelayId: 'relay-a',
              direction: 'client_to_daemon',
              payload: 'payload',
              issuedAtMs: 1234,
              signature: 'invalid-signature',
            },
          ],
        },
      });

    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_ID: 'relay-a',
      RELAY_INTERNAL_KEY: 'key',
      RELAY_BUS_ENABLED: '1',
      RELAY_BUS_HMAC_KEY: 'bus-hmac',
    });
    const client = new RelayBusClient(config, new RelayLogger(5), new RelayMetrics());
    const publishOk = await client.publishClientToDaemon('workspace_demo', 'payload', 'relay-b');
    expect(publishOk).toBe(true);

    const publishBody = mockedPost.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(typeof publishBody?.signature).toBe('string');
    expect(typeof publishBody?.issuedAtMs).toBe('number');

    const pulled = await client.pull();
    expect(pulled).toEqual([]);
  });

  it('rejects stale signed bus frames outside skew window', async () => {
    const now = Date.now();
    const staleIssuedAt = now - 120_000;
    const mockedPost = vi.mocked(postInternalJson);
    mockedPost.mockResolvedValue({
      status: 200,
      json: {
        ok: true,
        frames: [
          {
            id: 11,
            workspaceId: 'workspace_demo',
            sourceRelayId: 'relay-b',
            targetRelayId: 'relay-a',
            direction: 'client_to_daemon',
            payload: 'payload',
            issuedAtMs: staleIssuedAt,
            signature: signFrame({
              workspaceId: 'workspace_demo',
              sourceRelayId: 'relay-b',
              targetRelayId: 'relay-a',
              direction: 'client_to_daemon',
              payload: 'payload',
              issuedAtMs: staleIssuedAt,
              key: 'bus-hmac',
            }),
          },
        ],
      },
    });

    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_ID: 'relay-a',
      RELAY_INTERNAL_KEY: 'key',
      RELAY_BUS_ENABLED: '1',
      RELAY_BUS_HMAC_KEY: 'bus-hmac',
      RELAY_BUS_SIGNATURE_MAX_SKEW_MS: '1000',
    });
    const client = new RelayBusClient(config, new RelayLogger(5), new RelayMetrics());
    const pulled = await client.pull();
    expect(pulled).toEqual([]);
  });

  it('rejects replayed signed bus frames with older issuedAtMs from same relay', async () => {
    const now = Date.now();
    const mockedPost = vi.mocked(postInternalJson);
    mockedPost
      .mockResolvedValueOnce({
        status: 200,
        json: {
          ok: true,
          frames: [
            {
              id: 21,
              workspaceId: 'workspace_demo',
              sourceRelayId: 'relay-b',
              targetRelayId: 'relay-a',
              direction: 'client_to_daemon',
              payload: 'first',
              issuedAtMs: now,
              signature: signFrame({
                workspaceId: 'workspace_demo',
                sourceRelayId: 'relay-b',
                targetRelayId: 'relay-a',
                direction: 'client_to_daemon',
                payload: 'first',
                issuedAtMs: now,
                key: 'bus-hmac',
              }),
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          ok: true,
          frames: [
            {
              id: 22,
              workspaceId: 'workspace_demo',
              sourceRelayId: 'relay-b',
              targetRelayId: 'relay-a',
              direction: 'client_to_daemon',
              payload: 'second',
              issuedAtMs: now - 1,
              signature: signFrame({
                workspaceId: 'workspace_demo',
                sourceRelayId: 'relay-b',
                targetRelayId: 'relay-a',
                direction: 'client_to_daemon',
                payload: 'second',
                issuedAtMs: now - 1,
                key: 'bus-hmac',
              }),
            },
          ],
        },
      });

    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_ID: 'relay-a',
      RELAY_INTERNAL_KEY: 'key',
      RELAY_BUS_ENABLED: '1',
      RELAY_BUS_HMAC_KEY: 'bus-hmac',
    });
    const client = new RelayBusClient(config, new RelayLogger(5), new RelayMetrics());

    const first = await client.pull();
    expect(first).toHaveLength(1);
    expect(first[0]?.id).toBe(21);

    const second = await client.pull();
    expect(second).toEqual([]);
  });

  it('rejects replayed signed bus frames with the same issuedAtMs and signature', async () => {
    const now = Date.now();
    const signature = signFrame({
      workspaceId: 'workspace_demo',
      sourceRelayId: 'relay-b',
      targetRelayId: 'relay-a',
      direction: 'client_to_daemon',
      payload: 'same',
      issuedAtMs: now,
      key: 'bus-hmac',
    });
    const mockedPost = vi.mocked(postInternalJson);
    mockedPost
      .mockResolvedValueOnce({
        status: 200,
        json: {
          ok: true,
          frames: [
            {
              id: 23,
              workspaceId: 'workspace_demo',
              sourceRelayId: 'relay-b',
              targetRelayId: 'relay-a',
              direction: 'client_to_daemon',
              payload: 'same',
              issuedAtMs: now,
              signature,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          ok: true,
          frames: [
            {
              id: 24,
              workspaceId: 'workspace_demo',
              sourceRelayId: 'relay-b',
              targetRelayId: 'relay-a',
              direction: 'client_to_daemon',
              payload: 'same',
              issuedAtMs: now,
              signature,
            },
          ],
        },
      });

    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_ID: 'relay-a',
      RELAY_INTERNAL_KEY: 'key',
      RELAY_BUS_ENABLED: '1',
      RELAY_BUS_HMAC_KEY: 'bus-hmac',
    });
    const client = new RelayBusClient(config, new RelayLogger(5), new RelayMetrics());

    const first = await client.pull();
    expect(first).toHaveLength(1);
    const second = await client.pull();
    expect(second).toEqual([]);
  });

  it('tracks freshness per source relay and workspace (not globally per relay)', async () => {
    const now = Date.now();
    const mockedPost = vi.mocked(postInternalJson);
    mockedPost
      .mockResolvedValueOnce({
        status: 200,
        json: {
          ok: true,
          frames: [
            {
              id: 31,
              workspaceId: 'workspace_a',
              sourceRelayId: 'relay-b',
              targetRelayId: 'relay-a',
              direction: 'client_to_daemon',
              payload: 'a',
              issuedAtMs: now,
              signature: signFrame({
                workspaceId: 'workspace_a',
                sourceRelayId: 'relay-b',
                targetRelayId: 'relay-a',
                direction: 'client_to_daemon',
                payload: 'a',
                issuedAtMs: now,
                key: 'bus-hmac',
              }),
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          ok: true,
          frames: [
            {
              id: 32,
              workspaceId: 'workspace_b',
              sourceRelayId: 'relay-b',
              targetRelayId: 'relay-a',
              direction: 'client_to_daemon',
              payload: 'b',
              issuedAtMs: now - 1,
              signature: signFrame({
                workspaceId: 'workspace_b',
                sourceRelayId: 'relay-b',
                targetRelayId: 'relay-a',
                direction: 'client_to_daemon',
                payload: 'b',
                issuedAtMs: now - 1,
                key: 'bus-hmac',
              }),
            },
          ],
        },
      });

    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://127.0.0.1:7780',
      RELAY_ID: 'relay-a',
      RELAY_INTERNAL_KEY: 'key',
      RELAY_BUS_ENABLED: '1',
      RELAY_BUS_HMAC_KEY: 'bus-hmac',
    });
    const client = new RelayBusClient(config, new RelayLogger(5), new RelayMetrics());

    const first = await client.pull();
    expect(first).toHaveLength(1);
    expect(first[0]?.workspaceId).toBe('workspace_a');

    const second = await client.pull();
    expect(second).toHaveLength(1);
    expect(second[0]?.workspaceId).toBe('workspace_b');
  });
});
