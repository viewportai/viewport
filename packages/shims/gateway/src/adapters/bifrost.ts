// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayCompletionRequest, GatewayCompletionResponse, GatewayProvider } from '../interface.js';

export interface BifrostGatewayProviderOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * Reference swap-target adapter only. Viewport does not rely on Bifrost governance,
 * virtual keys, or budgets; this adapter exists to prove the GatewayProvider
 * contract can swap executors without product changes.
 */
export class BifrostGatewayProvider implements GatewayProvider {
  readonly id = 'bifrost' as const;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BifrostGatewayProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chatCompletions(request: GatewayCompletionRequest): Promise<GatewayCompletionResponse> {
    const headers = new Headers(request.headers);
    headers.set('content-type', 'application/json');
    headers.set('authorization', `Bearer ${request.providerKey}`);
    headers.set('x-viewport-tenant-id', request.correlation.tenantId);
    headers.set('x-viewport-run-id', request.correlation.runId);
    headers.set('x-viewport-policy-hash', request.correlation.policyHash);

    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...(request.body ?? {}),
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        stream: request.stream,
      }),
    });

    const text = await response.text();
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: text.length > 0 ? safeJson(text) : null,
    };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
