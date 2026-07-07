import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import {
  authConfigTestSchema,
  authConfigUpdateSchema,
  createLocalUserSchema,
  localUserIdParamsSchema,
  resetPasswordSchema,
  updateLocalUserSchema,
} from '@lcm/shared';
import type {
  AuthConfigResponse,
  AuthConfigTestResult,
  LocalUserSummary,
  RotateSigningSecretResponse,
} from '@lcm/shared';

import { testDiscovery } from '../plugins/oidc.js';
import { AuthSecretDecryptError } from '../services/auth-config.js';
import { ForbiddenError, NotFoundError, UnprocessableError } from '../services/errors.js';
import { LOCAL_ISSUER, LocalUserService } from '../services/local-users.js';

export interface SettingsAuthRoutesOptions {
  /**
   * Server-side gate for the SSRF internal-address deny-list applied when a
   * discovery test/enable runs against a private/loopback/link-local issuer.
   * Derived from deployment config in `buildServer` (never from a request), so
   * an unauthenticated caller in the bootstrap window cannot disable the guard.
   */
  allowInternalIssuer: boolean;
}

/**
 * Defense in depth only: `AuthConfigService.update()` regenerates any
 * signing secret that can't be decrypted under the current key before
 * writing oidc mode (see its docstring), so a subsequent `reload()` should
 * never actually throw `AuthSecretDecryptError` here. If it somehow did
 * anyway, surface a clean 422 instead of a raw 500 — mirrors how
 * `rotateSigningSecret()` itself reports a missing key.
 */
async function reloadOrUnprocessable(fastify: FastifyInstance): Promise<void> {
  try {
    await fastify.authConfig.reload();
  } catch (err) {
    if (err instanceof AuthSecretDecryptError) {
      throw new UnprocessableError(
        'AUTH_RELOAD_FAILED',
        'Saved, but the stored auth secrets could not be reloaded — please retry.',
      );
    }
    throw err;
  }
}

/**
 * `/api/settings/auth` — admin-gated management of the OIDC/auth
 * configuration. Security-critical: secrets (`clientSecret`, `signingSecret`)
 * must never appear in any response body, and enabling oidc always re-tests
 * discovery server-side before persisting (the UI cannot bypass this).
 */
export const settingsAuthRoutes: FastifyPluginAsync<SettingsAuthRoutesOptions> = async (
  fastify,
  opts,
) => {
  const service = fastify.authConfig.service;
  const localUsers = new LocalUserService(fastify.prisma);
  const { allowInternalIssuer } = opts;

  /**
   * Bootstrap-safe admin gate: while auth is disabled there are no roles yet
   * (or no way to assign them), so every request is allowed through — the
   * settings UI itself is how an operator first turns oidc on. Once mode is
   * oidc, only an authenticated ADMIN may read or change auth settings.
   * Registered as a plugin-scoped preHandler (this file is registered as its
   * own encapsulated context in server.ts), so it applies to all four routes
   * below and nowhere else.
   */
  fastify.addHook('preHandler', async (request) => {
    if (fastify.authConfig.current.mode === 'disabled') return;
    if (request.user?.role !== 'ADMIN') {
      throw new ForbiddenError('Admin role is required to manage authentication settings.');
    }
  });

  const sanitizedView = (): AuthConfigResponse =>
    service.sanitize(
      fastify.authConfig.current,
      fastify.oidc.redirectUri,
      fastify.oidc.status,
      fastify.oidc.lastError,
    );

  fastify.get('/settings/auth', async (): Promise<AuthConfigResponse> => {
    return sanitizedView();
  });

  fastify.put('/settings/auth', async (request): Promise<AuthConfigResponse> => {
    const body = authConfigUpdateSchema.parse(request.body);
    const current = fastify.authConfig.current;

    if (body.mode === 'oidc') {
      const appBaseUrl = body.appBaseUrl !== undefined ? body.appBaseUrl : current.appBaseUrl;
      if (!appBaseUrl) {
        throw new UnprocessableError(
          'APP_BASE_URL_REQUIRED',
          'An App base URL is required to enable OIDC authentication.',
        );
      }

      // Effective (post-merge) values: an omitted field in the request keeps
      // whatever is already stored (tri-state, matches AuthConfigService.update).
      const issuerUrl = body.issuerUrl !== undefined ? body.issuerUrl : current.issuerUrl;
      const clientId = body.clientId !== undefined ? body.clientId : current.clientId;
      const clientSecret =
        body.clientSecret !== undefined ? body.clientSecret : current.clientSecret;

      if (!issuerUrl || !clientId || !clientSecret) {
        throw new UnprocessableError(
          'INCOMPLETE_OIDC_CONFIG',
          'Issuer URL, client ID, and client secret are all required to enable OIDC authentication.',
        );
      }

      // Server always re-tests on enable — the UI cannot bypass this gate.
      const testResult = await testDiscovery({
        issuerUrl,
        clientId,
        clientSecret,
        allowInsecure: body.allowInsecure,
        allowInternalIssuer,
      });
      if (!testResult.ok) {
        throw new UnprocessableError(
          'TEST_REQUIRED',
          testResult.error ?? 'Connection test failed.',
        );
      }
    }

    if (body.mode === 'local' && (await localUsers.enabledAdminCount()) === 0) {
      throw new UnprocessableError(
        'NO_LOCAL_ADMIN',
        'Create an enabled local admin account before switching to local authentication.',
      );
    }

    await service.update(body, request.user?.id ?? null);
    await reloadOrUnprocessable(fastify);
    await fastify.oidc.reconfigure();

    return sanitizedView();
  });

  fastify.post('/settings/auth/test', async (request): Promise<AuthConfigTestResult> => {
    const body = authConfigTestSchema.parse(request.body);
    const clientSecret =
      body.clientSecret !== undefined ? body.clientSecret : fastify.authConfig.current.clientSecret;

    if (clientSecret === null) {
      return { ok: false, error: 'No client secret is configured to test with.' };
    }

    return testDiscovery({
      issuerUrl: body.issuerUrl,
      clientId: body.clientId,
      clientSecret,
      allowInsecure: body.allowInsecure,
      allowInternalIssuer,
    });
  });

  fastify.post(
    '/settings/auth/rotate-signing-secret',
    async (): Promise<RotateSigningSecretResponse> => {
      await service.rotateSigningSecret();
      await reloadOrUnprocessable(fastify);
      return { rotated: true };
    },
  );

  /**
   * Fetches a `local`-issued user by id, or throws `NotFoundError`. Scoped to
   * `issuer: LOCAL_ISSUER` so this admin surface can only ever read/mutate
   * local accounts — an OIDC-issued user id passed here 404s rather than
   * being silently edited/deleted through the wrong management endpoint.
   */
  async function findLocalUserOrNotFound(id: string) {
    const target = await fastify.prisma.user.findUnique({ where: { id } });
    if (!target || target.issuer !== LOCAL_ISSUER) {
      throw new NotFoundError('LocalUser', id);
    }
    return target;
  }

  fastify.get('/settings/auth/local-users', async (): Promise<LocalUserSummary[]> => {
    return localUsers.list();
  });

  fastify.post('/settings/auth/local-users', async (request, reply): Promise<LocalUserSummary> => {
    const body = createLocalUserSchema.parse(request.body);
    const existing = await fastify.prisma.user.findUnique({
      where: { issuer_subject: { issuer: LOCAL_ISSUER, subject: body.username } },
    });
    if (existing) {
      throw new UnprocessableError('USERNAME_TAKEN', 'That username is already in use.');
    }
    const user = await localUsers.create(body);
    reply.code(201);
    return {
      id: user.id,
      username: user.subject,
      role: user.role,
      disabled: user.disabled,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  });

  fastify.patch('/settings/auth/local-users/:id', async (request, reply) => {
    const { id } = localUserIdParamsSchema.parse(request.params);
    const body = updateLocalUserSchema.parse(request.body);
    const target = await findLocalUserOrNotFound(id);

    // Guard: never leave `local` mode with zero enabled admins.
    const wouldDisableOrDemote = body.disabled === true || body.role === 'VIEWER';
    if (
      wouldDisableOrDemote &&
      fastify.authConfig.current.mode === 'local' &&
      target.role === 'ADMIN' &&
      !target.disabled &&
      (await localUsers.enabledAdminCount()) <= 1
    ) {
      throw new UnprocessableError(
        'LAST_LOCAL_ADMIN',
        'Cannot disable or demote the last enabled local admin while local authentication is active.',
      );
    }

    await localUsers.update(id, body);
    return reply.code(204).send();
  });

  fastify.post('/settings/auth/local-users/:id/reset-password', async (request, reply) => {
    const { id } = localUserIdParamsSchema.parse(request.params);
    const body = resetPasswordSchema.parse(request.body);
    await findLocalUserOrNotFound(id);
    await localUsers.resetPassword(id, body.newPassword);
    return reply.code(204).send();
  });

  fastify.delete('/settings/auth/local-users/:id', async (request, reply) => {
    const { id } = localUserIdParamsSchema.parse(request.params);
    const target = await findLocalUserOrNotFound(id);

    if (
      target.role === 'ADMIN' &&
      !target.disabled &&
      fastify.authConfig.current.mode === 'local' &&
      (await localUsers.enabledAdminCount()) <= 1
    ) {
      throw new UnprocessableError(
        'LAST_LOCAL_ADMIN',
        'Cannot delete the last enabled local admin while local authentication is active.',
      );
    }

    await localUsers.remove(id);
    return reply.code(204).send();
  });
};
