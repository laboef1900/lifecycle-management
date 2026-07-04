import { PrismaClient } from '@prisma/client';
import { beforeEach } from 'vitest';

export const prisma = new PrismaClient();

beforeEach(async () => {
  await prisma.session.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.clusterSettings.deleteMany({});
  await prisma.cluster.deleteMany({});
  await prisma.tenantSettings.deleteMany({});
  await prisma.authConfig.deleteMany({});
});
