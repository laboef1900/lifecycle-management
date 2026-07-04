import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import * as client from 'openid-client';

import type { AuthMeResponse } from '@lcm/shared';

import type { Env } from '../env.js';
import { sessionCookieName } from '../plugins/auth.js';
import { signLoginState, verifyLoginState } from '../plugins/login-state-signer.js';
import { SessionService } from '../services/sessions.js';
import { UserService, isEmailAllowed } from '../services/users.js';

const LOGIN_STATE_COOKIE = 'lcm_login_state';
const LOGIN_STATE_TTL_SECONDS = 600;

interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
}

type LoginErrorCode =
  | 'login_failed'
  | 'state_mismatch'
  | 'idp_error'
  | 'access_denied'
  | 'idp_unavailable'
  | 'scheme_mismatch';

interface AuthRoutesOptions {
  /**
   * No longer read inside this plugin — auth mode, scopes, appBaseUrl,
   * session TTL, and the login-state signing secret all come from
   * `fastify.authConfig.current` (DB-backed, live-reloadable) instead of env.
   * Kept on the options type purely so `server.ts`'s existing
   * `server.register(authRoutes, { prefix: '/api', env })` call site (out of
   * scope for this change) keeps type-checking; a later cleanup that also
   * migrates `server.ts` off env can drop this.
   */
  env: Env;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (fastify) => {
  const sessions = new SessionService(fastify.prisma);
  const users = new UserService(fastify.prisma);
  // Mutable accessor: authConfig.current can be reloaded at runtime (settings
  // UI save → reconfigure()), so every request must read the CURRENT config
  // rather than a value captured once at plugin-registration time.
  const cfg = () => fastify.authConfig.current;
  // Tighter per-IP limit: these endpoints are unauthenticated by definition
  // and the code exchange is expensive. Inert in tests (plugin not registered).
  const authRateLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  const clearLoginState = (reply: FastifyReply): void => {
    reply.clearCookie(LOGIN_STATE_COOKIE, { path: '/api/auth' });
  };

  const loginError = (reply: FastifyReply, code: LoginErrorCode): FastifyReply =>
    reply.redirect(`/login?error=${code}`);

  fastify.get('/auth/login', { config: authRateLimit }, async (request, reply) => {
    const current = cfg();
    if (current.mode !== 'oidc') return reply.redirect('/');
    if (!fastify.oidc.config) return loginError(reply, 'idp_unavailable');
    if (!current.appBaseUrl) return loginError(reply, 'idp_unavailable');
    const appBaseUrl = current.appBaseUrl;

    const secure = appBaseUrl.startsWith('https://');
    const expectedProtocol = new URL(appBaseUrl).protocol.replace(':', '');
    if (request.protocol !== expectedProtocol) {
      request.log.error(
        { requestProtocol: request.protocol, appBaseUrl },
        'appBaseUrl scheme mismatch — Secure cookies would be dropped; fix the configured App base URL',
      );
      return loginError(reply, 'scheme_mismatch');
    }

    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    const authorizationUrl = client.buildAuthorizationUrl(fastify.oidc.config, {
      redirect_uri: fastify.oidc.redirectUri,
      scope: current.scopes,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    const payload: LoginState = { state, nonce, verifier };
    const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    // Signed (not encrypted) with the in-house HMAC helper — the signing
    // secret is DB-backed/rotatable, so @fastify/cookie's registration-time
    // `signed: true` (single static secret) can no longer be used.
    reply.setCookie(
      LOGIN_STATE_COOKIE,
      signLoginState(payloadEncoded, current.signingSecret as string),
      {
        path: '/api/auth',
        httpOnly: true,
        sameSite: 'lax',
        secure,
        maxAge: LOGIN_STATE_TTL_SECONDS,
      },
    );
    return reply.redirect(authorizationUrl.href);
  });

  fastify.get('/auth/callback', { config: authRateLimit }, async (request, reply) => {
    const current = cfg();
    if (current.mode !== 'oidc') {
      clearLoginState(reply);
      return reply.redirect('/');
    }
    if (!fastify.oidc.config) {
      clearLoginState(reply);
      return loginError(reply, 'idp_unavailable');
    }
    if (!current.appBaseUrl) {
      clearLoginState(reply);
      return loginError(reply, 'idp_unavailable');
    }
    const appBaseUrl = current.appBaseUrl;

    const raw = request.cookies[LOGIN_STATE_COOKIE];
    const verified =
      raw === undefined ? null : verifyLoginState(raw, current.signingSecret as string);
    clearLoginState(reply);
    if (verified === null) return loginError(reply, 'state_mismatch');

    let login: LoginState;
    try {
      login = JSON.parse(Buffer.from(verified, 'base64url').toString()) as LoginState;
    } catch {
      return loginError(reply, 'state_mismatch');
    }

    const currentUrl = new URL(request.url, appBaseUrl);
    if (currentUrl.searchParams.has('error')) {
      // Raw IdP error/error_description go to logs only — never echoed to the browser.
      request.log.warn(
        {
          idpError: currentUrl.searchParams.get('error'),
          idpErrorDescription: currentUrl.searchParams.get('error_description'),
        },
        'IdP returned an error at callback',
      );
      return loginError(reply, 'idp_error');
    }

    let tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers;
    try {
      tokens = await client.authorizationCodeGrant(fastify.oidc.config, currentUrl, {
        pkceCodeVerifier: login.verifier,
        expectedState: login.state,
        expectedNonce: login.nonce,
      });
    } catch (err) {
      request.log.warn({ err }, 'OIDC code exchange failed');
      return loginError(reply, 'login_failed');
    }

    const claims = tokens.claims();
    if (!claims) return loginError(reply, 'login_failed');
    const email = typeof claims.email === 'string' ? claims.email : undefined;

    if (!isEmailAllowed(email, current)) {
      request.log.warn({ sub: claims.sub }, 'Login rejected by email allowlist');
      return loginError(reply, 'access_denied');
    }

    const user = await users.upsertFromIdentity(
      {
        issuer: claims.iss,
        subject: claims.sub,
        ...(email !== undefined && { email }),
        ...(typeof claims.name === 'string' && { name: claims.name }),
        claims: claims as Record<string, unknown>,
      },
      current,
    );
    // Access/refresh tokens are deliberately discarded — only identity matters (spec non-goal).
    const session = await sessions.create(user.id, current.sessionTtlHours);
    const secure = appBaseUrl.startsWith('https://');
    reply.setCookie(sessionCookieName(current), session.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      expires: session.expiresAt,
    });
    return reply.redirect('/');
  });

  fastify.post('/auth/logout', async (request, reply) => {
    const current = cfg();
    const cookieName = sessionCookieName(current);
    const token = request.cookies[cookieName];
    if (token !== undefined) await sessions.destroy(token);
    const secure = current.appBaseUrl?.startsWith('https://') === true;
    reply.clearCookie(cookieName, { path: '/', secure });
    return reply.code(204).send();
  });

  fastify.get('/auth/me', async (request): Promise<AuthMeResponse> => {
    const current = cfg();
    if (current.mode !== 'oidc') return { authRequired: false };
    const token = request.cookies[sessionCookieName(current)];
    const user = token === undefined ? null : await sessions.findUserByToken(token);
    if (!user) return { authRequired: true };
    return {
      authRequired: true,
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    };
  });
};
