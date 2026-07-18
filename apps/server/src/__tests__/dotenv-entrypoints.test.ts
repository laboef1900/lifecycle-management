import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Every process started directly from `apps/server` reads its configuration
 * from `apps/server/.env` (README "Run locally for development"). dotenv
 * resolves `.env` relative to the working directory and does NOT walk up, so
 * each standalone entrypoint has to import 'dotenv/config' itself — `pnpm seed`
 * runs `tsx prisma/seed.ts` directly and never loads prisma.config.ts.
 * Without the import, DATABASE_URL is undefined and the pg adapter fails with
 * "SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string".
 */
const ENTRYPOINTS = ['src/index.ts', 'prisma.config.ts', 'prisma/seed.ts'];

describe('standalone entrypoints', () => {
  it.each(ENTRYPOINTS)('%s loads .env via dotenv/config', async (relativePath) => {
    const source = await readFile(path.join(serverRoot, relativePath), 'utf8');

    expect(source).toMatch(/^import 'dotenv\/config';$/m);
  });
});
