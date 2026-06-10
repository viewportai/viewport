import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/daemon/vitest.config.ts',
      'packages/shims/gateway/vitest.config.ts',
      'packages/shims/durable-execution',
      'packages/workflow-sdk',
      'services/relay',
    ],
  },
});
