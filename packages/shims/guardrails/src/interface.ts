// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

export type GuardrailDecision = 'allow' | 'warn' | 'redact' | 'block';

export interface GuardrailRequest {
  tenantId: string;
  runId: string;
  agentId?: string;
  content: string;
  policy: Record<string, unknown>;
}

export interface GuardrailResult {
  decision: GuardrailDecision;
  content: string;
  findings: Array<{ type: string; severity: 'low' | 'medium' | 'high'; span?: [number, number] }>;
}

export interface GuardrailProvider {
  readonly id: string;
  evaluate(request: GuardrailRequest): Promise<GuardrailResult>;
}
