import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve @lcm/shared to source, mirroring the web suite (issue #265):
      // the server integration tests otherwise resolve @lcm/shared to its
      // built dist, so a new or changed shared export is invisible until
      // `pnpm --filter @lcm/shared build` runs. The runtime image is unaffected
      // — it imports the package's dist entry as before.
      '@lcm/shared': resolve(__dirname, '../../packages/shared/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'scripts/**/*.{test,spec}.ts'],
    globalSetup: ['vitest.global-setup.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    pool: 'forks',
    maxWorkers: 1,
    // isolate:false shares module state across test files (Vitest 4 replacement
    // for singleFork). If you ever add vi.mock(), call vi.resetModules() in a
    // beforeAll — mocks will otherwise leak between files.
    isolate: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    passWithNoTests: true,
  },
});
