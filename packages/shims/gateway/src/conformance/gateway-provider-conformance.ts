// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GatewayCompletionRequest, GatewayProvider } from '../interface.js';

export interface GatewayProviderConformanceOptions {
  name: string;
  createProvider(baseUrl: string): GatewayProvider;
  assertCapturedRequest(captured: CapturedRequest): void;
}

export interface CapturedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export function runGatewayProviderConformance(options: GatewayProviderConformanceOptions): void {
  describe(`${options.name} GatewayProvider conformance`, () => {
    let server: http.Server;
    let baseUrl: string;
    const captured: CapturedRequest[] = [];

    beforeEach(async () => {
      captured.length = 0;
      server = http.createServer(async (req, res) => {
        const body = await readJson(req);
        captured.push({ path: req.url ?? '/', headers: req.headers, body });
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-litellm-response-cost': '0.00000123',
        });
        res.end(JSON.stringify({
          id: 'chatcmpl_conformance',
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
        }));
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    });

    it('forwards one chat completion with correlation and without leaking key in URL', async () => {
      const provider = options.createProvider(baseUrl);
      const response = await provider.chatCompletions(baseRequest());

      expect(response.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0].path).not.toContain('real-provider-key');
      expect(JSON.stringify(response)).not.toContain('real-provider-key');
      options.assertCapturedRequest(captured[0]);
    });
  });
}

function baseRequest(): GatewayCompletionRequest {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    providerKey: 'real-provider-key',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 8,
    correlation: {
      tenantId: 'tenant_a',
      workspaceId: 'workspace_a',
      runId: 'run_a',
      leaseId: 'lease_a',
      policyHash: 'sha256:policy',
      requestId: 'request_a',
      agentId: 'agent_a',
    },
  };
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
