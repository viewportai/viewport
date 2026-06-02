// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import type { RunnerProvider } from '../interface.js';

export async function assertRunnerProviderConformance(provider: RunnerProvider): Promise<void> {
  if (!provider.id) throw new Error('RunnerProvider.id is required');
  const session = await provider.provision({
    tenantId: 'tenant_a',
    workspaceId: 'workspace_a',
    runId: 'run_a',
    leaseId: 'lease_a',
    env: { VIEWPORT_GATEWAY_VK: 'vk_fixture' },
    egressAllowlist: ['gateway.getviewport.test'],
  });
  if (!session.id) throw new Error('RunnerProvider.provision must return a session id');
  await provider.teardown(session.id);
}
