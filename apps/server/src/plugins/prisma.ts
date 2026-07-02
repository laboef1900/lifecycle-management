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
}

const prismaPlugin: FastifyPluginAsync<PrismaPluginOptions> = async (fastify, opts) => {
  const client = opts.prisma ?? new PrismaClient({ log: ['warn', 'error'] });

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

export default fp(prismaPlugin, { name: 'prisma' });
