import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import underPressure from '@fastify/under-pressure';
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
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1_048_576,
  });

  await server.register(helmet, {
    // The SPA's CSP is owned by nginx (docker/nginx.conf); this is a JSON API.
    contentSecurityPolicy: false,
    // Internal deployments serve plain HTTP; an HSTS header would be misleading.
    strictTransportSecurity: false,
  });

  // Same-origin proxies (Vite dev, nginx prod) mean CORS is normally unnecessary;
  // it stays off unless an allowlist is configured.
  const corsOrigins = env.CORS_ORIGIN?.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  await server.register(cors, {
    origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  if (env.NODE_ENV !== 'test') {
    await server.register(rateLimit, {
      max: env.RATE_LIMIT_MAX,
      timeWindow: '1 minute',
    });
    await server.register(underPressure, {
      maxEventLoopDelay: 1000,
      message: 'Service under pressure',
      retryAfter: 10,
    });
  }

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
      redact: ['req.headers.authorization', 'req.headers.cookie'],
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

  return {
    level: env.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  };
}
