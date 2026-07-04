import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import * as client from 'openid-client';

import type { Env } from '../env.js';

declare module 'fastify' {
  interface FastifyInstance {
    oidc: OidcState;
  }
}

export interface OidcState {
  /** null until discovery succeeds; login redirects to idp_unavailable meanwhile. */
  config: client.Configuration | null;
  redirectUri: string;
}

interface OidcPluginOptions {
  env: Env;
}

/**
 * Capped exponential backoff for discovery retries: 2s, 4s, 8s, 16s, 32s,
 * then clamped at 60s. `attempt` is the post-increment failure count (1-based).
 */
export function discoveryBackoffMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
}

/**
 * Discovery runs in a background retry loop (capped backoff): the server must
 * listen immediately and /readyz must never depend on the IdP — compose gates
 * the web container on server health, so IdP-coupled readiness would deadlock
 * the whole stack at cold boot. Established sessions never touch the IdP.
 */
const oidcPlugin: FastifyPluginAsync<OidcPluginOptions> = async (fastify, { env }) => {
  const base = env.APP_BASE_URL?.replace(/\/$/, '') ?? '';
  const state: OidcState = { config: null, redirectUri: `${base}/api/auth/callback` };
  fastify.decorate('oidc', state);

  if (env.AUTH_MODE !== 'oidc') return;

  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let attempt = 0;

  const tryDiscover = async (): Promise<void> => {
    try {
      const options = env.OIDC_ALLOW_INSECURE
        ? { execute: [client.allowInsecureRequests] }
        : undefined;
      const config = await client.discovery(
        new URL(env.OIDC_ISSUER_URL as string),
        env.OIDC_CLIENT_ID as string,
        env.OIDC_CLIENT_SECRET as string,
        undefined,
        options,
      );
      if (!closed) {
        state.config = config;
        fastify.log.info({ issuer: env.OIDC_ISSUER_URL }, 'OIDC discovery succeeded');
      }
    } catch (err) {
      attempt += 1;
      const delayMs = discoveryBackoffMs(attempt);
      fastify.log.error(
        { err, attempt, retryInMs: delayMs },
        'OIDC discovery failed; login is unavailable until the issuer is reachable',
      );
      if (!closed) {
        timer = setTimeout(() => void tryDiscover(), delayMs);
      }
    }
  };

  void tryDiscover();

  fastify.addHook('onClose', async () => {
    closed = true;
    if (timer) clearTimeout(timer);
  });
};

export default fp(oidcPlugin, { name: 'oidc' });
