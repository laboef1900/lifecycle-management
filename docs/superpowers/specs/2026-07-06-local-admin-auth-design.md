# Local admin account — design

- **Date:** 2026-07-06
- **Status:** Proposed (awaiting review)
- **Branch:** `feat/local-admin-auth`
- **Author:** Simon + Claude (brainstorming)

## 1. Context & problem

LCM authenticates with **OIDC only** today. `AuthConfig.mode` is a two-value
enum: `disabled` (open — every request gets an anonymous `ADMIN` principal) and
`oidc` (all `/api/*` except `/api/auth/*` require a valid `lcm_session` cookie).
CLAUDE.md states the intent explicitly: *"OIDC only — there are no local
passwords, so no bcrypt/argon2."*

That leaves a **first-run bootstrap gap**. To secure the app you must be in
`oidc` mode, which requires a working IdP. The only "secured" state is coupled to
an external dependency, and the `disabled → oidc` transition is a cliff: the
moment you save `mode = oidc`, every route needs a session you don't have yet,
and Settings is now admin-gated. If the OIDC config is even slightly wrong you
are locked out, with only `RECOVERY_DISABLE_AUTH=true` + restart to recover
(which reopens the entire API).

**We want a persistent local admin account** so an operator can secure the app
and log in without an IdP, configure OIDC from an authenticated session, and keep
the local admin afterward as a break-glass path.

### Decisions taken during brainstorming

1. **Motivation:** first-run bootstrap (secure + configure OIDC), local admin
   retained as break-glass.
2. **Credential form:** a persistent **username + password** account (not a
   one-time token).
3. **Auth model:** the local admin can secure the app **on its own** — a new
   `local` mode, no OIDC required.
4. **Hashing:** **argon2id** via `@node-rs/argon2`.

This consciously reverses the "no local passwords / no argon2" line in CLAUDE.md;
that line will be updated as part of this work.

## 2. Goals / non-goals

**Goals**
- A `local` auth mode that gates the API using only local username+password
  accounts.
- Local login also usable in `oidc` mode as a break-glass session source.
- Create/manage local accounts (create, disable, reset password, delete) from
  Settings → Authentication.
- Argon2id password hashing; brute-force resistance; no user enumeration.
- Bootstrap the first local admin from today's open `disabled` mode via the
  Settings UI — **no new env-based app settings**.

**Non-goals (YAGNI)**
- Self-service password reset via email, MFA/TOTP, password-strength meters
  beyond a length policy, account recovery questions.
- SCIM / user provisioning, per-resource ACLs (role stays the existing
  `ADMIN`/`VIEWER`; route-level RBAC remains as-is).
- Merging a local account with an OIDC identity (they are distinct users).
- A new break-glass env var — the existing `RECOVERY_DISABLE_AUTH` covers
  lockout recovery.

## 3. Auth model & modes

`AuthConfig.mode` becomes a three-value enum. The `@lcm/shared` schemas and every
hardcoded `'disabled' | 'oidc'` union are widened to include `'local'`.

| Mode | API gate | Session sources |
|------|----------|-----------------|
| `disabled` | open (anonymous `ADMIN`) — **unchanged** | — |
| `local` *(new)* | gated | local username+password only |
| `oidc` | gated | OIDC **and** local admin (break-glass) |

**Gate reuse (key simplification).** `plugins/auth.ts` already treats
`mode === 'disabled'` as anonymous-admin and *every other mode* as
"session required for `/api/*` except `/api/auth/*`". A session minted by local
login is an ordinary `Session` row, so the gate honors it with **no change to its
core logic**. The only auth-plugin-adjacent change is `/auth/me` (see §6).

**Local login availability.** Local login works whenever an **enabled** local
admin exists — so in `oidc` mode it is the permanent break-glass. To enforce
strict OIDC-only later, disable or delete the local accounts.

**Transition guards** (enforced in the settings-auth update handler + a Zod
`superRefine`):
- Cannot switch **into** `local` unless ≥1 enabled local user with a password
  hash exists (prevents instant lockout).
- Cannot switch **into** `oidc` unless OIDC config is valid (existing rule).
- Switching to `disabled` is always allowed (the "open the door" direction).

## 4. Data model

Reuse the existing `User` model rather than a parallel identity system. Local
accounts are `issuer = 'local'`, `subject = <username>`; the existing
`@@unique([issuer, subject])` gives unique local usernames, and `role`
(`ADMIN`/`VIEWER`) already exists.

New columns on `User` (one additive migration; all nullable/defaulted, inert for
existing OIDC rows):

```prisma
passwordHash        String?   @map("password_hash")        // argon2id PHC string; null for OIDC users
passwordUpdatedAt   DateTime? @map("password_updated_at")
failedLoginAttempts Int       @default(0) @map("failed_login_attempts")
lockedUntil         DateTime? @map("locked_until")
disabled            Boolean   @default(false)
```

- The PHC string is self-contained (salt embedded) — **no separate salt column**.
- `disabled` lets an admin revoke a local account without deleting its audit row;
  a disabled account cannot log in and does not satisfy the `local`-mode
  transition guard.
- **Alternative considered:** a separate `LocalCredential` table for
  identity/credential separation. Rejected for now — the codebase already treats
  `User` as *the* auth principal (`SessionUser`, the gate, sessions cascade), so
  columns-on-`User` is the lower-friction, cohesive choice.

## 5. Password hashing

`@node-rs/argon2` (verified: publishes `linux-x64-musl` + `linux-arm64-musl`
prebuilts → runs in the Alpine-based distroless runtime with no node-gyp; napi
musl binaries are self-contained, so no extra `.so` copying).

- `hash(password, options) → Promise<string>` (PHC string), default algorithm
  **Argon2id**; `verify(hashed, password) → Promise<boolean>`.
- **Params (OWASP-tuned, tunable constants):** `memoryCost: 19456` (19 MiB),
  `timeCost: 2`, `parallelism: 1`, `outputLen: 32`. Acceptable under the server
  container's `mem_limit: 512m` given a small-team, low-QPS login endpoint.
- Encapsulated in a single `crypto/password.ts` helper (`hashPassword`,
  `verifyPassword`) so params/algorithm can evolve in one place, mirroring the
  existing `crypto/secret-box.ts` boundary.
- **Password policy (Zod):** min length 12, max 200 (argon2 has no bcrypt-style
  72-byte truncation), no other composition rules (length + a KDF beats
  composition rules — OWASP).

## 6. Endpoints & flows

New routes under the already-open `/api/auth/*` and the admin-gated
`/api/settings/auth/*`.

**Authentication (`routes/auth.ts`)**
- `POST /api/auth/local/login` `{ username, password }`
  - Rejected unless mode is `local` or `oidc`.
  - Look up `issuer='local', subject=username`. If missing/disabled/locked or
    password mismatch → **generic 401** (`invalid_credentials`) with no
    distinction between causes (no user enumeration). Verify is always run
    against a dummy hash when the user is absent, to keep timing uniform.
  - On success: reset `failedLoginAttempts`/`lockedUntil`, set `lastLoginAt`,
    mint a `Session` (reuse `SessionService.create`), set the session cookie
    (reuse `sessionCookieName`).
  - On failure: increment `failedLoginAttempts`; set `lockedUntil` with backoff
    past a threshold (§7).
- `POST /api/auth/logout` — **unchanged** (already deletes the session + clears
  the cookie; works for local sessions as-is).
- `POST /api/auth/local/password` — authenticated self-service change; requires
  `{ currentPassword, newPassword }`, re-verifies current password.
- `GET /api/auth/me` — **change required**: currently returns
  `authRequired: false` when `mode !== 'oidc'`. Generalize to
  `authRequired = mode !== 'disabled'` so the web app knows `local` mode requires
  a session. Response gains nothing else.

**Management (`routes/settings-auth.ts`, admin-gated)**
- `GET /api/settings/auth/local-users` → list (`LocalUserSummary`; never the hash).
- `POST /api/settings/auth/local-users` `{ username, password, role }` → create.
- `PATCH /api/settings/auth/local-users/:id` → `{ disabled?, role? }`.
- `POST /api/settings/auth/local-users/:id/reset-password` `{ newPassword }`.
- `DELETE /api/settings/auth/local-users/:id` (guard: cannot delete/disable the
  last enabled admin while mode is `local`).

**Service layer.** Add local methods (`services/users.ts` or a new
`services/local-users.ts` for cohesion): `createLocal`, `verifyLogin`
(encapsulates lockout bookkeeping), `setPassword`, `list`, `setDisabled`,
`delete`, `enabledAdminCount`. `SessionService` is reused unchanged.

**Cookie `Secure` in `local` mode.** `sessionCookieName`/`secure` currently
derive from `appBaseUrl` (an OIDC field, possibly null in `local` mode). Decision:
keep `appBaseUrl` as a **mode-independent** "app base URL" setting so it drives
cookie security in `local` mode too; when unset, fall back to the request
protocol (`request.protocol`, already honoring `TRUST_PROXY`). Documented as a
setup step for `local`-over-HTTPS.

## 7. Brute-force protection

- **Per-route rate limit:** reuse the existing `authRateLimit` pattern
  (`{ rateLimit: { max: 30, timeWindow: '1 minute' } }`) on `/auth/local/login`,
  keyed per-IP, layered on the global 300/min.
- **DB-backed per-account lockout** (12-factor stateless — survives restarts):
  after `N = 5` consecutive failures, set `lockedUntil = now + backoff`
  (e.g. 1 min, doubling, capped at 15 min). A locked account returns the same
  generic 401. Success resets the counter.
- Generic error copy everywhere; failures logged server-side with the request id,
  never echoed.

## 8. Frontend

- **`routes/login.tsx`:** render a username/password form when `mode === 'local'`.
  In `oidc` mode show the OIDC button plus a discreet "Sign in as local admin"
  affordance (break-glass) that reveals the same form. Errors map to existing
  `LoginErrorCode` style. Radix primitives, design tokens, theme-aware
  (light + dark), `Skeleton`/`sonner` per house style.
- **`components/settings/authentication-form.tsx`:** mode selector gains `local`;
  add a Local Accounts panel (list + create + disable + reset). Client-side
  validation from the shared Zod schemas.
- **`lib/auth.ts` / `api-client`:** add `localLogin`, `changePassword`, and the
  local-user management calls; `/auth/me` consumption already exists.

## 9. Shared contracts (`packages/shared/src/schemas`)

Contract-first (extend/define Zod, derive TS types):
- Widen `mode` enum → `['disabled', 'local', 'oidc']` in `authConfigUpdateSchema`,
  `authConfigResponseSchema`, and `AuthConfigResponse`.
- New `auth-local.ts`: `localLoginSchema` (`username`, `password`),
  `createLocalUserSchema` (`username`, `password`, `role`),
  `changePasswordSchema` (`currentPassword`, `newPassword`),
  `resetPasswordSchema` (`newPassword`), `updateLocalUserSchema`
  (`disabled?`, `role?`), `localUserSummarySchema` (id, username, role, disabled,
  lastLoginAt — **no hash**), and a shared `passwordSchema` (length policy).
- `superRefine` on the auth-config update to enforce the §3 transition guards
  (the "≥1 enabled local admin before entering `local`" check needs a count
  passed in, so the final guard lives in the handler; the schema enforces
  shape/among-modes validity).

## 10. Bootstrap & recovery

- **First local admin:** created via Settings → Authentication while in today's
  `disabled` mode (anonymous `ADMIN`). Then switch mode to `local`. No new env
  vars — aligns with CLAUDE.md's "extend the Settings UI."
- **Lockout recovery:** existing `RECOVERY_DISABLE_AUTH=true` + restart drops to
  `disabled` (open), where the operator resets the password/creates an admin in
  Settings, then restarts. Documented in `docs/operations.md`.

## 11. Security considerations (OWASP)

- **A07 Auth failures:** argon2id, generic errors, uniform timing (dummy verify),
  per-account lockout + per-IP rate limit, no user enumeration.
- **Session:** reuse SHA-256-hashed opaque tokens, `httpOnly`, `sameSite=lax`,
  `Secure`/`__Host-` on https, TTL from `sessionTtlHours`. New session per login
  (no fixation). Password change/reset and disable/delete revoke by deleting the
  user's sessions.
- **A02 Crypto:** password hashes are argon2id PHC; never logged, never returned
  (responses use `LocalUserSummary`).
- **A01 Access control:** management endpoints stay behind the existing admin
  gate; "last enabled admin" guard prevents self-lockout.
- **Config at rest:** unchanged — argon2 hashes live in `users`, not the
  AES-GCM-encrypted `auth_config`; `CONFIG_ENCRYPTION_KEY` is unaffected.

## 12. Testing strategy

- **Server (Vitest + Testcontainers), in `__tests__/` with `factories.ts`:**
  login success; wrong password; unknown user (generic + timing); disabled
  account; locked account + backoff + reset-on-success; `/auth/me` per mode;
  transition guards (block `local` with no admin; block deleting last admin);
  break-glass local login in `oidc` mode; password change happy/again-path;
  hashing round-trip via the `crypto/password.ts` helper.
- **Web (Vitest + RTL):** login form render per mode; error states; settings
  Local Accounts panel; auth-state.
- **E2E (Playwright):** `local`-mode golden path — create admin (disabled mode) →
  switch to local → log in → reach dashboard → logout.
- **Build smoke test:** after the image builds, assert the server container can
  `require('@node-rs/argon2')` and hash/verify (guards the distroless
  musl-binary-in-deploy-bundle risk — see §14).

## 13. Migration & rollback

- One additive Prisma migration (`add_local_admin_credentials`) — new nullable/
  defaulted columns; no backfill; existing OIDC users unaffected.
- **Rollback:** set `mode` back to `disabled`/`oidc`; the columns are inert for
  OIDC users. The migration is not destructive, so no down-migration is required
  operationally (Prisma migrations are forward-only here).

## 14. Risks & open items

1. **argon2 native binary in the deploy bundle.** `pnpm deploy --legacy --prod`
   must carry the platform-matched `@node-rs/argon2-linux-*-musl` optional
   dependency into `/home/node/deploy`. Builder and runtime share arch+musl per
   native build, so it should resolve — but this is the one build-integrity risk.
   Mitigation: the §12 build smoke test; verify no `pnpm-workspace.yaml`
   `onlyBuiltDependencies` change is needed (napi packages run no build script).
2. **`Secure` cookie in `local` mode without `appBaseUrl`** — resolved by making
   `appBaseUrl` mode-independent with a request-protocol fallback (§6); confirm
   against `TRUST_PROXY` behavior.
3. **Docs to update:** the CLAUDE.md "OIDC only / no bcrypt/argon2" line, the auth
   section of `docs/operations.md` (new mode, bootstrap, recovery), and any
   `docs/vision.md` auth statement.

## 15. Rough work breakdown (for the plan phase)

1. Shared Zod contracts + widened `mode` enum.
2. Prisma migration + `crypto/password.ts` helper (+ dep add).
3. Service methods (local users, lockout) + unit tests.
4. Auth routes (`local/login`, `local/password`, `/auth/me` change).
5. Settings-auth management routes + transition guards.
6. Web login form + settings panel + api-client.
7. E2E + build smoke test.
8. Docs (CLAUDE.md, operations.md) + CI green.
