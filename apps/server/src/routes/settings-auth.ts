import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { authConfigTestSchema, authConfigUpdateSchema } from '@lcm/shared';
import type { AuthConfigResponse, AuthConfigTestResult } from '@lcm/shared';

import { testDiscovery } from '../plugins/oidc.js';
import { AuthSecretDecryptError } from '../services/auth-config.js';
import { ForbiddenError, UnprocessableError } from '../services/errors.js';

interface RotateSigningSecretResponse {
  rotated: true;
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
export const settingsAuthRoutes: FastifyPluginAsync = async (fastify) => {
  const service = fastify.authConfig.service;

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
          'TEST_REQUIRED',
          'Issuer URL, client ID, and client secret are all required to enable OIDC authentication.',
        );
      }

      // Server always re-tests on enable — the UI cannot bypass this gate.
      const testResult = await testDiscovery({
        issuerUrl,
        clientId,
        clientSecret,
        allowInsecure: body.allowInsecure,
      });
      if (!testResult.ok) {
        throw new UnprocessableError(
          'TEST_REQUIRED',
          testResult.error ?? 'Connection test failed.',
        );
      }
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
};
