import { PrismaClient } from '@prisma/client';
import { beforeEach } from 'vitest';

export const prisma = new PrismaClient();

beforeEach(async () => {
  await prisma.clusterSettings.deleteMany({});
  await prisma.cluster.deleteMany({});
  await prisma.tenantSettings.deleteMany({});
});
