import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/daemon/vitest.config.ts',
      'packages/workflow-sdk',
      'services/relay',
    ],
  },
});
