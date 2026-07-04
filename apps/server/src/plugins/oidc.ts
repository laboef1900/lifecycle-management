import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import * as client from 'openid-client';

import type { EffectiveAuthConfig } from '../services/auth-config.js';

declare module 'fastify' {
  interface FastifyInstance {
    oidc: OidcState;
  }
}

export interface OidcState {
  /** null until discovery succeeds; login redirects to idp_unavailable meanwhile. */
  config: client.Configuration | null;
  redirectUri: string;
  /** Mirrors AuthConfigResponse.discoveryStatus — surfaced by the settings API. */
  status: 'connected' | 'unavailable' | 'disabled';
  /** Sanitized (never contains the client secret) message from the last failed attempt. */
  lastError: string | null;
  /**
   * Resets the backoff attempt counter and immediately re-derives state from
   * the CURRENT `fastify.authConfig.current` (redirectUri included), then
   * runs a fresh discovery attempt. Called by the settings save route after
   * an auth-config update so the new config takes effect without a restart.
   */
  reconfigure(): Promise<void>;
}

/**
 * Capped exponential backoff for discovery retries: 2s, 4s, 8s, 16s, 32s,
 * then clamped at 60s. `attempt` is the post-increment failure count (1-based).
 */
export function discoveryBackoffMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
}

function computeRedirectUri(current: EffectiveAuthConfig): string {
  const base = current.appBaseUrl?.replace(/\/$/, '') ?? '';
  return `${base}/api/auth/callback`;
}

/**
 * Never let a failed-discovery log/lastError leak the client secret. Discovery
 * itself only fetches the issuer's public metadata document (no secret is
 * sent), so this is a defense-in-depth guard against an unexpected error
 * message (e.g. from a custom fetch wrapper) echoing request details.
 */
export function sanitizeDiscoveryError(err: unknown, clientSecret: string | null): string {
  const message = err instanceof Error ? err.message : 'Unknown error';
  if (clientSecret && message.includes(clientSecret)) {
    return message.split(clientSecret).join('[redacted]');
  }
  return message;
}

/**
 * Discovery runs in a background retry loop (capped backoff): the server must
 * listen immediately and /readyz must never depend on the IdP — compose gates
 * the web container on server health, so IdP-coupled readiness would deadlock
 * the whole stack at cold boot. Established sessions never touch the IdP.
 *
 * Config is read from `fastify.authConfig.current` (Task C5) rather than env
 * — the DB-backed AuthConfig singleton is the source of truth so the settings
 * UI can change it at runtime via `reconfigure()`.
 */
const oidcPlugin: FastifyPluginAsync = async (fastify) => {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let attempt = 0;

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const initial = fastify.authConfig.current;
  const state: OidcState = {
    config: null,
    redirectUri: computeRedirectUri(initial),
    status: initial.mode === 'oidc' ? 'unavailable' : 'disabled',
    lastError: null,
    reconfigure: async () => {},
  };
  fastify.decorate('oidc', state);

  const tryDiscover = async (): Promise<void> => {
    const current = fastify.authConfig.current;
    try {
      const options = current.allowInsecure
        ? { execute: [client.allowInsecureRequests] }
        : undefined;
      const config = await client.discovery(
        new URL(current.issuerUrl as string),
        current.clientId as string,
        current.clientSecret as string,
        undefined,
        options,
      );
      if (closed) return;
      state.config = config;
      state.status = 'connected';
      state.lastError = null;
      fastify.log.info({ issuer: current.issuerUrl }, 'OIDC discovery succeeded');
    } catch (err) {
      attempt += 1;
      const delayMs = discoveryBackoffMs(attempt);
      fastify.log.error(
        { err, attempt, retryInMs: delayMs },
        'OIDC discovery failed; login is unavailable until the issuer is reachable',
      );
      if (closed) return;
      state.config = null;
      state.status = 'unavailable';
      state.lastError = sanitizeDiscoveryError(err, current.clientSecret);
      timer = setTimeout(() => void tryDiscover(), delayMs);
    }
  };

  /** Reset + immediate (single) discovery attempt against the CURRENT config. */
  const reconfigure = async (): Promise<void> => {
    clearTimer();
    attempt = 0;
    const current = fastify.authConfig.current;
    state.redirectUri = computeRedirectUri(current);
    if (current.mode !== 'oidc') {
      state.status = 'disabled';
      state.config = null;
      state.lastError = null;
      return;
    }
    await tryDiscover();
  };
  state.reconfigure = reconfigure;

  if (initial.mode === 'oidc') {
    void tryDiscover();
  }

  fastify.addHook('onClose', async () => {
    closed = true;
    clearTimer();
  });
};

export default fp(oidcPlugin, { name: 'oidc', dependencies: ['auth-config'] });
