import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { transportFetch } from '../../src/cli/network.js';

let server: http.Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()));
  });
  server = null;
});

describe('transportFetch', () => {
  it('handles no-content responses without constructing an invalid response body', async () => {
    server = http.createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address.');

    const response = await transportFetch(`http://127.0.0.1:${address.port}/empty`, {
      method: 'POST',
      tlsVerify: '0',
    });

    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe('');
  });
});
