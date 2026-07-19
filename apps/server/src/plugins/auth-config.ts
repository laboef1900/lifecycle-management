import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import type { AuthForceDisabledReason } from '@lcm/shared';

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
  /**
   * The auth config as ENFORCED — any in-memory override already applied.
   * Every authentication/authorization gate reads this.
   */
  current: EffectiveAuthConfig;
  /**
   * The mode as STORED in `auth_config.mode`, unmasked, refreshed on every
   * load and every `reload()`. Presentation (`sanitize()`) and the last-admin
   * lockout guards read this, never `current.mode` — see the split documented
   * on `enforce()` below.
   *
   * @ai-warning Must be reassigned on the state object at every derivation
   * site. A stale value round-trips the wrong mode back into the DB through
   * the Settings form, which re-introduces #222 through the front door.
   */
  storedMode: EffectiveAuthConfig['mode'];
  /**
   * `env.RECOVERY_DISABLE_AUTH` captured once at plugin registration.
   * Immutable for the process lifetime — never re-read from `process.env`.
   */
  readonly breakGlass: boolean;
  /**
   * Which in-memory override (if any) force-disabled the effective mode on this
   * boot: `break_glass` for `RECOVERY_DISABLE_AUTH`, `secret_decrypt_failure` for
   * the undecryptable-secret degrade, `null` when neither fired.
   *
   * Boot-scoped and immutable: `breakGlass` is a property of the process, and a
   * decrypt failure can only be resolved by restarting with a different
   * `CONFIG_ENCRYPTION_KEY`. Note this records the CAUSE, not the divergence —
   * break-glass over a row already stored as `disabled` sets it without any
   * enforced-vs-stored disagreement. `sanitize()` derives the reported reason
   * from the actual divergence and uses this only to attribute it.
   *
   * @ai-note Precedence when BOTH fire on the same boot is `break_glass`: it is
   * the operator's deliberate action and is immediately reversible (clear the env
   * var, restart), so it is the recovery step to surface first. Fixing the key
   * alone would not lift the override. Read `overrideCauses` when you need to
   * know whether a SECOND cause is also active.
   */
  readonly overrideCause: AuthForceDisabledReason | null;
  /**
   * EVERY in-memory override active on this boot, ordered by the same
   * precedence `overrideCause` applies — `overrideCause` is simply this list's
   * head (or `null` when it is empty). Empty when no override fired.
   *
   * Exists because the reported reason is deliberately single-valued (the API
   * contract names one recovery step, not a set). Without this, an operator who
   * clears `RECOVERY_DISABLE_AUTH` after a boot where the decrypt degrade ALSO
   * fired would restart into a still-disabled API with a second cause they were
   * never told about. The boot log names the extra cause explicitly, and this
   * field lets presentation hint at it without widening the response schema.
   *
   * Boot-scoped and immutable for the same reasons as `overrideCause`.
   */
  readonly overrideCauses: readonly AuthForceDisabledReason[];
  service: AuthConfigService;
  reload(): Promise<void>;
}

interface AuthConfigPluginOptions {
  env: Env;
}

/**
 * Thrown to abort boot when `AUTH_STRICT_BOOT` is set and the stored auth
 * config secret can't be decrypted — i.e. the deployment was previously
 * configured but the key is missing/wrong/rotated. Failing boot here is the
 * opt-in alternative to silently degrading to mode=disabled (which would open
 * `/api` to an anonymous ADMIN). Named so tests can assert on it precisely.
 */
export class AuthConfigStrictBootError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthConfigStrictBootError';
  }
}

const SINGLETON_ID = 'singleton';

/**
 * `AuthConfig.mode` is a plain String column, not the union — normalize it
 * exactly as `AuthConfigService.toEffective()` does, so a stray value can only
 * ever read as the closed-by-default `disabled`.
 */
function normalizeStoredMode(mode: string): EffectiveAuthConfig['mode'] {
  return mode === 'oidc' ? 'oidc' : mode === 'local' ? 'local' : 'disabled';
}

/**
 * Strict boot's refusal predicate: would degrading this stored mode to the
 * in-memory `disabled` fail-safe WIDEN access? True for every configured
 * (closed) mode; false for `disabled`, where failing open is not a downgrade
 * and refusing boot would be a spurious outage (#136 F1).
 *
 * Extracted and exported so the arm that is currently UNREACHABLE can still be
 * pinned by a test — see the `@ai-warning` below and the direct assertions in
 * `auth-config-plugin.test.ts`.
 *
 * @ai-warning Do NOT re-narrow this to `=== 'oidc'`, even though `oidc` is now
 * the only mode that can reach the call site. The two are equivalent TODAY only
 * because `toEffective()` gates decryption on the stored mode (#241), so
 * `local`/`disabled` rows never raise a decrypt failure in the first place.
 * Hardcoding the mode would silently fail OPEN the moment any future mode
 * stores decryptable secrets — which is exactly how the original scoping bug
 * worked: with unconditional decryption, an `=== 'oidc'` guard let a stored
 * `local` row degrade to an open, anonymous-ADMIN API despite strict boot being
 * explicitly enabled (#222). Keep it a structural test of "would degrading
 * widen access?", and let reachability be decided by which modes actually read
 * secrets. `disabled` stays exempt either way.
 */
export function degradeWouldWidenAccess(storedMode: string): boolean {
  return normalizeStoredMode(storedMode) !== 'disabled';
}

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
 *     corrupted, while a secret is stored), degrade the EFFECTIVE mode to
 *     `disabled` **in memory only** (#222). Only a stored `oidc` row can reach
 *     this: `toEffective()` gates decryption on the stored mode (#241), so
 *     `local`/`disabled` rows never read their (possibly leftover) encrypted
 *     columns, never raise the error, and are never degraded by a key failure.
 *     The stored row is not written at all: `service.update()` would try to
 *     re-encrypt secrets with a key we don't have, and even a direct
 *     `mode`-only write would destroy the operator's configuration — restoring
 *     or rolling back `CONFIG_ENCRYPTION_KEY` must recover the deployment
 *     exactly as it was, with nothing to re-enter.
 *     `clientSecretEnc`/`signingSecretEnc` are likewise never cleared here: the
 *     stored ciphertext may still be recoverable and is the only copy of an
 *     externally-sourced client secret. (Clearing them is exclusively an
 *     explicit operator SAVE of a non-oidc mode — see
 *     `AuthConfigService.update()` — never a degrade.) Log loudly, then
 *     hand-build the effective config from the row already fetched below,
 *     without decrypting — calling service.load()/toEffective() again would
 *     throw the exact same error, this time outside the try/catch, crashing
 *     boot.
 *  3b. Strict boot (opt-in): if `AUTH_STRICT_BOOT` is set, step 3's decrypt
 *     failure fired, AND the row's stored mode is NOT `disabled`, abort boot
 *     with `AuthConfigStrictBootError` (before anything is written, leaving the
 *     configured row intact) instead of degrading to the open mode=disabled
 *     state — unless `RECOVERY_DISABLE_AUTH` is also set, which still wins as the
 *     deliberate override.
 *     Since #241 the only stored mode that can reach step 3 at all is `oidc`,
 *     so in practice this refuses oidc deployments only. That is a narrowing of
 *     what is REACHABLE, not of the predicate: it stays the divergence test
 *     `!== 'disabled'` so it remains correct for any future mode that stores
 *     decryptable secrets. Two separate reasons a `disabled` row still boots:
 *     it no longer decrypts at all (#241), and even if it did, failing open is
 *     not a downgrade there, so refusing would be a spurious outage (#136 F1).
 *  4. Break-glass: if `RECOVERY_DISABLE_AUTH` is set, `enforce()` masks the
 *     effective mode to `disabled` **in memory only** — applied to the boot
 *     value AND to every later `reload()`, so the override is sticky for the
 *     whole process lifetime and no Settings write can silently re-lock the
 *     operator out mid-recovery. It never writes `auth_config`, so clearing
 *     the env var and restarting resumes the configured mode with no operator
 *     action in Settings (#222).
 *
 * @ai-note A break-glass boot is NOT write-free: `service.load()` itself may
 * still create the singleton row, seed it from env, or upgrade a missing
 * signing secret. What is guaranteed is that neither the break-glass override
 * nor the decrypt degrade ever writes `auth_config.mode`.
 */
const authConfigPluginFn: FastifyPluginAsync<AuthConfigPluginOptions> = async (
  fastify,
  { env },
) => {
  const key = env.CONFIG_ENCRYPTION_KEY ? loadKey(env.CONFIG_ENCRYPTION_KEY) : null;
  const service = new AuthConfigService(fastify.prisma, key, fastify.log);

  // Captured once, never re-read from process.env: the override is a property
  // of this process, immutable for its lifetime (invariant 5).
  const breakGlass = env.RECOVERY_DISABLE_AUTH === true;

  /**
   * The ONLY producer of the break-glass override. In-memory only:
   * `auth_config` is never written by it, so clearing `RECOVERY_DISABLE_AUTH`
   * and restarting resumes the configured mode (#222).
   *
   * Applied at EVERY site where `state.current` is derived — the boot load and
   * `reload()` — because the override is a pure function of the process, not a
   * one-time boot event. Skipping it in `reload()` would let
   * `POST /settings/auth/rotate-signing-secret` (which reloads but never
   * touches `mode`) resurrect the stored `oidc`/`local` and lock the operator
   * out on the very next request, mid-recovery, with the flag still set.
   *
   * @ai-warning Every value assigned to `state.current` must come from here.
   * The decrypt degrade below is the one deliberate exception: it is a second,
   * distinct override with its own cause, and hardcodes `mode: 'disabled'`.
   */
  const enforce = (loaded: EffectiveAuthConfig): EffectiveAuthConfig => {
    if (!breakGlass) return loaded;
    fastify.log.warn(
      { event: 'auth_config.break_glass_override_applied', storedMode: loaded.mode },
      'RECOVERY_DISABLE_AUTH=true: overriding the effective auth mode to disabled (break-glass). ' +
        'The stored configuration is untouched.',
    );
    return { ...loaded, mode: 'disabled' };
  };

  let current: EffectiveAuthConfig;
  let storedMode: EffectiveAuthConfig['mode'];
  // Set by the decrypt-degrade path below. Recorded so `sanitize()` can name the
  // cause of an enforced-vs-stored divergence: before this existed the degrade
  // produced the exact same divergence as break-glass but reported no cause at
  // all, so GET /settings/auth answered "oidc" with no force-disabled indicator
  // over a wide-open API.
  let decryptDegraded = false;
  try {
    const loaded = await service.load(env);
    storedMode = loaded.mode;
    current = enforce(loaded);
  } catch (err) {
    // The only expected failure mode here is AuthConfigService throwing
    // AuthSecretDecryptError because a stored secret column exists but can't
    // be decrypted — either CONFIG_ENCRYPTION_KEY is missing, OR it's present
    // but wrong (rotated) / the ciphertext is corrupted. Fail safe rather
    // than crash the whole server in either case.
    if (!(err instanceof AuthSecretDecryptError)) {
      throw err;
    }
    const storedRow = await fastify.prisma.authConfig.findUnique({ where: { id: SINGLETON_ID } });
    // Opt-in strict boot: refuse to start rather than silently degrade a
    // configured deployment to an open mode=disabled API.
    // RECOVERY_DISABLE_AUTH still wins as the deliberate break-glass override.
    // Throw BEFORE anything is written so the stored configured row is left
    // untouched for recovery. Raised outside the guarded load() (in the catch),
    // so it propagates and aborts boot.
    //
    // "Configured" is the STRUCTURAL test `degradeWouldWidenAccess()` —
    // deliberately not an enumeration of modes; see its `@ai-warning`. #241
    // narrowed only its REACHABILITY, not the predicate: a stored `local` row no
    // longer decrypts anything, so it can no longer raise AuthSecretDecryptError
    // and can no longer arrive here at all, leaving `oidc` as the only mode that
    // reaches this guard in practice. The `local` arm is unreachable-but-correct
    // and is kept so that a future mode which does store decryptable secrets is
    // covered by construction rather than by someone remembering to widen the
    // guard — which is why the predicate is asserted directly in its own test.
    if (
      storedRow !== null &&
      degradeWouldWidenAccess(storedRow.mode) &&
      env.AUTH_STRICT_BOOT &&
      !env.RECOVERY_DISABLE_AUTH
    ) {
      fastify.log.fatal(
        { err, event: 'auth_config.strict_boot_refused' },
        'AUTH_STRICT_BOOT is set and the stored auth configuration secret could not be decrypted ' +
          '(CONFIG_ENCRYPTION_KEY missing, wrong, or rotated). Refusing to boot into an open, ' +
          'unauthenticated API. Restore the correct CONFIG_ENCRYPTION_KEY, or set ' +
          'RECOVERY_DISABLE_AUTH=true to deliberately boot with authentication disabled.',
      );
      throw new AuthConfigStrictBootError(
        'AUTH_STRICT_BOOT refused: stored auth config secret is undecryptable and ' +
          'RECOVERY_DISABLE_AUTH is not set',
        { cause: err },
      );
    }
    fastify.log.error(
      { err, event: 'auth_config.decrypt_degraded' },
      'AuthConfig has a stored secret that could not be decrypted (CONFIG_ENCRYPTION_KEY missing, ' +
        'wrong/rotated, or the ciphertext is corrupted); degrading the EFFECTIVE mode to disabled ' +
        'in memory to fail safe instead of crashing. The stored configuration and encrypted ' +
        'secret(s) are left completely intact — fixing or rolling back CONFIG_ENCRYPTION_KEY and ' +
        'restarting restores the configured mode with nothing to re-enter.',
    );
    // The row is NOT written (#222): degrading in memory keeps the operator's
    // configuration recoverable by restoring the key alone. `current` is
    // hand-built from the row fetched above rather than via
    // service.load()/toEffective(), which would decrypt the still-present
    // ciphertext and throw the identical error — this time outside the
    // try/catch, crashing boot.
    if (storedRow === null) {
      // Unreachable in practice: service.load() creates the singleton row
      // before it can throw a decrypt error. Fail loud rather than guess.
      throw err;
    }
    storedMode = normalizeStoredMode(storedRow.mode);
    decryptDegraded = true;
    // Hardcoded, NOT produced by enforce(): the decrypt degrade is a second,
    // distinct override with its own cause, and applies whether or not
    // break-glass is also active. clientSecret/signingSecret stay null —
    // they genuinely could not be decrypted.
    current = {
      mode: 'disabled',
      issuerUrl: storedRow.issuerUrl,
      clientId: storedRow.clientId,
      clientSecret: null,
      signingSecret: null,
      appBaseUrl: storedRow.appBaseUrl,
      scopes: storedRow.scopes,
      roleClaim: storedRow.roleClaim,
      adminValues: storedRow.adminValues,
      defaultRole: storedRow.defaultRole === 'viewer' ? 'viewer' : 'admin',
      allowedEmailDomains: storedRow.allowedEmailDomains,
      allowedEmails: storedRow.allowedEmails,
      sessionTtlHours: storedRow.sessionTtlHours,
      allowInsecure: storedRow.allowInsecure,
    };
  }

  // Precedence-ordered: break-glass first — see the `overrideCause` docstring.
  const overrideCauses: readonly AuthForceDisabledReason[] = [
    ...(breakGlass ? (['break_glass'] as const) : []),
    ...(decryptDegraded ? (['secret_decrypt_failure'] as const) : []),
  ];
  // The single reported cause is this list's head; the tail is what the boot log
  // below and any presentation hint use to warn about the NEXT cause waiting.
  const overrideCause: AuthForceDisabledReason | null = overrideCauses[0] ?? null;

  if (breakGlass) {
    // Naming the second cause here is the whole mitigation for the
    // single-valued contract: the operator who reads this line knows that
    // clearing the env var alone will not restore the stored mode.
    const alsoDecryptDegraded = decryptDegraded;
    fastify.log.warn(
      { event: 'auth_config.break_glass_active', storedMode, overrideCauses, alsoDecryptDegraded },
      'RECOVERY_DISABLE_AUTH=true: authentication is force-disabled for THIS boot only ' +
        '(break-glass override). The stored auth configuration is preserved untouched — clearing ' +
        'this env var and restarting fully restores it, with no change needed in Settings. The ' +
        'override also survives in-session reloads, so saving in Settings persists but does not ' +
        'take effect until that restart. While it is set, /api is open to an anonymous ADMIN.' +
        (alsoDecryptDegraded
          ? ' A SECOND override is also active on this boot: the stored auth secret could not be ' +
            'decrypted. Clearing RECOVERY_DISABLE_AUTH alone will NOT restore the stored mode — ' +
            'restore the correct CONFIG_ENCRYPTION_KEY as well.'
          : ''),
    );
  }

  const state: AuthConfigState = {
    current,
    storedMode,
    breakGlass,
    overrideCause,
    overrideCauses,
    service,
    async reload() {
      try {
        const next = await service.load(env);
        // Assigned on the STATE, never a closure-local `let`: a stale
        // storedMode would round-trip the wrong mode back into the DB via the
        // Settings form (see the AuthConfigState docstring).
        state.storedMode = next.mode;
        state.current = enforce(next);
      } catch (err) {
        if (!(err instanceof AuthSecretDecryptError)) throw err;
        // A write landed (e.g. `PUT /settings/auth`) but the re-read could not
        // decrypt. `state.current` is deliberately left alone — this path must
        // never widen what is enforced — but `storedMode` would otherwise keep
        // its pre-write value and round-trip the OLD mode back into the DB
        // through the Settings form. Re-read the raw row (no decryption, so it
        // cannot throw the same error again) to make storedMode reflect the most
        // recent successful WRITE as well as the most recent successful load.
        const row = await fastify.prisma.authConfig.findUnique({ where: { id: SINGLETON_ID } });
        if (row) state.storedMode = normalizeStoredMode(row.mode);
        // A divergence can FIRST ARISE here, at runtime: the write landed, so
        // storedMode advances, while `state.current` is deliberately frozen.
        // `authStartupWarnings` only runs once, at boot (server.ts), so without
        // this the operator gets no signal at all — and docs/operations.md tells
        // them the error log is one of the two things that make this state
        // visible. Same event name and same `error` level as the boot alarm, so
        // one log query finds every occurrence regardless of when it arose.
        if (state.current.mode === 'disabled' && state.storedMode !== 'disabled') {
          fastify.log.error(
            {
              err,
              event: 'auth_config.open_despite_configuration',
              storedMode: state.storedMode,
              enforcedMode: state.current.mode,
            },
            `Authentication is DISABLED in memory while the stored configuration is ` +
              `'${state.storedMode}': /api is open to an anonymous ADMIN. This divergence arose ` +
              'at runtime — a Settings write landed but the re-read could not be decrypted, so ' +
              'the enforced mode was left untouched. Restore CONFIG_ENCRYPTION_KEY and restart.',
          );
        } else if (state.current.mode !== 'disabled' && state.current.mode !== state.storedMode) {
          // The INVERSE stale case, and the safe direction: what is enforced is
          // STRICTER than what is stored (e.g. still enforcing 'oidc' after the
          // row was rewritten to 'disabled'). `sanitize()` reports
          // forceDisabledReason=null here by design — see the asymmetry note on
          // AuthConfigService.sanitize(). It understates access and never
          // overstates it, so enforcement is deliberately NOT widened to match;
          // it is only made observable.
          fastify.log.warn(
            {
              event: 'auth_config.enforced_stricter_than_stored',
              storedMode: state.storedMode,
              enforcedMode: state.current.mode,
            },
            `Authentication is still ENFORCED as '${state.current.mode}' while the stored ` +
              `configuration now reads '${state.storedMode}': the write landed but the re-read ` +
              'could not be decrypted, so the enforced mode was left untouched. This fails ' +
              'closed (access is stricter than configured); Settings will show the stored mode. ' +
              'Restore CONFIG_ENCRYPTION_KEY and restart to converge.',
          );
        }
        throw err;
      }
    },
  };

  fastify.decorate('authConfig', state);
};

export const authConfigPlugin = fp(authConfigPluginFn, {
  name: 'auth-config',
  dependencies: ['prisma'],
});
