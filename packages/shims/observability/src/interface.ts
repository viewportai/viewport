// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

export interface ObservabilitySpan {
  traceId?: string;
  spanId?: string;
  name: string;
  startedAt: Date;
  endedAt?: Date;
  attributes: Record<string, string | number | boolean>;
}

export interface ObservabilityProvider {
  readonly id: string;
  recordSpan(span: ObservabilitySpan): Promise<{ exported: boolean }>;
}
