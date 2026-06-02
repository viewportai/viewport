// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import type { ObservabilityProvider } from '../interface.js';

export async function assertObservabilityProviderConformance(provider: ObservabilityProvider): Promise<void> {
  if (!provider.id) throw new Error('ObservabilityProvider.id is required');
  const result = await provider.recordSpan({
    name: 'viewport.conformance',
    startedAt: new Date(),
    attributes: { 'viewport.run_id': 'run_a' },
  });
  if (typeof result.exported !== 'boolean') throw new Error('recordSpan must return exported');
}
