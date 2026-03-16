import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateAdmission } from '../src/admission.js';
import { loadConfig } from '../src/config.js';

describe('relay admission', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  class FakeRequest extends EventEmitter {
    setTimeout(_ms: number, cb: () => void): this {
      setImmediate(cb);
      return this;
    }

    write(): void {}

    end(): void {}

    destroy(error: Error): void {
      this.emit('error', error);
    }
  }

  it('returns timeout failure when admission endpoint stalls', async () => {
    vi.spyOn(http, 'request').mockImplementation(() => {
      return new FakeRequest() as unknown as http.ClientRequest;
    });
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://relay.test',
      RELAY_ADMISSION_TIMEOUT_MS: '50',
    });

    const result = await validateAdmission(config, {
      token: 'token',
      role: 'client',
      workspaceId: 'workspace_demo',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(504);
    expect(result.reason?.toLowerCase()).toContain('timed out');
  });

  it('rejects admission payloads with invalid claims shape', async () => {
    vi.spyOn(http, 'request').mockImplementation((options: http.RequestOptions, callback) => {
      void options;
      const res = new EventEmitter() as unknown as http.IncomingMessage;
      (res as unknown as { statusCode?: number }).statusCode = 200;
      (res as unknown as { setEncoding: (enc: BufferEncoding) => void }).setEncoding = () =>
        undefined;
      setImmediate(() => {
        callback(res);
        (res as unknown as EventEmitter).emit('data', JSON.stringify({
          ok: true,
          claims: { scope: 'PAIRING' },
        }));
        (res as unknown as EventEmitter).emit('end');
      });
      const req = new EventEmitter() as unknown as http.ClientRequest;
      (req as unknown as { setTimeout: (ms: number, cb: () => void) => void }).setTimeout = (
        ms,
        cb,
      ) => {
        void ms;
        void cb;
      };
      (req as unknown as { write: (chunk: string) => void }).write = () => undefined;
      (req as unknown as { end: () => void }).end = () => undefined;
      (req as unknown as { destroy: (err?: Error) => void }).destroy = (err?: Error) => {
        void err;
      };
      return req;
    });
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://relay.test',
    });

    const result = await validateAdmission(config, {
      token: 'token',
      role: 'client',
      workspaceId: 'workspace_demo',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('INVALID_CLAIMS');
  });

  it('rejects admission payloads with unknown claim keys', async () => {
    vi.spyOn(http, 'request').mockImplementation((options: http.RequestOptions, callback) => {
      void options;
      const res = new EventEmitter() as unknown as http.IncomingMessage;
      (res as unknown as { statusCode?: number }).statusCode = 200;
      (res as unknown as { setEncoding: (enc: BufferEncoding) => void }).setEncoding = () =>
        undefined;
      setImmediate(() => {
        callback(res);
        (res as unknown as EventEmitter).emit(
          'data',
          JSON.stringify({
            ok: true,
            claims: {
              scope: 'runtime',
              workspaceId: 'workspace_demo',
              unknownFlag: true,
            },
          }),
        );
        (res as unknown as EventEmitter).emit('end');
      });
      const req = new EventEmitter() as unknown as http.ClientRequest;
      (req as unknown as { setTimeout: (ms: number, cb: () => void) => void }).setTimeout = (
        ms,
        cb,
      ) => {
        void ms;
        void cb;
      };
      (req as unknown as { write: (chunk: string) => void }).write = () => undefined;
      (req as unknown as { end: () => void }).end = () => undefined;
      (req as unknown as { destroy: (err?: Error) => void }).destroy = (err?: Error) => {
        void err;
      };
      return req;
    });
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://relay.test',
    });

    const result = await validateAdmission(config, {
      token: 'token',
      role: 'client',
      workspaceId: 'workspace_demo',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('INVALID_CLAIMS');
  });

  it('accepts known daemon claims including daemonIssueGeneration', async () => {
    vi.spyOn(http, 'request').mockImplementation((options: http.RequestOptions, callback) => {
      void options;
      const res = new EventEmitter() as unknown as http.IncomingMessage;
      (res as unknown as { statusCode?: number }).statusCode = 200;
      (res as unknown as { setEncoding: (enc: BufferEncoding) => void }).setEncoding = () =>
        undefined;
      setImmediate(() => {
        callback(res);
        (res as unknown as EventEmitter).emit(
          'data',
          JSON.stringify({
            ok: true,
            claims: {
              role: 'workspace-daemon',
              workspaceId: 'workspace_demo',
              e2eeProfile: 'noise-ik',
              daemonIssueGeneration: 2,
            },
          }),
        );
        (res as unknown as EventEmitter).emit('end');
      });
      const req = new EventEmitter() as unknown as http.ClientRequest;
      (req as unknown as { setTimeout: (ms: number, cb: () => void) => void }).setTimeout = (
        ms,
        cb,
      ) => {
        void ms;
        void cb;
      };
      (req as unknown as { write: (chunk: string) => void }).write = () => undefined;
      (req as unknown as { end: () => void }).end = () => undefined;
      (req as unknown as { destroy: (err?: Error) => void }).destroy = (err?: Error) => {
        void err;
      };
      return req;
    });
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://relay.test',
    });

    const result = await validateAdmission(config, {
      token: 'token',
      role: 'workspace-daemon',
      workspaceId: 'workspace_demo',
    });

    expect(result.ok).toBe(true);
    expect(result.claims?.daemonIssueGeneration).toBe(2);
  });

  it('forwards x-relay-internal-key to internal admission validation when configured', async () => {
    const seen: Array<http.RequestOptions> = [];
    vi.spyOn(http, 'request').mockImplementation((options: http.RequestOptions, callback) => {
      seen.push(options);
      const res = new EventEmitter() as unknown as http.IncomingMessage;
      (res as unknown as { statusCode?: number }).statusCode = 200;
      (res as unknown as { setEncoding: (enc: BufferEncoding) => void }).setEncoding = () =>
        undefined;
      setImmediate(() => {
        callback(res);
        (res as unknown as EventEmitter).emit(
          'data',
          JSON.stringify({
            ok: true,
            claims: {
              role: 'workspace-daemon',
              workspaceId: 'workspace_demo',
              e2eeProfile: 'noise-ik',
            },
          }),
        );
        (res as unknown as EventEmitter).emit('end');
      });
      const req = new EventEmitter() as unknown as http.ClientRequest;
      (req as unknown as { setTimeout: (ms: number, cb: () => void) => void }).setTimeout = (
        ms,
        cb,
      ) => {
        void ms;
        void cb;
      };
      (req as unknown as { write: (chunk: string) => void }).write = () => undefined;
      (req as unknown as { end: () => void }).end = () => undefined;
      (req as unknown as { destroy: (err?: Error) => void }).destroy = (err?: Error) => {
        void err;
      };
      return req;
    });
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://relay.test',
      RELAY_INTERNAL_KEY: 'integration-relay-internal-key',
    });

    const result = await validateAdmission(config, {
      token: 'token',
      role: 'workspace-daemon',
      workspaceId: 'workspace_demo',
    });

    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers).toMatchObject({
      'x-relay-internal-key': 'integration-relay-internal-key',
    });
  });

  it('rejects oversized admission responses', async () => {
    vi.spyOn(http, 'request').mockImplementation((options: http.RequestOptions, callback) => {
      void options;
      const res = new EventEmitter() as unknown as http.IncomingMessage;
      (res as unknown as { statusCode?: number }).statusCode = 200;
      (res as unknown as { setEncoding: (enc: BufferEncoding) => void }).setEncoding = () =>
        undefined;
      const req = new EventEmitter() as unknown as http.ClientRequest;
      (req as unknown as { setTimeout: (ms: number, cb: () => void) => void }).setTimeout = (
        ms,
        cb,
      ) => {
        void ms;
        void cb;
      };
      (req as unknown as { write: (chunk: string) => void }).write = () => undefined;
      (req as unknown as { end: () => void }).end = () => {
        setImmediate(() => {
          callback(res);
          (res as unknown as EventEmitter).emit('data', JSON.stringify({
            ok: true,
            claims: { scope: 'runtime' },
            padding: 'x'.repeat(1024),
          }));
          (res as unknown as EventEmitter).emit('end');
        });
      };
      (req as unknown as { destroy: (err?: Error) => void }).destroy = (err?: Error) => {
        (req as unknown as EventEmitter).emit('error', err ?? new Error('destroyed'));
      };
      return req;
    });
    const config = loadConfig({
      RELAY_TLS: '0',
      SERVER_URL: 'http://relay.test',
      RELAY_ADMISSION_MAX_RESPONSE_BYTES: '64',
    });

    const result = await validateAdmission(config, {
      token: 'token',
      role: 'client',
      workspaceId: 'workspace_demo',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ADMISSION_RESPONSE_TOO_LARGE');
  });

  it('sends mTLS cert/key material when relay server mTLS is enabled', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-admission-mtls-'));
    const certPath = path.join(tmp, 'relay-client.crt');
    const keyPath = path.join(tmp, 'relay-client.key');
    await fs.writeFile(certPath, 'test-cert');
    await fs.writeFile(keyPath, 'test-key');

    const seen: Array<http.RequestOptions> = [];
    vi.spyOn(https, 'request').mockImplementation((options: http.RequestOptions, callback) => {
      seen.push(options);
      const res = new EventEmitter() as unknown as http.IncomingMessage;
      (res as unknown as { statusCode?: number }).statusCode = 200;
      (res as unknown as { setEncoding: (enc: BufferEncoding) => void }).setEncoding = () =>
        undefined;

      setImmediate(() => {
        callback(res);
        (res as unknown as EventEmitter).emit('data', JSON.stringify({ ok: true, claims: {} }));
        (res as unknown as EventEmitter).emit('end');
      });

      const req = new EventEmitter() as unknown as http.ClientRequest;
      (req as unknown as { setTimeout: (ms: number, cb: () => void) => void }).setTimeout = (
        ms,
        cb,
      ) => {
        void ms;
        void cb;
      };
      (req as unknown as { write: (chunk: string) => void }).write = () => undefined;
      (req as unknown as { end: () => void }).end = () => undefined;
      (req as unknown as { destroy: (err?: Error) => void }).destroy = (err?: Error) => {
        void err;
      };
      return req;
    });

    const config = loadConfig({
      SERVER_URL: 'https://relay.example.test',
      RELAY_SERVER_MTLS: '1',
      RELAY_SERVER_CLIENT_CERT_PATH: certPath,
      RELAY_SERVER_CLIENT_KEY_PATH: keyPath,
      RELAY_SERVER_TLS_VERIFY: '0',
    });

    const result = await validateAdmission(config, {
      token: 'token',
      role: 'client',
      workspaceId: 'workspace_demo',
    });
    expect(result.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.cert).toBeDefined();
    expect(seen[0]?.key).toBeDefined();
  });

  it('reuses cached TLS cert/key file contents across admission calls', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-admission-mtls-cache-'));
    const certPath = path.join(tmp, 'relay-client-cache.crt');
    const keyPath = path.join(tmp, 'relay-client-cache.key');
    await fs.writeFile(certPath, 'cache-cert');
    await fs.writeFile(keyPath, 'cache-key');

    vi.spyOn(https, 'request').mockImplementation((options: http.RequestOptions, callback) => {
      void options;
      const res = new EventEmitter() as unknown as http.IncomingMessage;
      (res as unknown as { statusCode?: number }).statusCode = 200;
      (res as unknown as { setEncoding: (enc: BufferEncoding) => void }).setEncoding = () =>
        undefined;
      setImmediate(() => {
        callback(res);
        (res as unknown as EventEmitter).emit('data', JSON.stringify({ ok: true, claims: {} }));
        (res as unknown as EventEmitter).emit('end');
      });
      const req = new EventEmitter() as unknown as http.ClientRequest;
      (req as unknown as { setTimeout: (ms: number, cb: () => void) => void }).setTimeout = (
        ms,
        cb,
      ) => {
        void ms;
        void cb;
      };
      (req as unknown as { write: (chunk: string) => void }).write = () => undefined;
      (req as unknown as { end: () => void }).end = () => undefined;
      (req as unknown as { destroy: (err?: Error) => void }).destroy = (err?: Error) => {
        void err;
      };
      return req;
    });

    const readSpy = vi.spyOn(fsSync, 'readFileSync');
    const config = loadConfig({
      SERVER_URL: 'https://relay.example.test',
      RELAY_SERVER_MTLS: '1',
      RELAY_SERVER_CLIENT_CERT_PATH: certPath,
      RELAY_SERVER_CLIENT_KEY_PATH: keyPath,
      RELAY_SERVER_TLS_VERIFY: '0',
    });

    const first = await validateAdmission(config, {
      token: 'token',
      role: 'client',
      workspaceId: 'workspace_demo',
    });
    const second = await validateAdmission(config, {
      token: 'token',
      role: 'client',
      workspaceId: 'workspace_demo',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // First call reads cert+key, second call reuses cached buffers.
    expect(readSpy.mock.calls.length).toBe(2);
  });
});
