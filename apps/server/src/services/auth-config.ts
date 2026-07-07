import type { AuthConfig, PrismaClient } from '@prisma/client';

import type { AuthConfigResponse, AuthConfigUpdate } from '@lcm/shared';

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
  signingSecretEnc?: string;
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
   * untouched, `null` clears it, a string encrypts and stores it. A signing
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
   */
  async rotateSigningSecret(): Promise<void> {
    if (!this.key) {
      throw new UnprocessableError(
        'ENCRYPTION_KEY_REQUIRED',
        'CONFIG_ENCRYPTION_KEY is not configured; cannot rotate the signing secret.',
      );
    }
    const signingSecretEnc = encrypt(generateSecret(), this.key);
    await this.prisma.authConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, signingSecretEnc },
      update: { signingSecretEnc },
    });
  }

  /** Maps a raw `AuthConfig` row to the decrypted, in-memory effective shape. */
  toEffective(row: AuthConfig): EffectiveAuthConfig {
    return {
      mode: row.mode === 'oidc' ? 'oidc' : row.mode === 'local' ? 'local' : 'disabled',
      issuerUrl: row.issuerUrl,
      clientId: row.clientId,
      clientSecret: this.decryptColumn(row.clientSecretEnc, 'client secret'),
      signingSecret: this.decryptColumn(row.signingSecretEnc, 'signing secret'),
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

  /** Never includes secret values — only booleans indicating whether one is set. */
  sanitize(
    effective: EffectiveAuthConfig,
    redirectUri: string,
    discoveryStatus: AuthConfigResponse['discoveryStatus'],
    lastError: string | null,
  ): AuthConfigResponse {
    return {
      mode: effective.mode,
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
