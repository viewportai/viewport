// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'vitest';

import { InMemoryDurableExecutionProvider, assertDurableExecutionProviderConformance } from '../src/index.js';

describe('DurableExecutionProvider conformance', () => {
  it('passes for the reference in-memory adapter', async () => {
    await assertDurableExecutionProviderConformance(new InMemoryDurableExecutionProvider());
  });
});
