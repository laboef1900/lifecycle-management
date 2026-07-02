import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import type { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { Env } from './env.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import prismaPlugin from './plugins/prisma.js';
import tenantContextPlugin from './plugins/tenant-context.js';
import { categoriesRoutes } from './routes/categories.js';
import { clusterRoutes } from './routes/clusters.js';
import { forecastRoutes } from './routes/forecast.js';
import { healthRoutes } from './routes/health.js';
import { hostReplacementRoutes } from './routes/host-replacements.js';
import { hostRoutes } from './routes/hosts.js';
import { itemsRoutes } from './routes/items.js';
import { settingsRoutes } from './routes/settings.js';

export interface BuildServerOptions {
  env: Env;
  prisma?: PrismaClient;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { env, prisma } = options;

  const server = Fastify({
    logger: buildLoggerConfig(env),
    genReqId: () => randomUUID(),
    disableRequestLogging: env.NODE_ENV === 'test',
    trustProxy: true,
  });

  await server.register(cors, {
    origin: true, // tightened to an env-driven allowlist in Task C4
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await server.register(sensible);
  await server.register(errorHandlerPlugin);
  await server.register(tenantContextPlugin);
  await server.register(prismaPlugin, prisma ? { prisma } : {});
  await server.register(healthRoutes);
  await server.register(clusterRoutes, { prefix: '/api' });
  await server.register(hostRoutes, { prefix: '/api' });
  await server.register(hostReplacementRoutes, { prefix: '/api' });
  await server.register(itemsRoutes, { prefix: '/api' });
  await server.register(categoriesRoutes, { prefix: '/api' });
  await server.register(forecastRoutes, { prefix: '/api' });
  await server.register(settingsRoutes, { prefix: '/api' });

  return server;
}

function buildLoggerConfig(env: Env): NonNullable<FastifyServerOptions['logger']> {
  if (env.NODE_ENV === 'test') {
    return false;
  }

  if (env.NODE_ENV === 'development') {
    return {
      level: env.LOG_LEVEL,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    };
  }

  return { level: env.LOG_LEVEL };
}
