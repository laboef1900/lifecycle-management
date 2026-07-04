import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { beforeEach } from 'vitest';

// DATABASE_URL is set by the testcontainer in vitest.global-setup.ts.
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

beforeEach(async () => {
  await prisma.session.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.clusterSettings.deleteMany({});
  await prisma.cluster.deleteMany({});
  await prisma.tenantSettings.deleteMany({});
  await prisma.authConfig.deleteMany({});
});
