import { defineConfig } from '@playwright/test';

/**
 * Smoke E2E. Assumes the dev API is reachable at http://localhost:8090 and
 * the dev DB has been seeded (`pnpm db:dev:up` + `pnpm seed`). The webServer
 * block boots Vite for the duration of the run.
 */
export default defineConfig({
  testDir: './playwright',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
