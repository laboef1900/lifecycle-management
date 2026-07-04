import cookie from '@fastify/cookie';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import type { Env } from '../env.js';
import type { EffectiveAuthConfig } from '../services/auth-config.js';
import { UnauthenticatedError } from '../services/errors.js';
import { SessionService, type SessionUser } from '../services/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const SESSION_COOKIE = 'lcm_session';
export const SECURE_SESSION_COOKIE = '__Host-lcm_session';

/**
 * __Host- prefix binds the cookie to the origin; only valid over https.
 * Reads `appBaseUrl` off the effective (DB-backed) auth config rather than
 * env — `EffectiveAuthConfig` is the auth source of truth post-C3.
 */
export function sessionCookieName(config: Pick<EffectiveAuthConfig, 'appBaseUrl'>): string {
  return config.appBaseUrl?.startsWith('https://') === true
    ? SECURE_SESSION_COOKIE
    : SESSION_COOKIE;
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
  /**
   * No longer read inside this plugin — auth mode, cookie naming, and the
   * login-state signing secret all come from `fastify.authConfig.current`
   * (DB-backed, live-reloadable) instead of env. Kept on the options type
   * purely so `server.ts`'s existing `server.register(authPlugin, { env })`
   * call site (out of scope for this change) keeps type-checking; a later
   * cleanup that also migrates `server.ts`/`routes/auth.ts` off env can drop
   * this.
   */
  env: Env;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify) => {
  // No global secret: login-state cookies are self-signed with the in-house
  // HMAC helper (login-state-signer.ts) using
  // fastify.authConfig.current.signingSecret at request time, so the secret
  // can rotate (via the settings UI) without re-registering this plugin.
  await fastify.register(cookie);

  const sessions = new SessionService(fastify.prisma);

  fastify.decorateRequest('user', null);

  fastify.addHook('onRequest', async (request) => {
    if (fastify.authConfig.current.mode === 'disabled') {
      request.user = { ...ANONYMOUS_USER };
      return;
    }
    // Match on the router's canonical route pattern, not the raw request URL:
    // request.url is attacker-controlled and unnormalized (percent-encoding,
    // dot-segments), while routeOptions.url is the registered route string
    // find-my-way already matched against, so it can't be spoofed.
    const routePath = request.routeOptions?.url;
    if (routePath === undefined) return; // no route matched; 404 will follow
    // Health endpoints are unprefixed; the auth flow itself must stay open.
    if (!routePath.startsWith('/api/') || routePath.startsWith('/api/auth/')) return;
    const token = request.cookies[sessionCookieName(fastify.authConfig.current)];
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

export default fp(authPlugin, { name: 'auth', dependencies: ['prisma', 'auth-config'] });
