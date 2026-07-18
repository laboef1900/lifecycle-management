import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * `src/index.ts` and `prisma.config.ts` already load `dotenv/config`, so a dev
 * running `pnpm dev` or `prisma migrate deploy` from `apps/server` gets their
 * config out of `apps/server/.env`. dotenv resolves `.env` relative to the
 * working directory and does NOT walk up to the repo root, so an entrypoint
 * that expects its config from `apps/server/.env` has to import 'dotenv/config'
 * itself or it silently sees a different environment than its siblings. The
 * rule is scoped to those entrypoints — `scripts/e2e-oidc-server.ts` is also
 * tsx-started (by Playwright's `webServer`, not by a package.json script here)
 * and deliberately does NOT load `.env`: it provisions its own throwaway
 * Testcontainers Postgres and must not inherit the dev database URL. `pnpm seed` and
 * `pnpm --filter @lcm/server db:import-xlsx` run `tsx` on their file directly
 * and never evaluate prisma.config.ts; without the import DATABASE_URL is
 * undefined and the pg adapter fails with
 * "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string".
 *
 * This list must contain every file the `apps/server` package.json scripts hand
 * to `tsx` (or `node`) as an entry module. Note that `apps/server/.env` itself
 * is neither documented as a setup step nor shipped as an `.env.example` — the
 * README mentions it once in passing (dev port override). Closing that gap is
 * tracked separately; this guard only enforces that the entrypoints agree with
 * each other.
 */
const ENTRYPOINTS = [
  'src/index.ts',
  'prisma.config.ts',
  'prisma/seed.ts',
  'scripts/import-xlsx.ts',
];

describe('standalone entrypoints', () => {
  it.each(ENTRYPOINTS)('%s loads .env via dotenv/config', async (relativePath) => {
    const source = await readFile(path.join(serverRoot, relativePath), 'utf8');

    expect(source).toMatch(/^import 'dotenv\/config';$/m);
  });
});
