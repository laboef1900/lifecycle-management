import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { loadKey } from '../crypto/secret-box.js';
import type { Env } from '../env.js';
import {
  AuthConfigService,
  AuthSecretDecryptError,
  type EffectiveAuthConfig,
} from '../services/auth-config.js';

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
 *     secret. This throws `AuthSecretDecryptError` if a stored secret can't
 *     be decrypted — either the key is null, OR the key is present but wrong
 *     (rotated) / the ciphertext is corrupted (fail-safe guard below covers
 *     both).
 *  3. Fail-safe guard: if load() couldn't decrypt for ANY reason
 *     (`AuthSecretDecryptError` — key missing, key wrong, or ciphertext
 *     corrupted, while a secret is stored), force the row to mode=disabled
 *     with a *direct* prisma update that touches ONLY the `mode` column —
 *     never `service.update()`, which would try to re-encrypt secrets using
 *     a key we don't have, and never clearing
 *     `clientSecretEnc`/`signingSecretEnc`, since the stored ciphertext may
 *     still be recoverable (key fixed, or rolled back to the previous one)
 *     and is the only copy of an externally-sourced client secret. Log
 *     loudly, then hand-build the effective config from the (re-fetched) row
 *     without decrypting, instead of calling service.load()/toEffective()
 *     again — those would throw the exact same error again since the
 *     ciphertext is still there by design.
 *  4. Break-glass: if `RECOVERY_DISABLE_AUTH` is set, force mode=disabled the
 *     same direct way, warn loudly, and reload — but only re-run
 *     `service.load()` when step 2 actually succeeded at decrypting (a valid
 *     key and no prior decrypt failure); otherwise reusing `service.load()`
 *     here would immediately hit the same undecryptable row and crash boot
 *     outside the try/catch above, so `current` is instead updated in memory.
 */
const authConfigPlugin: FastifyPluginAsync<AuthConfigPluginOptions> = async (fastify, { env }) => {
  const key = env.CONFIG_ENCRYPTION_KEY ? loadKey(env.CONFIG_ENCRYPTION_KEY) : null;
  const service = new AuthConfigService(fastify.prisma, key);

  let current: EffectiveAuthConfig;
  // Tracks whether the initial decrypt attempt below failed, so the
  // RECOVERY_DISABLE_AUTH branch further down knows it must NOT re-run
  // service.load() (which would hit the same undecryptable row again and
  // crash boot outside this try/catch) even though `key` is non-null.
  let decryptFailed = false;
  try {
    current = await service.load(env);
  } catch (err) {
    // The only expected failure mode here is AuthConfigService throwing
    // AuthSecretDecryptError because a stored secret column exists but can't
    // be decrypted — either CONFIG_ENCRYPTION_KEY is missing, OR it's present
    // but wrong (rotated) / the ciphertext is corrupted. Fail safe rather
    // than crash the whole server in either case.
    if (!(err instanceof AuthSecretDecryptError)) {
      throw err;
    }
    decryptFailed = true;
    fastify.log.error(
      { err },
      'AuthConfig has a stored secret that could not be decrypted (CONFIG_ENCRYPTION_KEY missing, ' +
        'wrong/rotated, or the ciphertext is corrupted); forcing mode=disabled to fail safe instead ' +
        'of crashing. The stored encrypted secret(s) are left intact — fixing or rolling back ' +
        'CONFIG_ENCRYPTION_KEY, or re-entering the secret in Settings, will allow re-enabling oidc.',
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
    // Only safe to re-load through the service (which decrypts stored
    // secrets) when we actually have a key AND the initial load above didn't
    // already fail to decrypt with it. With no key, or a key that's present
    // but wrong (rotated) / a corrupted ciphertext, service.load()/
    // toEffective() would throw the same AuthSecretDecryptError as the guard
    // above — but this time outside the try/catch, crashing boot instead of
    // failing safe. In that case `current` is already a valid disabled
    // config (either hand-built by the guard above, or loaded normally when
    // there was no secret to decrypt), so just force it disabled in memory
    // without touching the encrypted columns.
    current =
      key !== null && !decryptFailed ? await service.load(env) : { ...current, mode: 'disabled' };
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
