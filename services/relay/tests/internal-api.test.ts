import { EventEmitter } from 'node:events';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postInternalJson } from '../src/internal-api.js';

describe('internal api client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails fast when response body exceeds maxResponseBytes', async () => {
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
          (res as unknown as EventEmitter).emit('data', '{"ok":true,"payload":"');
          (res as unknown as EventEmitter).emit('data', 'x'.repeat(512));
          (res as unknown as EventEmitter).emit('data', '"}');
          (res as unknown as EventEmitter).emit('end');
        });
      };
      (req as unknown as { destroy: (err?: Error) => void }).destroy = (err?: Error) => {
        (req as unknown as EventEmitter).emit(
          'error',
          err ?? new Error('internal api response too large'),
        );
      };
      return req;
    });

    await expect(
      postInternalJson(
        new URL('http://relay.test/internal'),
        { hello: 'world' },
        {},
        { rejectUnauthorized: true },
        1000,
        64,
      ),
    ).rejects.toThrow('internal api response too large');
  });
});
