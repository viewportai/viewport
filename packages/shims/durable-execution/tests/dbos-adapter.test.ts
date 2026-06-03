// Copyright 2026 ViewportAI.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'vitest';

import { DbosDurableExecutionProvider, assertDurableExecutionProviderConformance } from '../src/index.js';

const dbosSystemDatabaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL;

describe.skipIf(!dbosSystemDatabaseUrl)('DBOS DurableExecutionProvider adapter', () => {
  it('passes the shared conformance suite against Postgres-backed durable state', async () => {
    const provider = new DbosDurableExecutionProvider({
      systemDatabaseUrl: dbosSystemDatabaseUrl!,
      applicationName: `viewport-durable-conformance-${Date.now()}`,
    });

    try {
      await assertDurableExecutionProviderConformance(provider);
    } finally {
      await provider.shutdown();
    }
  }, 30_000);
});
