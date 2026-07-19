import type { AuthConfig, PrismaClient } from '@prisma/client';

import type { AuthConfigResponse, AuthConfigUpdate, AuthForceDisabledReason } from '@lcm/shared';

import { decrypt, encrypt, generateSecret } from '../crypto/secret-box.js';
import type { Env } from '../env.js';
import { UnprocessableError } from './errors.js';

const SINGLETON_ID = 'singleton';

/**
 * Thrown when a stored secret column (`clientSecretEnc`/`signingSecretEnc`)
 * exists but cannot be decrypted — covers BOTH cases:
 *  - `CONFIG_ENCRYPTION_KEY` is not configured at all (null key), and
 *  - a key IS configured but is the wrong one (rotated away from the key the
 *    ciphertext was encrypted under) or the ciphertext has been tampered
 *    with — Node's AES-GCM auth-tag check fails and throws a generic
 *    `"Unsupported state or unable to authenticate data"` error in that case.
 *
 * Callers (the auth-config plugin's boot fail-safe guard) catch this one
 * type to force `mode=disabled` without crashing, regardless of *why*
 * decryption failed. The message never includes the secret, ciphertext, or
 * key.
 */
export class AuthSecretDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthSecretDecryptError';
  }
}

/**
 * Plain-scalar shape for building the singleton row's create/update payload.
 * Deliberately its own type (not `Prisma.AuthConfigUpdateInput`) so a single
 * object can be passed to both `upsert`'s `create` and `update` — Prisma's
 * generated update type wraps scalars in `{set: ...}`-style operation input
 * unions that aren't assignable to the plain-scalar create type.
 */
interface AuthConfigWriteData {
  mode: 'disabled' | 'local' | 'oidc';
  issuerUrl?: string | null;
  clientId?: string | null;
  clientSecretEnc?: string | null;
  /**
   * Nullable since #241: saving a non-oidc mode CLEARS the signing secret.
   * Before that, `update()` could only ever set or keep one, never remove it.
   */
  signingSecretEnc?: string | null;
  appBaseUrl?: string | null;
  scopes: string;
  roleClaim?: string | null;
  adminValues?: string | null;
  defaultRole: 'admin' | 'viewer';
  allowedEmailDomains?: string | null;
  allowedEmails?: string | null;
  sessionTtlHours: number;
  allowInsecure: boolean;
  updatedByUserId: string | null;
}

/**
 * The runtime source of truth for auth configuration: the decrypted, DB-backed
 * replacement for reading `env.AUTH_MODE` / `env.OIDC_*` directly. Secrets are
 * decrypted strings (or null) — only ever held in memory, never serialized.
 */
export interface EffectiveAuthConfig {
  mode: 'disabled' | 'local' | 'oidc';
  issuerUrl: string | null;
  clientId: string | null;
  clientSecret: string | null;
  signingSecret: string | null;
  appBaseUrl: string | null;
  scopes: string;
  roleClaim: string | null;
  adminValues: string | null;
  defaultRole: 'admin' | 'viewer';
  allowedEmailDomains: string | null;
  allowedEmails: string | null;
  sessionTtlHours: number;
  allowInsecure: boolean;
}

/**
 * `AuthConfig.mode` is a plain String column, not the union — a stray or
 * legacy value must read as the closed-by-default `disabled` rather than being
 * trusted. Shared by `toEffective()` and `rotateSigningSecret()` so the two can
 * never disagree about what a row's stored mode is.
 */
function normalizeMode(mode: string): EffectiveAuthConfig['mode'] {
  return mode === 'oidc' ? 'oidc' : mode === 'local' ? 'local' : 'disabled';
}

/**
 * Maps legacy OIDC env vars to a seed `AuthConfigUpdate`, used only on first
 * boot when the `auth_config` singleton row does not exist yet. Returns null
 * when none of the OIDC env vars are present (nothing to seed).
 *
 * `LOGIN_STATE_SECRET` is intentionally NOT mapped: the signing secret used
 * for state/nonce cookies is app-generated (see `AuthConfigService.load`),
 * never sourced from env.
 */
export function seedFromEnv(env: Env): AuthConfigUpdate | null {
  const hasOidcVars =
    env.OIDC_ISSUER_URL !== undefined ||
    env.OIDC_CLIENT_ID !== undefined ||
    env.OIDC_CLIENT_SECRET !== undefined ||
    env.APP_BASE_URL !== undefined;
  if (!hasOidcVars) return null;

  return {
    mode: env.AUTH_MODE ?? 'oidc',
    issuerUrl: env.OIDC_ISSUER_URL ?? null,
    clientId: env.OIDC_CLIENT_ID ?? null,
    clientSecret: env.OIDC_CLIENT_SECRET ?? null,
    appBaseUrl: env.APP_BASE_URL ?? null,
    scopes: env.OIDC_SCOPES ?? 'openid profile email',
    roleClaim: env.OIDC_ROLE_CLAIM ?? null,
    adminValues: env.OIDC_ADMIN_VALUES ?? null,
    defaultRole: env.OIDC_DEFAULT_ROLE ?? 'admin',
    allowedEmailDomains: env.OIDC_ALLOWED_EMAIL_DOMAINS ?? null,
    allowedEmails: env.OIDC_ALLOWED_EMAILS ?? null,
    sessionTtlHours: env.SESSION_TTL_HOURS ?? 12,
    allowInsecure: env.OIDC_ALLOW_INSECURE ?? false,
  };
}

/**
 * Minimal structured-logger surface (satisfied by pino / `fastify.log`) so
 * security-relevant boot warnings go through the configured logger — honouring
 * `LOG_LEVEL` and JSON aggregation — instead of `console.warn`, which bypasses
 * both. Injected as an optional dependency so unit tests can omit it.
 */
export interface AuthConfigLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export class AuthConfigService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly key: Buffer | null,
    private readonly logger?: AuthConfigLogger,
  ) {}

  /**
   * Loads the effective auth config, creating the singleton row on first
   * call. `seedEnv`, when given, seeds the row from legacy OIDC env vars the
   * very first time (no row exists yet) — every later call is a plain read.
   */
  async load(seedEnv?: Env): Promise<EffectiveAuthConfig> {
    let row = await this.prisma.authConfig.findUnique({ where: { id: SINGLETON_ID } });

    if (!row) {
      const seed = seedEnv ? seedFromEnv(seedEnv) : null;
      if (seed) {
        if (this.key === null) {
          // OIDC env vars (possibly including a client secret) are present,
          // but there is no key to encrypt anything with. Storing the secret
          // is impossible and enabling oidc without one would be unsafe, so
          // seed a disabled config from the non-secret fields only. This
          // keeps `update()`'s upsert from ever needing `requireKey()`, so it
          // can't throw here — boot must fail safe, never crash.
          this.logger?.warn(
            { event: 'auth_config.seeded_disabled_no_key' },
            'OIDC env configuration present but CONFIG_ENCRYPTION_KEY is not set — seeded as ' +
              'disabled; set the key and configure authentication in Settings.',
          );
          const { clientSecret: _clientSecret, ...withoutSecret } = seed;
          await this.update({ ...withoutSecret, mode: 'disabled' }, null);
        } else {
          // A key IS configured, so `update()` will encrypt the seeded secret —
          // and then null it again, because only oidc keeps one (#241). Say so:
          // an operator who set OIDC_CLIENT_SECRET but left AUTH_MODE at its
          // `disabled` default would otherwise get no signal at all, and would
          // discover the secret was never stored only when enabling OIDC later
          // fails with INCOMPLETE_OIDC_CONFIG. Not logged in the no-key branch
          // above — `auth_config.seeded_disabled_no_key` already reports that
          // discard, with its own (different) remedy.
          if (seed.mode !== 'oidc' && (seed.clientSecret ?? null) !== null) {
            this.logger?.warn(
              { event: 'auth_config.seeded_client_secret_discarded', seededMode: seed.mode },
              'OIDC_CLIENT_SECRET was supplied but AUTH_MODE is not `oidc` — the secret was NOT ' +
                'stored: only oidc mode uses it. Seed with AUTH_MODE=oidc (first boot only), or ' +
                'enter the secret in Settings → Authentication when you enable OIDC.',
            );
          }
          await this.update(seed, null);
        }
      } else {
        await this.prisma.authConfig.create({ data: { id: SINGLETON_ID } });
      }
      row = await this.prisma.authConfig.findUnique({ where: { id: SINGLETON_ID } });
    }
    if (!row) {
      // Unreachable: we just created the row above.
      throw new Error('AuthConfig singleton row missing after create');
    }

    // Upgrade path: rows created before signing secrets existed (or a
    // manually-inserted row) may be oidc with no signing secret yet. This
    // needs a key to encrypt a freshly generated one; a null key here is the
    // same "stored/needed secret unusable" fail-safe scenario as a decrypt
    // failure below, so it's raised the same way (AuthSecretDecryptError)
    // rather than requireKey()'s generic error, so the plugin's boot
    // fail-safe guard also catches it instead of crashing.
    if (row.mode === 'oidc' && !row.signingSecretEnc) {
      if (!this.key) {
        throw new AuthSecretDecryptError(
          'AuthConfig is oidc-mode with no signing secret yet, but CONFIG_ENCRYPTION_KEY is not ' +
            'configured to generate and encrypt one',
        );
      }
      const signingSecretEnc = encrypt(generateSecret(), this.key);
      row = await this.prisma.authConfig.update({
        where: { id: SINGLETON_ID },
        data: { signingSecretEnc },
      });
    }

    return this.toEffective(row);
  }

  /**
   * Applies a partial update to the singleton row (creating it if absent).
   * `clientSecret` is tri-state: `undefined` leaves the stored value
   * untouched, `null` clears it, a string encrypts and stores it — but only
   * while the mode being saved is `oidc`. Saving any other mode clears BOTH
   * secret columns outright (#241, see the block at the end of the body). A signing
   * secret is (re)generated whenever oidc mode is being enabled and the
   * existing one is unusable — either absent (first time enabling oidc) or
   * present but undecryptable under the *current* key. The latter is the
   * key-rotation recovery path: after `CONFIG_ENCRYPTION_KEY` is rotated,
   * boot fails safe to `mode=disabled` leaving the old ciphertext in place
   * (see the plugin's boot guard); when an admin re-enables oidc by
   * re-entering the client secret in Settings, the stale `signingSecretEnc`
   * (still encrypted under the OLD key) would otherwise be kept as-is and
   * make the very next `reload()`/`toEffective()` throw `AuthSecretDecryptError`
   * — regenerating it here instead guarantees that, once `update()` returns
   * successfully for oidc mode, every stored secret column is decryptable
   * under the current key.
   *
   * Other nullable fields (`issuerUrl`, `clientId`, ...) are optional only for
   * zod ergonomics — the settings UI always submits the full form — but for
   * defense in depth an omitted key here still leaves the column untouched
   * rather than erroring, matching Prisma's own undefined-skips-field rule.
   */
  async update(input: AuthConfigUpdate, actorUserId: string | null): Promise<void> {
    const existing = await this.prisma.authConfig.findUnique({ where: { id: SINGLETON_ID } });

    // Plain-scalar shape (no Prisma `{set: ...}` wrappers) so it structurally
    // satisfies both the create and update input types below.
    const data: AuthConfigWriteData = {
      mode: input.mode,
      scopes: input.scopes,
      defaultRole: input.defaultRole,
      sessionTtlHours: input.sessionTtlHours,
      allowInsecure: input.allowInsecure,
      updatedByUserId: actorUserId,
    };
    if (input.issuerUrl !== undefined) data.issuerUrl = input.issuerUrl;
    if (input.clientId !== undefined) data.clientId = input.clientId;
    if (input.appBaseUrl !== undefined) data.appBaseUrl = input.appBaseUrl;
    if (input.roleClaim !== undefined) data.roleClaim = input.roleClaim;
    if (input.adminValues !== undefined) data.adminValues = input.adminValues;
    if (input.allowedEmailDomains !== undefined)
      data.allowedEmailDomains = input.allowedEmailDomains;
    if (input.allowedEmails !== undefined) data.allowedEmails = input.allowedEmails;

    if (input.clientSecret !== undefined) {
      data.clientSecretEnc =
        input.clientSecret === null ? null : encrypt(input.clientSecret, this.requireKey());
    }

    if (input.mode === 'oidc' && !this.canDecrypt(existing?.signingSecretEnc ?? null)) {
      data.signingSecretEnc = encrypt(generateSecret(), this.requireKey());
    }

    // A non-oidc mode has no use for either secret, so an explicit operator
    // SAVE clears both columns. This deliberately REVERSES the #222/#126
    // preservation contract for MODE CHANGES: switching oidc -> local/disabled
    // used to keep the ciphertext so that restoring a rotated key recovered the
    // configuration "with nothing to re-enter". That leftover ciphertext is
    // precisely what made the fail-open reachable — a later key rotation turned
    // it into a decrypt failure on a row that never needed the secret (#241).
    // Preservation now applies only to the mode that OWNS the secret: an oidc
    // row's columns are still never touched, and no degrade writes anything at
    // all. Operator consequence: switching back to oidc requires re-entering
    // the client secret, enforced by settings-auth.ts's 422
    // INCOMPLETE_OIDC_CONFIG rather than silently enabling oidc without one.
    //
    // @ai-warning Position is load-bearing — this MUST stay after the
    // `input.clientSecret !== undefined` branch above. Moving it earlier would
    // skip `requireKey()`, turning "submitted a secret with no
    // CONFIG_ENCRYPTION_KEY configured" from 422 ENCRYPTION_KEY_REQUIRED into a
    // silent 200. The `settings-auth-routes.test.ts` test named "fails with 422
    // ENCRYPTION_KEY_REQUIRED (not 500) ... and persists nothing" is the canary.
    //
    // That 422 does NOT strand a keyless deployment on its stored mode (#241
    // review, traced end to end). `requireKey()` runs only for a non-null
    // clientSecret STRING: an omitted one skips the branch entirely, and the
    // shared schema's `emptyToNull` turns a stray '' into `null`, which clears
    // without needing a key. The Settings form omits the field whenever it is
    // blank (`authentication-form.tsx` handleSubmit), and on a keyless
    // deployment nothing ever reads as stored — `clientSecretSet` is always
    // false, so the form renders an empty input with no value to echo back.
    // Switching to local/disabled therefore never reaches `requireKey()`; only
    // deliberately TYPING a secret while saving a non-oidc mode does, which is
    // exactly the input the canary pins as a correct 422. Regression cover for
    // the web half is "omits clientSecret when switching away from oidc" in
    // `authentication-form.test.tsx`.
    if (input.mode !== 'oidc') {
      data.clientSecretEnc = null;
      data.signingSecretEnc = null;
    }

    await this.prisma.authConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...data },
      update: data,
    });
  }

  /**
   * Generates a fresh signing secret (used for login-state cookie HMAC),
   * encrypts, and stores it — invalidating any in-flight login attempts that
   * relied on the previous secret. Requires `CONFIG_ENCRYPTION_KEY`; throws a
   * (422) `UnprocessableError` rather than a raw `Error` so the route layer
   * doesn't need special-case handling to turn a missing key into a clean
   * HTTP response.
   *
   * Refused unless the STORED mode is `oidc`: the signing secret only signs
   * OIDC login-state cookies, and `update()` clears both secret columns
   * whenever a non-oidc mode is saved (#241). Without this guard, this method —
   * which bypasses `update()` entirely — could write a secret onto a
   * `disabled`/`local` row that nothing reads and the very next Settings save
   * would null again, leaving "a non-oidc row holds no secrets" merely
   * eventually true instead of invariant.
   *
   * The missing-key check runs FIRST, ahead of the mode guard: it is the
   * precondition that holds for every mode, and ordering it first keeps the
   * pre-existing ENCRYPTION_KEY_REQUIRED behaviour (and its test) unchanged.
   *
   * @ai-warning The mode guard reads the ROW, never `authConfig.current.mode`.
   * During a break-glass boot the ENFORCED mode is `disabled` while the row
   * still says `oidc`, and rotating the signing secret is one of the documented
   * recovery steps available in that window — keying this off the enforced mode
   * would break break-glass recovery.
   */
  async rotateSigningSecret(): Promise<void> {
    if (!this.key) {
      throw new UnprocessableError(
        'ENCRYPTION_KEY_REQUIRED',
        'CONFIG_ENCRYPTION_KEY is not configured; cannot rotate the signing secret.',
      );
    }
    const existing = await this.prisma.authConfig.findUnique({ where: { id: SINGLETON_ID } });
    if (existing === null || normalizeMode(existing.mode) !== 'oidc') {
      throw new UnprocessableError(
        'OIDC_MODE_REQUIRED',
        'The login-state signing secret is only used by OIDC authentication; enable OIDC ' +
          'before rotating it.',
      );
    }
    const signingSecretEnc = encrypt(generateSecret(), this.key);
    await this.prisma.authConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, signingSecretEnc },
      update: { signingSecretEnc },
    });
  }

  /**
   * Maps a raw `AuthConfig` row to the decrypted, in-memory effective shape.
   *
   * Decryption is MODE-GATED (#241): `clientSecretEnc`/`signingSecretEnc` are
   * read only when the stored mode is `oidc`, the one mode that uses them.
   * Every consumer already honours the resulting invariant — the secrets are
   * non-null only in oidc mode — because each reads them behind its own mode
   * gate (`routes/auth.ts`, `plugins/oidc.ts`) or an explicit null check
   * (`routes/settings-auth.ts`).
   *
   * @ai-warning Do NOT decrypt these columns unconditionally "for
   * completeness". A `local` or `disabled` row may still carry ciphertext from
   * an earlier OIDC configuration. Decrypting it meant an unreadable
   * `CONFIG_ENCRYPTION_KEY` raised `AuthSecretDecryptError` for a mode with no
   * use for the secret, which the auth-config plugin's boot guard then degraded
   * to `mode=disabled` — turning a deployment explicitly configured as `local`
   * into an open, anonymous-ADMIN API. The leftover ciphertext is still
   * RETAINED (only an explicit Settings save clears it) but never read, so a
   * key failure can no longer degrade a mode that does not depend on the key.
   */
  toEffective(row: AuthConfig): EffectiveAuthConfig {
    const mode = normalizeMode(row.mode);
    return {
      mode,
      issuerUrl: row.issuerUrl,
      clientId: row.clientId,
      clientSecret:
        mode === 'oidc' ? this.decryptColumn(row.clientSecretEnc, 'client secret') : null,
      signingSecret:
        mode === 'oidc' ? this.decryptColumn(row.signingSecretEnc, 'signing secret') : null,
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

  /**
   * Never includes secret values — only booleans indicating whether one is set.
   *
   * `provenance.storedMode` (NOT `effective.mode`) is reported as `mode`,
   * because the Settings form defaults its mode selector from this response
   * and always echoes `mode` back in its PUT. Reporting the *enforced* mode
   * during a break-glass boot would make the first save clobber the stored
   * `oidc`/`local` with `disabled` and re-introduce #222 through the UI.
   * `forceDisabledReason` is what stops that from reading as "OIDC is on" over
   * a wide-open API — the two fields are only correct together.
   *
   * @ai-warning `forceDisabledReason` is derived from the ACTUAL enforced-vs-
   * stored divergence, never from a cause flag alone. Gating it on break-glass
   * only (as the first cut did) silently omitted the identical divergence
   * produced by the decrypt degrade, which reads as a normal, secured OIDC
   * deployment over an anonymous-ADMIN API.
   *
   * @ai-note The predicate is deliberately ASYMMETRIC. It fires only when the
   * enforced mode is LOOSER than the stored one (enforced `disabled`, stored
   * `oidc`/`local`) — the direction that overstates security over an open API.
   * The inverse (enforced `oidc`/`local` while the row now reads `disabled`,
   * reachable when a Settings write lands but the re-read cannot be decrypted)
   * reports `forceDisabledReason: null`, so the UI renders an ordinary
   * 'Disabled' page while the API is in fact still enforcing. That is the SAFE
   * direction: it understates the caller's access and never overstates it, and
   * contorting this field to express "stricter than stored" would overload a
   * flag whose only consumer is a force-DISABLED warning. It is made observable
   * instead, via `auth_config.enforced_stricter_than_stored` at `warn` from the
   * auth-config plugin's reload path. Do not widen enforcement to converge.
   */
  sanitize(
    effective: EffectiveAuthConfig,
    provenance: {
      storedMode: EffectiveAuthConfig['mode'];
      /** Cause recorded by the auth-config plugin; only ever used to attribute. */
      overrideCause: AuthForceDisabledReason | null;
    },
    redirectUri: string,
    discoveryStatus: AuthConfigResponse['discoveryStatus'],
    lastError: string | null,
  ): AuthConfigResponse {
    // The enforced mode can only be `disabled` while something else is stored
    // when an in-memory override is active, so this has no false positives.
    const forceDisabled = effective.mode === 'disabled' && provenance.storedMode !== 'disabled';
    // A divergence with no recorded cause is a bug in the plugin, not an
    // absence of override — reporting `null` there would render a
    // secured-looking page over an open API, which is exactly the failure this
    // field exists to prevent. Fall back to the conservative non-null value so
    // a divergence is NEVER reportable as null.
    const forceDisabledReason: AuthForceDisabledReason | null = forceDisabled
      ? (provenance.overrideCause ?? 'secret_decrypt_failure')
      : null;

    return {
      mode: provenance.storedMode,
      forceDisabledReason,
      issuerUrl: effective.issuerUrl,
      clientId: effective.clientId,
      appBaseUrl: effective.appBaseUrl,
      scopes: effective.scopes,
      roleClaim: effective.roleClaim,
      adminValues: effective.adminValues,
      defaultRole: effective.defaultRole,
      allowedEmailDomains: effective.allowedEmailDomains,
      allowedEmails: effective.allowedEmails,
      sessionTtlHours: effective.sessionTtlHours,
      allowInsecure: effective.allowInsecure,
      clientSecretSet: effective.clientSecret !== null,
      signingSecretSet: effective.signingSecret !== null,
      redirectUri,
      discoveryStatus,
      lastDiscoveryError: lastError,
    };
  }

  private decryptColumn(enc: string | null, label: string): string | null {
    if (enc === null) return null;
    if (!this.key) {
      throw new AuthSecretDecryptError(
        `AuthConfig has a stored ${label} but CONFIG_ENCRYPTION_KEY is not configured; cannot decrypt`,
      );
    }
    try {
      return decrypt(enc, this.key);
    } catch (err) {
      // Node's AES-GCM auth-tag check throws a generic, non-specific error
      // (e.g. "Unsupported state or unable to authenticate data") when the
      // key is wrong or the ciphertext was tampered with — normalize it to
      // the same dedicated error type as the null-key case above, so callers
      // have one thing to catch regardless of *why* decryption failed.
      throw new AuthSecretDecryptError(
        `AuthConfig has a stored ${label} that could not be decrypted with the configured ` +
          'CONFIG_ENCRYPTION_KEY (the key may have changed/rotated, or the ciphertext is corrupted)',
        { cause: err },
      );
    }
  }

  /**
   * True only if `enc` is present AND decrypts cleanly under the current
   * key — used by `update()` to decide whether an existing `signingSecretEnc`
   * is still usable or must be regenerated. Returns `false` (never throws)
   * for every "unusable" case: `null` (nothing stored), no key configured, a
   * wrong/rotated key, or corrupted ciphertext — `decryptColumn` normalizes
   * all of those to `AuthSecretDecryptError`, which is the only thing this
   * catches; anything else rethrows.
   */
  private canDecrypt(enc: string | null): boolean {
    if (enc === null) return false;
    try {
      this.decryptColumn(enc, 'signing secret');
      return true;
    } catch (err) {
      if (err instanceof AuthSecretDecryptError) return false;
      throw err;
    }
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new UnprocessableError(
        'ENCRYPTION_KEY_REQUIRED',
        'CONFIG_ENCRYPTION_KEY is not configured; cannot store an auth secret.',
      );
    }
    return this.key;
  }
}
