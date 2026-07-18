# OIDC configuration via the admin settings page — design

**Status:** proposed · **Date:** 2026-07-03 · **Supersedes** the env-var configuration model from PR #116 (`docs/superpowers/specs/2026-07-03-oidc-auth-design.md`).

## Problem

OIDC is currently configured entirely through environment variables read at
server boot (`apps/server/src/env.ts` `superRefine` + the `oidc.ts` discovery
loop + 34 `env.AUTH_MODE`/`env.OIDC_*` read sites across the server). The
operator wants to configure authentication from the UI instead of editing
`.env`/compose. This design moves OIDC configuration into a database-backed,
admin-editable **Authentication** panel on the settings page, editable at
runtime with no restart, while keeping secrets protected at rest.

## Decisions (agreed during brainstorming)

| #   | Decision             | Choice                                                                                                                                           |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A   | Where config lives   | DB-backed singleton, edited from an admin-only settings panel                                                                                    |
| B   | Secret storage       | Encrypted at rest (AES-256-GCM) with one bootstrap `CONFIG_ENCRYPTION_KEY`; secrets are **write-only** through the API                           |
| C   | Login-signing secret | App-generated on first save, rotatable from the UI (operator never pastes it)                                                                    |
| D   | Enabling auth        | Refused unless a live **connection test** against the issuer passes first                                                                        |
| E   | Lockout recovery     | One-time `RECOVERY_DISABLE_AUTH=true` env var forces the config to `disabled` on next boot                                                       |
| F   | Migration            | **Env-as-one-time-seed**: first boot with an empty table seeds the row from any present OIDC env vars, then env is ignored                       |
| G   | Panel visibility     | Admin-only once auth is enabled; open to anyone while `mode=disabled` (bootstrap path)                                                           |
| H   | Env-var floor        | A few env vars are acceptable. Going forward only `CONFIG_ENCRYPTION_KEY` (required) and `RECOVERY_DISABLE_AUTH` (emergency) remain auth-related |

Non-goal: eliminating **all** env vars. The encryption key cannot live in the
database it protects, so it stays in the environment. This reduces the
auth-related env surface from six configuration vars to one key plus an
emergency flag.

## Architecture

### Data model — `AuthConfig` singleton

New Prisma model (migration adds it alongside `User`/`Session` at
`apps/server/prisma/schema.prisma`). Exactly one row, addressed by a fixed
primary key `id = "singleton"`.

```prisma
model AuthConfig {
  id                  String   @id @default("singleton")
  mode                String   @default("disabled")  // 'disabled' | 'oidc'
  issuerUrl           String?
  clientId            String?
  clientSecretEnc     String?  // AES-256-GCM: base64(iv).base64(tag).base64(ciphertext)
  signingSecretEnc    String?  // app-generated; same encryption envelope
  appBaseUrl          String?
  scopes              String   @default("openid profile email")
  roleClaim           String?
  adminValues         String?  // CSV
  defaultRole         String   @default("admin")     // 'admin' | 'viewer'
  allowedEmailDomains String?  // CSV
  allowedEmails       String?  // CSV
  sessionTtlHours     Int      @default(12)
  allowInsecure       Boolean  @default(false)
  updatedAt           DateTime @updatedAt
  updatedByUserId     String?
}
```

Rationale for a singleton (not per-tenant): authentication is app-wide. The
app's multi-tenancy is schema-only (`tenant_id` columns); the IdP relationship
is one per deployment. A singleton row avoids inventing per-tenant auth that
nothing else in the system expects.

### Secret encryption — `secret-box`

New `apps/server/src/crypto/secret-box.ts`:

- `encrypt(plaintext: string, key: Buffer): string` — random 12-byte IV,
  AES-256-GCM, returns `base64(iv).base64(tag).base64(ciphertext)`.
- `decrypt(envelope: string, key: Buffer): string` — verifies the tag; throws
  on tamper/wrong key.
- `loadKey(env): Buffer` — decodes `CONFIG_ENCRYPTION_KEY` (base64, 32 bytes);
  throws a clear startup error if missing/short **when it is needed** (i.e.
  `mode=oidc` or secrets are being written). `mode=disabled` deployments do not
  need the key set.

The key never leaves the process; decrypted secrets live only in memory inside
the effective-config holder (below), never logged, never returned by any API.

### Runtime config — `AuthConfigService` + `fastify.authConfig`

New `apps/server/src/services/auth-config.ts`. Responsibilities:

- `load()` — read the singleton row (creating a default `disabled` row on first
  boot; see seeding), decrypt secrets, return an `EffectiveAuthConfig`.
- `update(input, actorUserId)` — validate, encrypt any provided secrets,
  persist, return the sanitized (secret-free) view.
- `sanitized()` — the shape the `GET` endpoint returns (no secret values;
  `clientSecretSet`/`signingSecretSet` booleans instead).

The effective config replaces `env` as the auth source of truth:

```ts
export interface EffectiveAuthConfig {
  mode: 'disabled' | 'oidc';
  issuerUrl: string | null;
  clientId: string | null;
  clientSecret: string | null; // decrypted, in-memory only
  signingSecret: string | null; // decrypted, in-memory only
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
```

A new plugin `apps/server/src/plugins/auth-config.ts` (registered immediately
after `prisma`, before `auth`/`oidc`) decorates:

```ts
fastify.authConfig = {
  current: EffectiveAuthConfig,     // mutable holder
  reload(): Promise<void>,          // re-read row + swap `current`
};
```

`auth.ts`, `oidc.ts`, `auth` routes, and `users.ts` stop reading `env.*` and
read `fastify.authConfig.current` instead. The three `users.ts` functions
change signature from `(…, env: Env)` to `(…, cfg: EffectiveAuthConfig)`;
`computeRole`, `isEmailAllowed`, `upsertFromIdentity` are pure over the config
shape and their existing tests adapt to pass a config object.

### Reconfiguration without restart

On a successful admin save:

1. `AuthConfigService.update(...)` persists (encrypting secrets).
2. `fastify.authConfig.reload()` swaps `current`.
3. `fastify.oidc.reconfigure()` (new method on the oidc plugin) re-runs
   discovery with the new issuer/client/secret and hot-swaps
   `fastify.oidc.config`. The existing background retry loop is reused: a
   reconfigure resets the attempt counter and triggers an immediate discovery.

**Login-state cookie signing change.** `@fastify/cookie` binds its signing
secret at registration (`auth.ts:63` registers `cookie` with
`env.LOGIN_STATE_SECRET`), so a rotating secret can't use `signed: true`.
Instead the short-lived login-state cookie is signed with our own HMAC-SHA256
using `authConfig.current.signingSecret` (helper in `auth.ts`: `sign(value)` /
`verify(value)`), so the secret can rotate without re-registering the plugin or
restarting. `@fastify/cookie` is still registered (for cookie parsing/setting)
but without a global secret. Session cookies are random opaque tokens (not
signed), so they are unaffected. This is the one security-sensitive code change
and gets dedicated tests (sign/verify roundtrip, tamper rejection, rotation
invalidates in-flight login states but not sessions).

### Endpoints — `apps/server/src/routes/settings-auth.ts`

Registered under `/api/settings/auth`. Authorization guard: when
`authConfig.current.mode === 'disabled'`, open (bootstrap — no roles exist
yet); when `mode === 'oidc'`, require `request.user.role === 'ADMIN'` (else
403). The guard is a small `requireAuthAdmin` preHandler.

- `GET /api/settings/auth` → `AuthConfigResponse`: every non-secret field, plus
  `clientSecretSet`, `signingSecretSet`, `redirectUri` (so the admin can paste
  it into the IdP), `discoveryStatus` (`'connected' | 'unavailable' |
'disabled'`), and `lastDiscoveryError?` (sanitized message only). Never
  returns secret values.
- `PUT /api/settings/auth` → update non-secret fields and optionally
  set/replace `clientSecret` (write-only; omitted = unchanged, explicit `null`
  = clear). Switching `mode` to `oidc` is rejected (422 `TEST_REQUIRED`) unless
  a test has passed for the current values in this request (server re-runs the
  test as part of the enable path — the UI cannot bypass it).
- `POST /api/settings/auth/test` → run discovery against the given
  issuer/client/secret (falling back to stored values for omitted fields)
  **without persisting**; return `{ ok, error? }`. Powers the "Test
  connection" button and the enable gate.
- `POST /api/settings/auth/rotate-signing-secret` → generate a new 32-byte
  signing secret, encrypt + store, reload. Response `{ rotated: true }`.
  Invalidates in-flight logins only.

### Break-glass recovery

> **SUPERSEDED (2026-07-18, issue #222).** The paragraph below specifies that
> the override is **persisted** to the `auth_config` row. That behaviour was a
> bug: clearing the flag restored nothing, so the deployment kept serving an
> open API with the UI showing no sign of it. The override is now applied
> **in memory for that boot only** and never writes to the row. Do not
> re-introduce the DB write from this text — see
> `docs/design/2026-07-18-issue-222-break-glass-override.md` for the current
> design. Retained below as a historical record of the original design.

`RECOVERY_DISABLE_AUTH` stays in `env.ts` as an optional boolean. On boot, if
`true`, the `auth-config` plugin forces the row's `mode` to `disabled`
(persisted, logged at `warn`: "RECOVERY_DISABLE_AUTH set — authentication
forced OFF; unset and restart after fixing config"). The operator regains UI
access, fixes the config, unsets the flag, and restarts.

### Web — Authentication panel

New `apps/web/src/components/settings/authentication-form.tsx`, rendered on
`_app.settings.tsx`. Visibility: shown when the current user is `ADMIN` (from
`/api/auth/me`) **or** when auth is disabled (`authRequired: false`). Fields
mirror the config. Details:

- Secret inputs (`clientSecret`) are `type="password"`, showing `•••• configured`
  with a **Replace** control when `clientSecretSet`; left blank = unchanged.
- **Test connection** button calls `POST …/test`, shows the result inline.
- A status pill: Connected (green) / Waiting for issuer (amber) / Disabled (grey),
  driven by `discoveryStatus`.
- The **redirect URI** shown read-only with copy-to-clipboard.
- An **Enable authentication** toggle that only unlocks after a successful test
  in the current session; disabling is always allowed.
- Client-side validation mirrors the shared Zod schema (same pattern as the
  audit-hardening forms: bounds enforced before submit, `onError` toasts,
  no silent dead submits).

Shared schemas live in `packages/shared/src/schemas/auth-config.ts`
(`authConfigUpdateSchema`, `authConfigResponseSchema` as a non-strict
`z.ZodType<AuthConfigResponse>` per the response-schema convention), consumed
by both the route validation and the form.

### Migration & backward compatibility

- Prisma migration `add_auth_config` creates the table.
- **Env-as-one-time-seed:** on first boot, if the table is empty and OIDC env
  vars are present, `AuthConfigService.load()` seeds the row from them once
  (encrypting the secrets with `CONFIG_ENCRYPTION_KEY`). If the table is empty
  and no OIDC env vars are present, it creates a default `disabled` row.
  Afterwards env OIDC values are ignored.
- `env.ts`: OIDC/AUTH vars become **seed-only** (kept optional; the
  `superRefine` "required when AUTH_MODE=oidc" block is removed — the DB is now
  authoritative and the settings API enforces completeness). `CONFIG_ENCRYPTION_KEY`
  and `RECOVERY_DISABLE_AUTH` are added.
- `.env.example`, `docker/docker-compose.yml`, the Keycloak dev profile, and
  the auth runbook are updated: dev seeds from the existing Keycloak env or is
  configured once through the UI.

## Testing

**Unit**

- `secret-box`: encrypt→decrypt roundtrip; tamper (flipped byte) throws; wrong
  key throws; envelope format stable.
- `AuthConfigService`: seed-from-env on empty table; default-disabled on empty
  table with no env; `sanitized()` never includes secret values; `update`
  leaves an omitted secret unchanged and clears on explicit null.
- login-state HMAC sign/verify: roundtrip; tampered value rejected; rotation
  invalidates old-secret signatures.
- `computeRole` / `isEmailAllowed`: unchanged behavior over the new config shape.

**Integration (testcontainers)**

- `GET` never returns `clientSecret`/`signingSecret`.
- `PUT` to enable OIDC without a passing test → 422 `TEST_REQUIRED`.
- `POST /test` against an unreachable issuer → `{ ok: false, error }`, nothing
  persisted.
- Successful save reloads config and swaps discovery (assert `discoveryStatus`
  transitions).
- Auth guard: endpoints open when `mode=disabled`; 403 for a VIEWER when
  `mode=oidc`; 200 for an ADMIN.
- `RECOVERY_DISABLE_AUTH=true` forces `mode=disabled` on boot.

**Web**

- Panel renders admin-only (and when auth disabled); hidden for a VIEWER.
- Secret field masks when configured; blank submit leaves it unchanged.
- Test-connection success unlocks the enable toggle; failure keeps it locked.
- Validation mirrors the schema (out-of-range values blocked before submit).

## Risks

1. **Reverses a just-merged design.** PR #116 shipped env-based OIDC days ago;
   this unwinds the env plumbing. Mitigated by env-as-one-time-seed (no hard
   break) and keeping the openid-client discovery/session logic intact — only
   the _config source_ changes.
2. **Auth is security-critical.** The login-state cookie signing moves from
   `@fastify/cookie` to an in-house HMAC. This is the highest-risk change and
   is covered by dedicated sign/verify/rotation/tamper tests plus review.
3. **Bootstrap window.** While `mode=disabled` the settings API is open by
   necessity. This matches today's `AUTH_MODE=disabled` behavior (the whole API
   is already open then) — enabling auth is the action that closes it.
4. **Encryption-key loss.** If `CONFIG_ENCRYPTION_KEY` is lost/changed, stored
   secrets can't be decrypted; the operator re-enters the client secret (and
   rotates the signing secret) through the UI. Documented in the runbook.

## Out of scope / deferred

- Per-tenant auth configuration (singleton only).
- Multiple IdPs / social providers.
- A secrets manager / KMS integration (single symmetric key is sufficient for
  a self-hosted single-host deployment; KMS is a future option).
- Role enforcement on routes (already deferred in PR #116, issue tracked
  separately).
