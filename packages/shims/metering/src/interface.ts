// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

export interface MeteringUsageEvent {
  idempotencyKey: string;
  tenantId: string;
  workspaceId: string;
  teamId?: string;
  agentId?: string;
  runId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  occurredAt: Date;
}

export interface MeteringProvider {
  readonly id: string;
  recordUsage(event: MeteringUsageEvent): Promise<{ recorded: boolean; ledgerId: string }>;
}
