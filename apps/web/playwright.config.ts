import { defineConfig } from '@playwright/test';

/**
 * Smoke E2E. Assumes the dev API is reachable at http://localhost:8090 and
 * the dev DB has been seeded (`pnpm db:dev:up` + `pnpm seed`). The webServer
 * block boots Vite for the duration of the run.
 *
 * RATE_LIMIT_MAX: the whole suite runs from one IP and (as of #243's specs)
 * bursts past the API's default 300 req/min — the tail of the run then gets
 * 429s that surface as bogus login redirects and `/clusters/undefined`
 * navigations. The env below only reaches a server this config boots itself;
 * when reusing an already-running dev server (`reuseExistingServer`), start
 * it with `RATE_LIMIT_MAX=2000` too.
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
    env: { RATE_LIMIT_MAX: '2000' },
  },
});
