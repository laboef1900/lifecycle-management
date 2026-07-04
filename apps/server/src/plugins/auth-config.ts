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
 *     prisma update — never `service.update()`, which would try to
 *     re-encrypt secrets using a key we don't have — log loudly, and retry
 *     the load instead of crashing the process.
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
        'secret is stored; forcing mode=disabled to fail safe instead of crashing.',
    );
    // toEffective() decrypts whatever secret columns are populated
    // unconditionally, regardless of mode — leaving the now-undecryptable
    // ciphertext in place would make the re-load below (and every later
    // load()) throw the exact same error again. Clear it: re-enabling oidc
    // later via service.update() (once a valid key is configured) generates
    // fresh secrets.
    await fastify.prisma.authConfig.update({
      where: { id: SINGLETON_ID },
      data: { mode: 'disabled', clientSecretEnc: null, signingSecretEnc: null },
    });
    current = await service.load(env);
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
