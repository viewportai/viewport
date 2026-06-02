// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import type { GuardrailProvider } from '../interface.js';

export async function assertGuardrailProviderConformance(provider: GuardrailProvider): Promise<void> {
  if (!provider.id) throw new Error('GuardrailProvider.id is required');
  const result = await provider.evaluate({
    tenantId: 'tenant_a',
    runId: 'run_a',
    content: 'hello',
    policy: {},
  });
  if (!['allow', 'warn', 'redact', 'block'].includes(result.decision)) {
    throw new Error('GuardrailProvider returned an invalid decision');
  }
}
