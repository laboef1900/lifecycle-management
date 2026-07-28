import { defineConfig } from '@playwright/test';

/**
 * Smoke E2E. Assumes the dev API is reachable at http://localhost:8090 and
 * the dev DB has been seeded (`pnpm db:dev:up` + `pnpm seed`). The webServer
 * block boots Vite for the duration of the run.
 *
 * RATE_LIMIT_MAX: the whole suite runs from one IP and (as of #243's specs)
 * bursts past the API's default 300 req/min — the tail of the run then gets
 * 429s that surface as bogus login redirects and `/clusters/undefined`
 * navigations. The webServer below boots ONLY Vite (`pnpm dev` in apps/web),
 * never the Fastify API that consumes RATE_LIMIT_MAX — the API is started
 * separately in every flow — so the mitigation MUST be applied where the API
 * is launched: `RATE_LIMIT_MAX=2000 pnpm dev` from the repo root (a webServer
 * `env:` here was dead code and has been removed; #243 review).
 *
 * `retries: 0` is deliberate and stays that way now that this suite gates
 * promotion to `main` (#334): a retry would have masked the `bulk-shift-dates`
 * animation flake that #331 diagnosed instead of surfacing it. A flake here is a
 * bug in the spec or the product, not noise to be averaged out.
 */
export default defineConfig({
  testDir: './playwright',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // `forbid-skipped-reporter` escalates a skipped test to a failed run under CI —
  // the specs' `test.skip(...)` preconditions otherwise exit 0, making an
  // all-skipped run look identical to an all-passed one (#334).
  reporter: [['list'], ['./playwright/support/forbid-skipped-reporter.ts']],
  forbidOnly: Boolean(process.env.CI),
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
