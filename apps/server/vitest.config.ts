import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'scripts/**/*.{test,spec}.ts'],
    globalSetup: ['vitest.global-setup.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    pool: 'forks',
    maxWorkers: 1,
    isolate: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    passWithNoTests: true,
  },
});
