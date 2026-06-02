// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import type { SecretsProvider } from '../interface.js';

export async function assertSecretsProviderConformance(provider: SecretsProvider): Promise<void> {
  if (!provider.id) throw new Error('SecretsProvider.id is required');
  const result = await provider.materialize({
    tenantId: 'tenant_a',
    workspaceId: 'workspace_a',
    runId: 'run_a',
    leaseId: 'lease_a',
    secretRef: 'secret://tenant_a/provider/openai',
    purpose: 'llm_provider',
  });
  if (!result.value || !result.auditRef || !(result.expiresAt instanceof Date)) {
    throw new Error('SecretsProvider.materialize must return value, expiresAt, and auditRef');
  }
}
