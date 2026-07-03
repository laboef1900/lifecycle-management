import cookie from '@fastify/cookie';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import type { Env } from '../env.js';
import { UnauthenticatedError } from '../services/errors.js';
import { SessionService, type SessionUser } from '../services/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const SESSION_COOKIE = 'lcm_session';
export const SECURE_SESSION_COOKIE = '__Host-lcm_session';

/** __Host- prefix binds the cookie to the origin; only valid over https. */
export function sessionCookieName(env: Env): string {
  return env.APP_BASE_URL?.startsWith('https://') === true ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

/** Principal used in AUTH_MODE=disabled so downstream code sees one shape. */
export const ANONYMOUS_USER: SessionUser = {
  id: 'anonymous',
  tenantId: 'default',
  email: null,
  displayName: null,
  role: 'ADMIN',
};

export function authStartupWarnings(env: Env): string[] {
  const warnings: string[] = [];
  if (env.AUTH_MODE === 'disabled' && env.NODE_ENV === 'production') {
    warnings.push(
      'AUTH_MODE=disabled: the API is unauthenticated. Set AUTH_MODE=oidc to enable authentication.',
    );
  }
  if (
    env.AUTH_MODE === 'oidc' &&
    !env.OIDC_ROLE_CLAIM &&
    !env.OIDC_ALLOWED_EMAILS &&
    !env.OIDC_ALLOWED_EMAIL_DOMAINS
  ) {
    warnings.push(
      'AUTH_MODE=oidc with no email allowlist and no role claim: every user your IdP accepts ' +
        'gets full access. IdP-side app assignment is your only access-control boundary.',
    );
  }
  if (env.OIDC_ALLOW_INSECURE) {
    warnings.push(
      'OIDC_ALLOW_INSECURE=true: plain-http OIDC issuer allowed. Never use in production.',
    );
  }
  return warnings;
}

interface AuthPluginOptions {
  env: Env;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, { env }) => {
  await fastify.register(cookie, env.LOGIN_STATE_SECRET ? { secret: env.LOGIN_STATE_SECRET } : {});

  const sessions = new SessionService(fastify.prisma);

  fastify.decorateRequest('user', null);

  fastify.addHook('onRequest', async (request) => {
    if (env.AUTH_MODE === 'disabled') {
      request.user = ANONYMOUS_USER;
      return;
    }
    const path = request.url.split('?', 1)[0] ?? request.url;
    // Health endpoints are unprefixed; the auth flow itself must stay open.
    if (!path.startsWith('/api/') || path.startsWith('/api/auth/')) return;
    const token = request.cookies[sessionCookieName(env)];
    if (token !== undefined) {
      const user = await sessions.findUserByToken(token);
      if (user) {
        request.user = user;
        return;
      }
    }
    throw new UnauthenticatedError();
  });
};

export default fp(authPlugin, { name: 'auth', dependencies: ['prisma'] });
