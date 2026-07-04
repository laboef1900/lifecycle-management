import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { loadKey } from '../crypto/secret-box.js';
import type { Env } from '../env.js';
import { AuthConfigService, type EffectiveAuthConfig } from '../services/auth-config.js';

declare module 'fastify' {
  interface FastifyInstance {
    authConfig: AuthConfigState;
  }
}

export interface AuthConfigState {
  current: EffectiveAuthConfig;
  service: AuthConfigService;
  reload(): Promise<void>;
}

interface AuthConfigPluginOptions {
  env: Env;
}

const SINGLETON_ID = 'singleton';

/**
 * Decorates `fastify.authConfig` — the boot-time-loaded, live-reloadable view
 * of `EffectiveAuthConfig` (Task C3's DB-backed source of truth). Registered
 * after `prisma`, before `auth`/`oidc` (those plugins read `authConfig.current`
 * once D-phase wires them off raw env).
 *
 * Boot sequence:
 *  1. Build the encryption key from env (or null if unset).
 *  2. `service.load(env)` — seeds the singleton row from legacy OIDC env vars
 *     on an empty table, or upgrades an existing oidc row missing a signing
 *     secret. This throws if a stored secret can't be decrypted because the
 *     key is null (fail-safe guard below).
 *  3. Fail-safe guard: if load() couldn't decrypt (key missing/invalid while
 *     a secret is stored), force the row to mode=disabled with a *direct*
 *     prisma update that touches ONLY the `mode` column — never
 *     `service.update()`, which would try to re-encrypt secrets using a key
 *     we don't have, and never clearing `clientSecretEnc`/`signingSecretEnc`,
 *     since a missing/misconfigured key may be transient and the stored
 *     ciphertext is the only copy of an externally-sourced client secret.
 *     Log loudly, then hand-build the effective config from the (re-fetched)
 *     row without decrypting, instead of calling service.load()/toEffective()
 *     again — those would throw the exact same error again since the
 *     ciphertext is still there by design.
 *  4. Break-glass: if `RECOVERY_DISABLE_AUTH` is set, force mode=disabled the
 *     same direct way, warn loudly, and reload.
 */
const authConfigPlugin: FastifyPluginAsync<AuthConfigPluginOptions> = async (fastify, { env }) => {
  const key = env.CONFIG_ENCRYPTION_KEY ? loadKey(env.CONFIG_ENCRYPTION_KEY) : null;
  const service = new AuthConfigService(fastify.prisma, key);

  let current: EffectiveAuthConfig;
  try {
    current = await service.load(env);
  } catch (err) {
    // The only expected failure mode here is the decrypt/encrypt guard in
    // AuthConfigService throwing because CONFIG_ENCRYPTION_KEY is missing
    // while a stored row needs it (typically mode==='oidc' with a signing
    // secret already set). Fail safe rather than crash the whole server.
    if (!(err instanceof Error) || !err.message.includes('CONFIG_ENCRYPTION_KEY')) {
      throw err;
    }
    fastify.log.error(
      { err },
      'AuthConfig could not be decrypted (CONFIG_ENCRYPTION_KEY missing or invalid) while a ' +
        'secret is stored; forcing mode=disabled to fail safe instead of crashing. The stored ' +
        'encrypted secret(s) are left intact — this may be a transient key misconfiguration, ' +
        'and once CONFIG_ENCRYPTION_KEY is fixed the next boot will decrypt and re-enable oidc.',
    );
    // Force mode ONLY — never null out clientSecretEnc/signingSecretEnc here.
    // toEffective() would decrypt whatever secret columns are populated
    // unconditionally regardless of mode, so calling service.load()/
    // toEffective() again below would throw the exact same error — but that
    // is fine, because we deliberately do NOT call them again. We build
    // `current` by hand from the row `update()` just returned instead.
    const row = await fastify.prisma.authConfig.update({
      where: { id: SINGLETON_ID },
      data: { mode: 'disabled' },
    });
    current = {
      mode: 'disabled',
      issuerUrl: row.issuerUrl,
      clientId: row.clientId,
      clientSecret: null,
      signingSecret: null,
      appBaseUrl: row.appBaseUrl,
      scopes: row.scopes,
      roleClaim: row.roleClaim,
      adminValues: row.adminValues,
      defaultRole: row.defaultRole === 'viewer' ? 'viewer' : 'admin',
      allowedEmailDomains: row.allowedEmailDomains,
      allowedEmails: row.allowedEmails,
      sessionTtlHours: row.sessionTtlHours,
      allowInsecure: row.allowInsecure,
    };
  }

  if (env.RECOVERY_DISABLE_AUTH) {
    fastify.log.warn(
      'RECOVERY_DISABLE_AUTH=true: forcing AuthConfig mode=disabled (break-glass override). ' +
        'Remove this env var once access is restored via the settings UI.',
    );
    await fastify.prisma.authConfig.update({
      where: { id: SINGLETON_ID },
      data: { mode: 'disabled' },
    });
    current = await service.load(env);
  }

  const state: AuthConfigState = {
    current,
    service,
    async reload() {
      state.current = await service.load(env);
    },
  };

  fastify.decorate('authConfig', state);
};

export default fp(authConfigPlugin, { name: 'auth-config', dependencies: ['prisma'] });
