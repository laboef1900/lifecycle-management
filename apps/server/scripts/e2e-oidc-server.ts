/**
 * Boots a fully self-contained OIDC stack for the browser-level auth e2e
 * (apps/web/playwright-oidc): a throwaway Postgres (Testcontainers), an
 * in-process mock IdP (oauth2-mock-server, which auto-approves the authorize
 * request), and the real API server in AUTH_MODE=oidc pointed at that IdP.
 *
 * Run by Playwright's `webServer` (see playwright.oidc.config.ts). It only
 * starts listening on /readyz AFTER discovery has completed, so Playwright's
 * readiness poll doubles as a "login is ready" gate. Everything is torn down on
 * SIGTERM/SIGINT (Playwright kills the process after the run).
 *
 * Not part of the app build — a dev/test harness only.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuth2Server } from 'oauth2-mock-server';

import { parseEnv } from '../src/env.js';
import { buildServer } from '../src/server.js';

const API_PORT = 8091;
const APP_BASE_URL = 'http://localhost:5174';
const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const pg: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('lcm_e2e')
    .withUsername('lcm')
    .withPassword('lcm')
    .start();
  const databaseUrl = pg.getConnectionUri();

  const migrate = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
  if (migrate.status !== 0) throw new Error(`prisma migrate deploy failed (${migrate.status})`);

  // Minimal reference data the app expects (matches vitest.global-setup.ts).
  const seedClient = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    await seedClient.tenant.upsert({
      where: { id: 'default' },
      update: { name: 'Default' },
      create: { id: 'default', name: 'Default' },
    });
    await seedClient.metricType.upsert({
      where: { key: 'memory_gb' },
      update: { displayName: 'Memory', unit: 'GB' },
      create: { key: 'memory_gb', displayName: 'Memory', unit: 'GB' },
    });
  } finally {
    await seedClient.$disconnect();
  }

  const idp = new OAuth2Server();
  await idp.issuer.keys.generate('RS256');
  await idp.start(0, '127.0.0.1');
  const issuerUrl = idp.issuer.url as string;
  // The mock IdP auto-approves; stamp an allowed identity onto every token.
  idp.service.on('beforeTokenSigning', (token: { payload: Record<string, unknown> }) => {
    token.payload.email = 'ada@example.com';
    token.payload.name = 'Ada Admin';
  });

  const env = parseEnv({
    DATABASE_URL: databaseUrl,
    PORT: String(API_PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER_URL: issuerUrl,
    OIDC_CLIENT_ID: 'lcm-e2e',
    OIDC_CLIENT_SECRET: 'lcm-e2e-secret',
    APP_BASE_URL,
    LOGIN_STATE_SECRET: 'e2e-login-state-secret-0123456789abcdef',
    OIDC_ALLOW_INSECURE: 'true',
    CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  });

  const server = await buildServer({ env });
  if (server.authConfig.current.mode !== 'oidc') {
    throw new Error('e2e server did not enter oidc mode — check the seed env');
  }

  // Only expose /readyz once discovery has succeeded, so Playwright's readiness
  // poll guarantees the login flow will work on the first attempt.
  for (let i = 0; i < 150 && server.oidc.config === null; i += 1) await sleep(200);
  if (server.oidc.config === null)
    throw new Error('OIDC discovery did not complete against mock IdP');

  await server.listen({ port: API_PORT, host: '127.0.0.1' });
  console.log(`[e2e-oidc] ready: api=http://127.0.0.1:${API_PORT} idp=${issuerUrl}`);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => undefined);
    await idp.stop().catch(() => undefined);
    await pg.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error('[e2e-oidc] failed to start', err);
  process.exit(1);
});
