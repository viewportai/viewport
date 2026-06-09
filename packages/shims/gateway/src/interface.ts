// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

export type GatewayProviderId = 'litellm' | 'bifrost' | 'native-reference' | (string & {});

export interface GatewayCorrelation {
  tenantId: string;
  workspaceId: string;
  teamId?: string;
  agentId?: string;
  runId: string;
  leaseId: string;
  policyHash: string;
  requestId: string;
}

export interface GatewayMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<Record<string, unknown>>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<Record<string, unknown>>;
}

export interface GatewayCompletionRequest {
  provider: string;
  model: string;
  providerKey: string;
  messages: GatewayMessage[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  correlation: GatewayCorrelation;
}

export interface GatewayUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GatewayCompletionResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  stream?: ReadableStream<Uint8Array> | null;
  usage?: GatewayUsage;
  costUsd?: number;
}

export interface GatewayProvider {
  readonly id: GatewayProviderId;
  chatCompletions(request: GatewayCompletionRequest): Promise<GatewayCompletionResponse>;
}

export interface GatewayProviderFactoryConfig {
  provider: GatewayProviderId;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}
