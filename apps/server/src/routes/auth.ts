import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import * as client from 'openid-client';

import type { AuthMeResponse } from '@lcm/shared';

import type { Env } from '../env.js';
import { sessionCookieName } from '../plugins/auth.js';
import { SessionService } from '../services/sessions.js';
import { UserService, isEmailAllowed } from '../services/users.js';

const LOGIN_STATE_COOKIE = 'lcm_login_state';
const LOGIN_STATE_TTL_SECONDS = 600;

interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
}

interface AuthRoutesOptions {
  env: Env;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (fastify, { env }) => {
  const sessions = new SessionService(fastify.prisma);
  const users = new UserService(fastify.prisma);
  const secure = env.APP_BASE_URL?.startsWith('https://') === true;
  // Tighter per-IP limit: these endpoints are unauthenticated by definition
  // and the code exchange is expensive. Inert in tests (plugin not registered).
  const authRateLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  const clearLoginState = (reply: FastifyReply): void => {
    reply.clearCookie(LOGIN_STATE_COOKIE, { path: '/api/auth' });
  };

  const loginError = (reply: FastifyReply, code: string): FastifyReply =>
    reply.redirect(`/login?error=${code}`);

  fastify.get('/auth/login', { config: authRateLimit }, async (request, reply) => {
    if (env.AUTH_MODE !== 'oidc') return reply.redirect('/');
    if (!fastify.oidc.config) return loginError(reply, 'idp_unavailable');

    const expectedProtocol = new URL(env.APP_BASE_URL as string).protocol.replace(':', '');
    if (request.protocol !== expectedProtocol) {
      request.log.error(
        { requestProtocol: request.protocol, appBaseUrl: env.APP_BASE_URL },
        'APP_BASE_URL scheme mismatch — Secure cookies would be dropped; fix APP_BASE_URL',
      );
      return loginError(reply, 'scheme_mismatch');
    }

    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    const authorizationUrl = client.buildAuthorizationUrl(fastify.oidc.config, {
      redirect_uri: fastify.oidc.redirectUri,
      scope: env.OIDC_SCOPES,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    const payload: LoginState = { state, nonce, verifier };
    reply.setCookie(
      LOGIN_STATE_COOKIE,
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      {
        path: '/api/auth',
        httpOnly: true,
        sameSite: 'lax',
        secure,
        signed: true,
        maxAge: LOGIN_STATE_TTL_SECONDS,
      },
    );
    return reply.redirect(authorizationUrl.href);
  });

  fastify.get('/auth/callback', { config: authRateLimit }, async (request, reply) => {
    if (env.AUTH_MODE !== 'oidc') return reply.redirect('/');
    if (!fastify.oidc.config) {
      clearLoginState(reply);
      return loginError(reply, 'idp_unavailable');
    }

    const raw = request.cookies[LOGIN_STATE_COOKIE];
    const unsigned = raw === undefined ? null : request.unsignCookie(raw);
    clearLoginState(reply);
    if (!unsigned?.valid || unsigned.value === null) return loginError(reply, 'state_mismatch');

    let login: LoginState;
    try {
      login = JSON.parse(Buffer.from(unsigned.value, 'base64url').toString()) as LoginState;
    } catch {
      return loginError(reply, 'state_mismatch');
    }

    const currentUrl = new URL(request.url, env.APP_BASE_URL);
    if (currentUrl.searchParams.has('error')) {
      // Raw IdP error/error_description go to logs only — never echoed to the browser.
      request.log.warn(
        { idpError: currentUrl.searchParams.get('error') },
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

    if (!isEmailAllowed(email, env)) {
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
      env,
    );
    // Access/refresh tokens are deliberately discarded — only identity matters (spec non-goal).
    const session = await sessions.create(user.id, env.SESSION_TTL_HOURS);
    reply.setCookie(sessionCookieName(env), session.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      expires: session.expiresAt,
    });
    return reply.redirect('/');
  });

  fastify.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[sessionCookieName(env)];
    if (token !== undefined) await sessions.destroy(token);
    reply.clearCookie(sessionCookieName(env), { path: '/', secure });
    return reply.code(204).send();
  });

  fastify.get('/auth/me', async (request): Promise<AuthMeResponse> => {
    if (env.AUTH_MODE !== 'oidc') return { authRequired: false };
    const token = request.cookies[sessionCookieName(env)];
    const user = token === undefined ? null : await sessions.findUserByToken(token);
    if (!user) return { authRequired: true };
    return {
      authRequired: true,
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    };
  });
};
