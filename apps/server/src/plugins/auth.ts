import cookie from '@fastify/cookie';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import type { Env } from '../env.js';
import type { EffectiveAuthConfig } from '../services/auth-config.js';
import { ForbiddenError, UnauthenticatedError } from '../services/errors.js';
import { SessionService, type SessionUser } from '../services/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const SESSION_COOKIE = 'lcm_session';
export const SECURE_SESSION_COOKIE = '__Host-lcm_session';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes that use a mutating HTTP method but are semantically read-only
 * queries, so they must NOT require the ADMIN role. `forecast/scenario` is a
 * POST only because its what-if parameters are too large/structured for a
 * query string — it computes and returns a forecast without persisting
 * anything. Matched against the router's canonical (prefixed) route pattern.
 */
const READ_ONLY_MUTATION_ROUTES = new Set(['/api/clusters/:id/forecast/scenario']);

/**
 * True when a request must be performed by an ADMIN: a mutating method on an
 * `/api` route, excluding the auth flow (`/api/auth/*`) and the read-only
 * scenario query. VIEWERs keep full read access; only ADMINs may mutate. In
 * `AUTH_MODE=disabled` the anonymous principal is ADMIN, so nothing is blocked.
 * A blanket "non-GET requires admin" rule would wrongly block the scenario
 * query, which is exactly why it is exempted explicitly.
 */
export function requiresAdmin(method: string, routePath: string): boolean {
  if (!routePath.startsWith('/api/') || routePath.startsWith('/api/auth/')) return false;
  if (!MUTATING_METHODS.has(method)) return false;
  return !READ_ONLY_MUTATION_ROUTES.has(routePath);
}

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

/**
 * Boot-time warnings reflecting the ACTUAL (config-driven) auth state —
 * `EffectiveAuthConfig` is the auth source of truth post-C3, so this reads
 * `fastify.authConfig.current` fields rather than raw env. `nodeEnv` is not
 * part of that config (it's the process's runtime environment, not an auth
 * setting) so it's still taken directly from `Env`.
 */
export function authStartupWarnings(
  config: EffectiveAuthConfig,
  nodeEnv: Env['NODE_ENV'],
): string[] {
  const warnings: string[] = [];
  if (config.mode === 'disabled' && nodeEnv === 'production') {
    warnings.push(
      'Auth is disabled: the API is unauthenticated. Enable OIDC authentication via Settings ' +
        '(or AUTH_MODE=oidc on first boot) to secure it.',
    );
  }
  if (
    config.mode === 'oidc' &&
    !config.roleClaim &&
    !config.allowedEmails &&
    !config.allowedEmailDomains
  ) {
    warnings.push(
      'OIDC auth is enabled with no email allowlist and no role claim: every user your IdP ' +
        'accepts gets full access. IdP-side app assignment is your only access-control boundary.',
    );
  }
  if (config.allowInsecure) {
    warnings.push(
      'Insecure OIDC issuer connections are allowed (allowInsecure): plain-http issuer allowed. ' +
        'Never use in production.',
    );
  }
  return warnings;
}

const authPluginFn: FastifyPluginAsync = async (fastify) => {
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

  // Authorization (role enforcement) runs after authentication above has set
  // request.user (or thrown 401). Mutating /api routes require ADMIN; VIEWERs
  // get a 403. In disabled mode the anonymous principal is ADMIN, so this is a
  // no-op. Kept separate from the settings-auth plugin's own admin gate (which
  // additionally protects its GET reads) — both throw ForbiddenError.
  fastify.addHook('onRequest', async (request) => {
    const routePath = request.routeOptions?.url;
    if (routePath === undefined) return; // no route matched; 404 will follow
    if (!requiresAdmin(request.method, routePath)) return;
    if (request.user?.role !== 'ADMIN') {
      throw new ForbiddenError('Admin role is required to perform this action.');
    }
  });
};

export const authPlugin = fp(authPluginFn, {
  name: 'auth',
  dependencies: ['prisma', 'auth-config'],
});
