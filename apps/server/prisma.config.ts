// Prisma 7 moved CLI configuration out of package.json/schema into this file.
// `dotenv/config` is imported because v7 no longer auto-loads `.env` for the
// CLI; migrate/seed need DATABASE_URL present (CI/containers set it directly).
import 'dotenv/config';

import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // `process.env` (not prisma/config's `env()`) so `prisma generate` — which
    // needs no DB URL and runs in CI before DATABASE_URL is set — doesn't throw
    // on the absent var; `env()` resolves eagerly and fails. migrate/introspect
    // still get the URL when it's present. The runtime client connects through
    // the @prisma/adapter-pg driver adapter, not this.
    url: process.env.DATABASE_URL,
  },
});
