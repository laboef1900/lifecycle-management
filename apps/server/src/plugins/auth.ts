import cookie from '@fastify/cookie';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import type { Env } from '../env.js';
import type { EffectiveAuthConfig } from '../services/auth-config.js';
import type { AuthConfigState } from './auth-config.js';
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

/** A boot-time auth finding, logged at its own level with a stable event name. */
export interface AuthStartupWarning {
  level: 'warn' | 'error';
  event: string;
  message: string;
}

/**
 * Boot-time findings reflecting the ACTUAL (config-driven) auth state —
 * `EffectiveAuthConfig` is the auth source of truth post-C3, so this reads
 * `authConfig.current` rather than raw env. `nodeEnv` is not part of that
 * config (it's the process's runtime environment, not an auth setting) so it's
 * still taken directly from `Env`.
 *
 * Takes the whole state, not just `current`, so it can compare the ENFORCED
 * mode against the STORED one. Removing the break-glass DB write (#222)
 * removed the only durable trace that auth had been force-disabled; the
 * divergence alarm below is its replacement.
 */
export function authStartupWarnings(
  state: Pick<AuthConfigState, 'current' | 'storedMode' | 'overrideCauses'>,
  nodeEnv: Env['NODE_ENV'],
): AuthStartupWarning[] {
  const { current: config, storedMode, overrideCauses } = state;
  const warnings: AuthStartupWarning[] = [];
  if (config.mode === 'disabled' && nodeEnv === 'production') {
    warnings.push({
      level: 'warn',
      event: 'auth_config.disabled_in_production',
      message:
        'Auth is disabled: the API is unauthenticated. Enable OIDC authentication via Settings ' +
        '(or AUTH_MODE=oidc on first boot) to secure it.',
    });
  }
  // Divergence alarm: enforced and stored can only disagree under an override,
  // so this has zero false positives by construction. Deliberately ungated by
  // NODE_ENV — an open API contradicting the stored configuration is an
  // incident-grade fact in every environment. Asserts on the STATE rather than
  // enumerating causes, so it also covers any future override mechanism.
  if (config.mode === 'disabled' && storedMode !== 'disabled') {
    // Reads the full cause LIST, not the `breakGlass` boolean: both overrides
    // can fire on the same boot (break-glass skips the strict-boot guard and
    // falls through to the decrypt degrade), and naming only the break-glass
    // recovery there sends the operator into a restart that degrades straight
    // back open on the still-undecryptable secret — or, under
    // AUTH_STRICT_BOOT, refuses to boot mid-incident. This is the line
    // docs/operations.md points at during an incident review, so it has to
    // stand alone. See the `overrideCause` @ai-note in auth-config.ts.
    const causes = new Set(overrideCauses);
    const decryptFailed = causes.has('secret_decrypt_failure');
    let recovery: string;
    if (causes.has('break_glass')) {
      recovery =
        'Cause: RECOVERY_DISABLE_AUTH=true. Clear it and restart to restore the stored mode.';
      if (decryptFailed) {
        recovery +=
          ' A SECOND override is also active on this boot: the stored auth secret could not be ' +
          'decrypted. Clearing RECOVERY_DISABLE_AUTH alone will NOT restore the stored mode — ' +
          'restore the correct CONFIG_ENCRYPTION_KEY as well.';
      }
    } else if (decryptFailed) {
      recovery =
        'Cause: the stored auth secret could not be decrypted. Restore CONFIG_ENCRYPTION_KEY ' +
        'and restart to restore the stored mode.';
    } else {
      // Divergence with no recorded cause: unreachable today, but the alarm
      // asserts on STATE so it survives a future override mechanism that
      // forgets to register itself in `overrideCauses`.
      recovery =
        'Cause: an in-memory override force-disabled authentication for this boot. Restart to ' +
        'restore the stored mode.';
    }
    warnings.push({
      level: 'error',
      event: 'auth_config.open_despite_configuration',
      message:
        `Authentication is DISABLED in memory while the stored configuration is '${storedMode}': ` +
        '/api is open to an anonymous ADMIN. ' +
        recovery,
    });
  }
  if (
    config.mode === 'oidc' &&
    !config.roleClaim &&
    !config.allowedEmails &&
    !config.allowedEmailDomains
  ) {
    warnings.push({
      level: 'warn',
      event: 'auth_config.oidc_no_allowlist',
      message:
        'OIDC auth is enabled with no email allowlist and no role claim: every user your IdP ' +
        'accepts gets full access. IdP-side app assignment is your only access-control boundary.',
    });
  }
  if (config.allowInsecure) {
    warnings.push({
      level: 'warn',
      event: 'auth_config.insecure_issuer_allowed',
      message:
        'Insecure OIDC issuer connections are allowed (allowInsecure): plain-http issuer allowed. ' +
        'Never use in production.',
    });
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
