import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import * as client from 'openid-client';

import type { AuthConfigTestResult } from '@lcm/shared';

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
 * True when an IP literal is loopback, private (RFC1918 / ULA), link-local
 * (incl. the 169.254.169.254 cloud metadata endpoint), carrier-grade NAT, or
 * the unspecified/"this host" address — i.e. an address the bootstrap window
 * must not be allowed to probe. Anything unrecognized (a real public IP) is
 * false. Malformed literals are treated as denied (fail closed).
 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip.toLowerCase());
  return true;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 127) return true; // "this host" / loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  if (ip === '::1' || ip === '::') return true; // loopback / unspecified
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip); // IPv4-mapped
  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique-local fc00::/7
  if (/^fe[89ab]/.test(ip)) return true; // link-local fe80::/10
  return false;
}

/**
 * SSRF guard for the bootstrap window: resolves an issuer URL's host and
 * reports whether it targets an internal address. IP literals are checked
 * directly; hostnames are resolved and denied if ANY resolved address is
 * internal. Uncertainty (unparseable URL, resolution failure) returns false so
 * discovery fails on its own with a network error rather than a misleading
 * "private address" message — no internal service is reached either way.
 */
export async function issuerTargetsInternalAddress(issuerUrl: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(issuerUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (isIP(host)) return isPrivateAddress(host);
  try {
    const results = await lookup(host, { all: true });
    return results.some((r) => isPrivateAddress(r.address));
  } catch {
    return false;
  }
}

/**
 * One-shot discovery attempt for the settings UI's "Test connection" button
 * and the save-time enable gate. Mirrors the exact `client.discovery()` call
 * shape (and `allowInsecure` handling) used by the background `tryDiscover()`
 * loop below, but is otherwise completely decoupled from it: no retry loop,
 * no shared/plugin state is read or written, and nothing is persisted. Purely
 * reports whether the given, caller-supplied config can currently discover.
 *
 * SSRF hardening: while auth is disabled the /test and save routes are open to
 * any network caller, so in production (`allowInsecure=false`) a private,
 * loopback, or link-local issuer host is rejected before any request is made,
 * closing the internal-service-probe surface. The deny-list is gated off under
 * `allowInsecure` (dev/test, which points at http://127.0.0.1 issuers).
 */
export async function testDiscovery(input: {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  allowInsecure: boolean;
}): Promise<AuthConfigTestResult> {
  if (!input.allowInsecure && (await issuerTargetsInternalAddress(input.issuerUrl))) {
    return {
      ok: false,
      error:
        'The issuer host resolves to a private, loopback, or link-local address, which is not permitted.',
    };
  }
  try {
    const options = input.allowInsecure ? { execute: [client.allowInsecureRequests] } : undefined;
    await client.discovery(
      new URL(input.issuerUrl),
      input.clientId,
      input.clientSecret,
      undefined,
      options,
    );
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: sanitizeDiscoveryError(err, input.clientSecret) };
  }
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
  /**
   * Bumped every time a new discovery attempt starts (via `tryDiscover` or
   * `reconfigure`). A `tryDiscover()` call captures the generation it was
   * started with; if that no longer matches when its `client.discovery()`
   * settles, a newer attempt has superseded it, so it must not commit state
   * or re-arm the backoff timer (prevents a slow, stale attempt from
   * clobbering a result produced by a later `reconfigure()`).
   */
  let generation = 0;

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
    const myGeneration = ++generation;
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
      // A newer attempt (from a subsequent reconfigure()) has superseded this
      // one, or the server is shutting down — do not commit this result.
      if (closed || myGeneration !== generation) return;
      state.config = config;
      state.status = 'connected';
      state.lastError = null;
      fastify.log.info({ issuer: current.issuerUrl }, 'OIDC discovery succeeded');
    } catch (err) {
      if (closed || myGeneration !== generation) return;
      attempt += 1;
      const delayMs = discoveryBackoffMs(attempt);
      // Sanitize BEFORE logging: the client secret must never reach the
      // logger, even wrapped inside the raw `err` object.
      const sanitized = sanitizeDiscoveryError(err, current.clientSecret);
      fastify.log.error(
        { error: sanitized, attempt, retryInMs: delayMs },
        'OIDC discovery failed; login is unavailable until the issuer is reachable',
      );
      state.config = null;
      state.status = 'unavailable';
      state.lastError = sanitized;
      timer = setTimeout(() => void tryDiscover(), delayMs);
    }
  };

  /** Reset + immediate (single) discovery attempt against the CURRENT config. */
  const reconfigure = async (): Promise<void> => {
    // Invalidate any in-flight tryDiscover() from before this call — including
    // the disabled-below early return, so a slow prior attempt can't clobber
    // the disabled state after we've committed to it below.
    generation += 1;
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
