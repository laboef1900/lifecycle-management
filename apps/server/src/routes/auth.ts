import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import * as client from 'openid-client';

import { changePasswordSchema, localLoginSchema, safeRedirectPath } from '@lcm/shared';
import type { AuthMeResponse, LoginErrorCode } from '@lcm/shared';

import { sessionCookieName } from '../plugins/auth.js';
import { signLoginState, verifyLoginState } from '../plugins/login-state-signer.js';
import { LocalUserService } from '../services/local-users.js';
import { SessionService } from '../services/sessions.js';
import { UserService, isEmailAllowed } from '../services/users.js';

const LOGIN_STATE_COOKIE = 'lcm_login_state';
const LOGIN_STATE_TTL_SECONDS = 600;

interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
  /** Validated same-origin path to return to after login (see safeRedirectPath). */
  redirect?: string;
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  const sessions = new SessionService(fastify.prisma);
  const users = new UserService(fastify.prisma);
  const localUsers = new LocalUserService(fastify.prisma);
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

    // Optional deep-link return target, validated to a same-origin path and
    // persisted (tamper-proof) in the signed login-state cookie.
    const redirectQuery =
      typeof request.query === 'object' && request.query !== null
        ? (request.query as Record<string, unknown>).redirect
        : undefined;
    const redirectTarget = safeRedirectPath(redirectQuery);

    const payload: LoginState = {
      state,
      nonce,
      verifier,
      ...(redirectTarget !== null && { redirect: redirectTarget }),
    };
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
    // Return to the originally-requested deep link when one was stored (and is
    // still a valid same-origin path — re-validated as defense in depth), else /.
    return reply.redirect(safeRedirectPath(login.redirect) ?? '/');
  });

  fastify.post('/auth/local/login', { config: authRateLimit }, async (request, reply) => {
    const current = cfg();
    if (current.mode === 'disabled') return reply.code(404).send();
    const body = localLoginSchema.parse(request.body);
    const result = await localUsers.verifyLogin(body.username, body.password);
    if (!result.ok) {
      request.log.warn({ username: body.username }, 'Local login failed');
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const session = await sessions.create(result.user.id, current.sessionTtlHours);
    const base = current.appBaseUrl;
    const secure = base ? base.startsWith('https://') : request.protocol === 'https';
    reply.setCookie(sessionCookieName(current), session.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      expires: session.expiresAt,
    });
    return reply.code(204).send();
  });

  // NOTE: this route is under `/api/auth/*`, which the auth plugin's onRequest
  // gate (plugins/auth.ts) deliberately leaves open — `request.user` is NEVER
  // populated there for auth-flow routes, so "am I logged in" must be resolved
  // locally from the session cookie, exactly like /auth/me and /auth/logout do.
  fastify.post('/auth/local/password', async (request, reply) => {
    const current = cfg();
    const token = request.cookies[sessionCookieName(current)];
    const caller = token === undefined ? null : await sessions.findUserByToken(token);
    if (!caller) return reply.code(401).send({ error: 'unauthenticated' });
    const body = changePasswordSchema.parse(request.body);
    const ok = await localUsers.changeOwnPassword(
      caller.id,
      body.currentPassword,
      body.newPassword,
    );
    if (!ok) return reply.code(422).send({ error: 'invalid_credentials' });
    return reply.code(204).send();
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
    if (current.mode === 'disabled') return { authRequired: false };
    const loginMethods = {
      local: (await localUsers.enabledCount()) > 0,
      oidc: current.mode === 'oidc' && fastify.oidc.config !== null,
    };
    const token = request.cookies[sessionCookieName(current)];
    const user = token === undefined ? null : await sessions.findUserByToken(token);
    if (!user) return { authRequired: true, loginMethods };
    return {
      authRequired: true,
      loginMethods,
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    };
  });
};
