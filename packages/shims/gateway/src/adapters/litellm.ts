// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayCompletionRequest, GatewayCompletionResponse, GatewayProvider } from '../interface.js';

export interface LiteLlmGatewayProviderOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class LiteLlmGatewayProvider implements GatewayProvider {
  readonly id = 'litellm' as const;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LiteLlmGatewayProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chatCompletions(request: GatewayCompletionRequest): Promise<GatewayCompletionResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(request),
      body: JSON.stringify(this.body(request)),
    });

    return toGatewayResponse(response, request.stream === true);
  }

  private headers(request: GatewayCompletionRequest): Headers {
    const headers = new Headers(request.headers);
    headers.set('content-type', 'application/json');
    if (this.apiKey) {
      headers.set('authorization', `Bearer ${this.apiKey}`);
    }
    headers.set('x-viewport-tenant-id', request.correlation.tenantId);
    headers.set('x-viewport-workspace-id', request.correlation.workspaceId);
    headers.set('x-viewport-run-id', request.correlation.runId);
    headers.set('x-viewport-lease-id', request.correlation.leaseId);
    headers.set('x-viewport-agent-id', request.correlation.agentId ?? '');
    headers.set('x-viewport-policy-hash', request.correlation.policyHash);
    headers.set('x-viewport-request-id', request.correlation.requestId);
    return headers;
  }

  private body(request: GatewayCompletionRequest): Record<string, unknown> {
    return {
      ...(request.body ?? {}),
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: request.stream,
      metadata: metadata(request),
      api_key: request.providerKey,
    };
  }
}

function metadata(request: GatewayCompletionRequest): Record<string, unknown> {
  const existing = request.body?.metadata;
  const base = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};

  return {
    ...base,
    user_api_key_org_id: request.correlation.tenantId,
    user_api_key_team_id: request.correlation.teamId ?? request.correlation.workspaceId,
    user_api_key_team_alias: request.correlation.teamId ?? request.correlation.workspaceId,
    viewport_tenant_id: request.correlation.tenantId,
    viewport_workspace_id: request.correlation.workspaceId,
    viewport_team_id: request.correlation.teamId,
    viewport_agent_id: request.correlation.agentId,
    viewport_run_id: request.correlation.runId,
    viewport_lease_id: request.correlation.leaseId,
    viewport_policy_hash: request.correlation.policyHash,
    viewport_request_id: request.correlation.requestId,
  };
}

async function toGatewayResponse(response: Response, streaming: boolean): Promise<GatewayCompletionResponse> {
  if (streaming && response.body) {
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: null,
      stream: response.body,
      costUsd: costFromHeader(response.headers),
    };
  }

  const text = await response.text();
  const body = text.length > 0 ? safeJson(text) : null;
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
    usage: normalizeUsage(body),
    costUsd: costFromHeader(response.headers),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeUsage(body: unknown): GatewayCompletionResponse['usage'] {
  if (!body || typeof body !== 'object' || !('usage' in body)) return undefined;
  const usage = (body as { usage?: Record<string, unknown> }).usage;
  if (!usage) return undefined;
  const input = numberValue(usage.prompt_tokens) ?? numberValue(usage.input_tokens) ?? 0;
  const output = numberValue(usage.completion_tokens) ?? numberValue(usage.output_tokens) ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: numberValue(usage.total_tokens) ?? input + output,
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function costFromHeader(headers: Headers): number | undefined {
  const raw = headers.get('x-litellm-response-cost');
  if (!raw) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
