// `pnpm seed` runs this file directly through tsx, bypassing the Prisma CLI and
// therefore prisma.config.ts — so `.env` must be loaded here too, or
// DATABASE_URL is undefined and the pg adapter fails with a SASL error.
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

// The seeding logic lives in a side-effect-free module so an integration test
// can drive it with the Testcontainers PrismaClient (#289 regression coverage)
// without this runner firing against the dev database on import.
import { seedReferenceData } from './seed-reference-data.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

seedReferenceData(prisma)
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
