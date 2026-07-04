import type { AuthConfig, PrismaClient } from '@prisma/client';

import type { AuthConfigResponse, AuthConfigUpdate } from '@lcm/shared';

import { decrypt, encrypt, generateSecret } from '../crypto/secret-box.js';
import type { Env } from '../env.js';

const SINGLETON_ID = 'singleton';

/**
 * Plain-scalar shape for building the singleton row's create/update payload.
 * Deliberately its own type (not `Prisma.AuthConfigUpdateInput`) so a single
 * object can be passed to both `upsert`'s `create` and `update` — Prisma's
 * generated update type wraps scalars in `{set: ...}`-style operation input
 * unions that aren't assignable to the plain-scalar create type.
 */
interface AuthConfigWriteData {
  mode: 'disabled' | 'oidc';
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
  mode: 'disabled' | 'oidc';
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

export class AuthConfigService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly key: Buffer | null,
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
          console.warn(
            '[auth-config] OIDC env configuration present but CONFIG_ENCRYPTION_KEY is not set ' +
              '— seeded as disabled; set the key and configure authentication in Settings.',
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
    // manually-inserted row) may be oidc with no signing secret yet.
    if (row.mode === 'oidc' && !row.signingSecretEnc) {
      const signingSecretEnc = encrypt(generateSecret(), this.requireKey());
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
   * secret is generated the first time oidc mode is enabled without one.
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

    if (input.mode === 'oidc' && !existing?.signingSecretEnc) {
      data.signingSecretEnc = encrypt(generateSecret(), this.requireKey());
    }

    await this.prisma.authConfig.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...data },
      update: data,
    });
  }

  /** Maps a raw `AuthConfig` row to the decrypted, in-memory effective shape. */
  toEffective(row: AuthConfig): EffectiveAuthConfig {
    return {
      mode: row.mode === 'oidc' ? 'oidc' : 'disabled',
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
      throw new Error(
        `AuthConfig has a stored ${label} but CONFIG_ENCRYPTION_KEY is not configured; cannot decrypt`,
      );
    }
    return decrypt(enc, this.key);
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new Error('CONFIG_ENCRYPTION_KEY is required to store auth secrets');
    }
    return this.key;
  }
}
