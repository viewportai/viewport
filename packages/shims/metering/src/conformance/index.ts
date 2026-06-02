// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import type { MeteringProvider } from '../interface.js';

export async function assertMeteringProviderConformance(provider: MeteringProvider): Promise<void> {
  if (!provider.id) throw new Error('MeteringProvider.id is required');
  const first = await provider.recordUsage({
    idempotencyKey: 'usage_a',
    tenantId: 'tenant_a',
    workspaceId: 'workspace_a',
    runId: 'run_a',
    model: 'gpt-4o-mini',
    inputTokens: 1,
    outputTokens: 1,
    occurredAt: new Date(),
  });
  const second = await provider.recordUsage({
    idempotencyKey: 'usage_a',
    tenantId: 'tenant_a',
    workspaceId: 'workspace_a',
    runId: 'run_a',
    model: 'gpt-4o-mini',
    inputTokens: 1,
    outputTokens: 1,
    occurredAt: new Date(),
  });
  if (!first.ledgerId || first.ledgerId !== second.ledgerId) {
    throw new Error('MeteringProvider must be idempotent by idempotencyKey');
  }
}
