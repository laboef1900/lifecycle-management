import { defineConfig } from '@playwright/test';

/**
 * Browser-level OIDC auth e2e (#122). Independent of the golden-path smoke
 * suite (which runs under AUTH_MODE=disabled): a dedicated `playwright-oidc`
 * testDir and its own webServers.
 *
 * webServer[0] boots a self-contained OIDC stack (throwaway Postgres + mock IdP
 * + API server in oidc mode) via apps/server/scripts/e2e-oidc-server.ts; it only
 * answers /readyz once discovery has completed. webServer[1] is a Vite dev
 * server on :5174 whose /api proxy targets the e2e API (LCM_API_PORT=8091).
 */
export default defineConfig({
  testDir: './playwright-oidc',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5174',
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @lcm/server exec tsx scripts/e2e-oidc-server.ts',
      url: 'http://127.0.0.1:8091/readyz',
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @lcm/web exec vite --port 5174 --strictPort',
      url: 'http://localhost:5174',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { LCM_API_PORT: '8091' },
    },
  ],
});
