// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import type { DurableExecutionProvider } from '../interface.js';

export async function assertDurableExecutionProviderConformance(provider: DurableExecutionProvider): Promise<void> {
  if (!provider.id) throw new Error('DurableExecutionProvider.id is required');
  const first = await provider.start({ workflowName: 'approval', idempotencyKey: 'wf_a', input: {} });
  const second = await provider.start({ workflowName: 'approval', idempotencyKey: 'wf_a', input: {} });
  if (first.id !== second.id) throw new Error('DurableExecutionProvider.start must be idempotent');
  await provider.signal({ workflowId: first.id, name: 'approved', payload: {} });
}
