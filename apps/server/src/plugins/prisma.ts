import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

interface PrismaPluginOptions {
  prisma?: PrismaClient;
  /** Postgres connection string for the driver adapter (Prisma 7). */
  connectionString?: string;
}

const prismaPluginFn: FastifyPluginAsync<PrismaPluginOptions> = async (fastify, opts) => {
  const client =
    opts.prisma ??
    new PrismaClient({
      adapter: new PrismaPg({ connectionString: opts.connectionString }),
      log: ['warn', 'error'],
    });

  if (!opts.prisma) {
    await client.$connect();
  }

  fastify.decorate('prisma', client);

  fastify.addHook('onClose', async () => {
    if (!opts.prisma) {
      await client.$disconnect();
    }
  });
};

export const prismaPlugin = fp(prismaPluginFn, { name: 'prisma' });
