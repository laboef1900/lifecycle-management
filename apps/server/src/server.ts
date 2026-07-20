import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import underPressure from '@fastify/under-pressure';
import type { PrismaClient } from '@prisma/client';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import type { Env } from './env.js';
import { authConfigPlugin } from './plugins/auth-config.js';
import { authPlugin, authStartupWarnings, type AuthStartupWarning } from './plugins/auth.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { idempotencyCleanupPlugin } from './plugins/idempotency-cleanup.js';
import { oidcPlugin } from './plugins/oidc.js';
import { prismaPlugin } from './plugins/prisma.js';
import { tenantContextPlugin } from './plugins/tenant-context.js';
import { vsphereSchedulerPlugin } from './plugins/vsphere-scheduler.js';
import { authRoutes } from './routes/auth.js';
import { categoriesRoutes } from './routes/categories.js';
import { clusterRoutes } from './routes/clusters.js';
import { forecastRoutes } from './routes/forecast.js';
import { healthRoutes } from './routes/health.js';
import { hostReplacementRoutes } from './routes/host-replacements.js';
import { hostRoutes } from './routes/hosts.js';
import { itemsRoutes } from './routes/items.js';
import { loadKey } from './crypto/secret-box.js';
import { settingsAuthRoutes } from './routes/settings-auth.js';
import { settingsVsphereRoutes } from './routes/settings-vsphere.js';
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
    // nginx owns anti-framing for the SPA (docker/nginx.conf); direct-API JSON needs none.
    xFrameOptions: false,
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
  await server.register(prismaPlugin, prisma ? { prisma } : { connectionString: env.DATABASE_URL });
  await server.register(authConfigPlugin, { env });

  // Config is loaded once authConfigPlugin has registered; warnings must
  // reflect the actual (config-driven) auth state, not raw env. Each finding
  // carries its own level — the enforced-vs-stored divergence alarm is an
  // `error`, not a `warn` (see authStartupWarnings).
  logAuthStartupWarnings(server.log, authStartupWarnings(server.authConfig, env.NODE_ENV));

  await server.register(authPlugin);
  await server.register(oidcPlugin);
  await server.register(tenantContextPlugin);
  await server.register(healthRoutes);
  await server.register(authRoutes, { prefix: '/api' });
  await server.register(clusterRoutes, { prefix: '/api' });
  await server.register(hostRoutes, { prefix: '/api' });
  await server.register(hostReplacementRoutes, { prefix: '/api' });
  await server.register(itemsRoutes, { prefix: '/api' });
  await server.register(categoriesRoutes, { prefix: '/api' });
  await server.register(forecastRoutes, { prefix: '/api' });
  await server.register(settingsRoutes, { prefix: '/api' });
  // The bootstrap-window /settings/auth test+enable endpoints are open to any
  // caller while auth is disabled, so the SSRF internal-address deny-list must be
  // gated on server-side config, never a request field. Internal issuer hosts are
  // permitted only outside production, or when the operator explicitly opts in via
  // OIDC_ALLOW_INSECURE (e.g. an on-prem IdP on a private network).
  await server.register(settingsAuthRoutes, {
    prefix: '/api',
    allowInternalIssuer: env.NODE_ENV !== 'production' || env.OIDC_ALLOW_INSECURE,
  });

  // vCenter connections. Note there is no `allowInternal…` option here and there
  // must never be one: a vCenter IS private, so the OIDC guard's deny-list is
  // inverted rather than reused (see services/vsphere-guard.ts). The control that
  // actually protects the credential is the password gate on trust material, not a
  // network predicate.
  await server.register(settingsVsphereRoutes, {
    prefix: '/api',
    configKey: env.CONFIG_ENCRYPTION_KEY ? loadKey(env.CONFIG_ENCRYPTION_KEY) : null,
  });

  // The background scheduler that actually polls, syncs, and snapshots vCenter
  // (#191). Never ticks in test — `runDueJobs()` is driven directly there — mirroring
  // the rate-limit/under-pressure skip above; it drains on shutdown via `onClose`.
  await server.register(vsphereSchedulerPlugin, {
    configKey: env.CONFIG_ENCRYPTION_KEY ? loadKey(env.CONFIG_ENCRYPTION_KEY) : null,
    autostart: env.NODE_ENV !== 'test',
  });

  // Purges expired idempotency-key rows (#263). Same never-ticks-in-test
  // rule as the vSphere scheduler above, for the same reason (isolate:false
  // means a stray background tick could race assertions across files).
  await server.register(idempotencyCleanupPlugin, {
    autostart: env.NODE_ENV !== 'test',
  });

  return server;
}

/**
 * Emits each boot-time auth finding at ITS OWN level — the enforced-vs-stored
 * divergence alarm is an `error`, not a `warn`. Exported (rather than inlined in
 * `buildServer`) purely so the level dispatch is directly assertable: in tests
 * `buildServer` runs with `logger: false`, so a regression to a hardcoded
 * `server.log.warn` would otherwise be invisible to the whole suite.
 */
export function logAuthStartupWarnings(
  log: FastifyBaseLogger,
  warnings: AuthStartupWarning[],
): void {
  for (const warning of warnings) {
    log[warning.level]({ event: warning.event }, warning.message);
  }
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
