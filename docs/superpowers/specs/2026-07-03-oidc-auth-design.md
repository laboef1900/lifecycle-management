# OIDC Authentication Integration — Design

- **Date:** 2026-07-03
- **Status:** Draft — pending user review (D1–D4 chosen while user was AFK; confirm before planning)
- **Issue:** none yet — repo convention is issue-driven; an auth epic should be filed before implementation
- **Review:** draft was adversarially reviewed by a 5-lens critic panel (security, ops, YAGNI,
  library-reality, codebase-fit); 9 must-fix and 9 should-fix findings folded in below

## Context

LCM (vSphere memory capacity forecasting) currently has **no authentication**: the Fastify 5 API
(`apps/server`) serves every request as tenant `'default'` via
`apps/server/src/plugins/tenant-context.ts`, and the React 19 SPA (`apps/web`) has no login UI or
route guards. Auth/OIDC is the declared 3-month milestone (`docs/vision.md`,
`docs/operations.md`, `README.md`). The deployment is strictly same-origin: distroless nginx
serves the SPA and reverse-proxies `^/(api|healthz|readyz)` to the server container, with a
strict CSP (`connect-src 'self'`, `form-action 'self'`). No TLS ships in the repo (internal
plain-HTTP deployment; HSTS deliberately disabled). Postgres is the only stateful store (no
Redis). ~5 concurrent internal users expected.

## Goals

1. Authenticate all `/api` access via OIDC Authorization Code flow + PKCE against any
   spec-compliant IdP (discovery-based; Keycloak, Entra ID, Auth0, Google, Authentik…).
2. Server-side sessions in Postgres with HttpOnly cookies (BFF pattern) — no tokens in browser JS.
3. `admin`/`viewer` roles derived from a configurable IdP claim and **stored** on the User row
   (JIT-provisioned at first login) — not enforced in v1; the stored role anchors the future
   audit log and a follow-up enforcement issue.
4. Zero-lockout rollout: existing deployments keep working unauthenticated until they opt in.
5. Dev/CI/e2e keep working without a real IdP.

## Non-goals

- Multi-tenancy enforcement (tenant stays `'default'`; claims→tenant mapping is future SaaS work).
- Role **enforcement** (v1: any authenticated user has full access; enforcement is a follow-up
  issue — see Open Questions for what it must exempt).
- Local username/password auth, multi-IdP, account linking.
- Audit log (separate roadmap item; this design only creates the User rows it will need).
- RP-initiated logout at the IdP (would require persisting the ID token, which we deliberately
  discard; local logout only).
- Deep-link return after login (users land on `/`; ~5 top-level routes make this one click —
  follow-up if ever wanted, with an exact same-origin validation rule).
- TLS termination (deployment concern; design works correctly both behind HTTPS and on plain
  HTTP, with documented caveats).
- Token-mediating BFF for calling third-party APIs on behalf of the user (access tokens are
  discarded after login; only identity matters).

## Decisions log

| #   | Decision                                | Choice                                                                                                                                                                                                                                                                          | Status                                    |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| D1  | Identity provider                       | Generic OIDC via discovery; env-configured issuer. Keycloak used for local dev only.                                                                                                                                                                                            | **ASSUMED** — user was AFK; confirm       |
| D2  | Session model                           | Server-side sessions in Postgres, opaque token in HttpOnly cookie (BFF)                                                                                                                                                                                                         | **ASSUMED** — confirm                     |
| D3  | Rollout                                 | `AUTH_MODE=disabled\|oidc`, default `disabled` with loud prod warning; no boot-time hard requirement                                                                                                                                                                            | **ASSUMED** — confirm                     |
| D4  | Authorization                           | Roles `admin`/`viewer` **derived and stored, not enforced in v1**; JIT provisioning; optional email/domain allowlist as the access boundary                                                                                                                                     | **ASSUMED** (amended by review) — confirm |
| D5  | OIDC client library                     | `openid-client@^6` (certified RP library, ESM; v6 API: `discovery()` → `Configuration`, `buildAuthorizationUrl()`, `randomPKCECodeVerifier()` / `calculatePKCECodeChallenge()`, `authorizationCodeGrant(config, currentUrl, {pkceCodeVerifier, expectedState, expectedNonce})`) | proposed                                  |
| D6  | Cookie handling                         | `@fastify/cookie` only; bespoke session lookup (no `@fastify/session`) — matches repo's hand-rolled style                                                                                                                                                                       | proposed                                  |
| D7  | Login state (state/nonce/PKCE verifier) | Short-lived signed HttpOnly cookie — no DB writes for unauthenticated login attempts                                                                                                                                                                                            | proposed                                  |
| D8  | Role enforcement                        | **Deferred** to a follow-up issue (a read-only `POST /api/clusters/:id/forecast/scenario` falsifies method-based enforcement; with default role `admin` it would be dead code anyway)                                                                                           | decided by review                         |
| D9  | Test IdP                                | `oauth2-mock-server` (8.x) in-process for vitest integration tests; Keycloak compose profile for manual dev; Playwright stays `AUTH_MODE=disabled` in v1                                                                                                                        | proposed                                  |
| D10 | Access boundary                         | Optional `OIDC_ALLOWED_EMAIL_DOMAINS` / `OIDC_ALLOWED_EMAILS` allowlist checked at callback; without it, IdP-side app assignment IS the boundary                                                                                                                                | proposed                                  |
| D11 | Insecure issuers                        | `OIDC_ALLOW_INSECURE` (default `false`) explicitly opts into `http://` issuers (dev/test only); never auto-downgraded                                                                                                                                                           | proposed                                  |

## Alternatives considered

**B. Stateless encrypted-cookie sessions** (`@fastify/secure-session`): no session table, no DB
lookup per request. Rejected: no server-side revocation (logout = best-effort), cookie size
limits, and losing the User-row anchor for the audit-log milestone anyway forces the users table
— at which point the sessions table is marginal cost.

**C. SPA-held tokens (code+PKCE in browser, Bearer headers)**: standard for public SPAs.
Rejected: fights this architecture everywhere — strict CSP (`connect-src 'self'`) blocks IdP
XHR, the fetch wrapper has no header/token plumbing, tokens in JS enlarge the XSS blast radius,
and same-origin cookies are simply free here.

## Architecture

Flow (all same-origin except the IdP redirects):

1. Unauthenticated browser hits any route → SPA `beforeLoad` (or 401 from API) → router sends
   user to `/login` page → user clicks "Sign in" → full-page navigation to `GET /api/auth/login`.
2. Server generates `state`, `nonce`, PKCE verifier; seals them in a signed login-state cookie
   (attributes below); 302 to IdP authorization endpoint.
3. IdP authenticates user, 302 back to `GET /api/auth/callback?code=…&state=…`.
4. Server validates state/nonce, exchanges code (PKCE + client secret), validates ID token via
   `openid-client`; checks the email allowlist if configured (reject → `/login?error=access_denied`,
   no User row); upserts User by `(issuer, subject)`; computes and stores role from claim;
   creates Session row (random 256-bit token, SHA-256 hash stored); sets session cookie;
   302 to `/`.
5. Every `/api` request: auth plugin `onRequest` hook reads cookie → looks up session by token
   hash → attaches `request.user` → tenant-context resolves `request.tenantId` from the user
   (still `'default'` in v1). Missing/expired session → 401 envelope
   `{error:{code:'UNAUTHENTICATED',…}}`. Request-time auth never contacts the IdP.
6. `POST /api/auth/logout` → deletes Session row, clears cookie → 204; the client then does a
   full-page navigation to `/login`. Note: if the IdP has an active SSO session it may instantly
   re-authenticate on the next sign-in; full logout happens at the IdP (documented in
   operations.md).

### Server components

- **`plugins/auth.ts`** (fp()-wrapped): decorates `request.user`; global `onRequest` hook
  enforcing auth for `/api/*` except `/api/auth/*`; health routes are unprefixed and untouched.
  In `AUTH_MODE=disabled`, the hook attaches a synthetic anonymous principal and skips
  enforcement (single code path downstream).
- **Registration order** (amends `buildServer()` in `apps/server/src/server.ts`):
  … sensible → error-handler → **prisma → auth → tenant-context** → routes. Auth needs
  `fastify.prisma` at registration; the prisma plugin adds no hooks, so moving it up is
  behavior-neutral.
- **OIDC module** (`plugins/oidc.ts`): `openid-client@^6` discovery runs in a **background retry
  loop** (capped backoff, max 60s between attempts) setting an internal `oidcReady` flag — the
  server listens immediately. Until ready, `GET /api/auth/login` redirects to
  `/login?error=idp_unavailable` and logs at error level; existing sessions keep working.
  **`/readyz` stays DB-only** — compose gates the web container on server health, so readiness
  must never depend on the IdP. `OIDC_ALLOW_INSECURE=true` passes `allowInsecureRequests` to
  discovery (loud startup warning); required by the mock-IdP tests and the local Keycloak
  profile, never in production.
- **`routes/auth.ts`**: `GET /api/auth/login` (also fails fast with `scheme_mismatch` if
  `request.protocol` ≠ `APP_BASE_URL` scheme — trustProxy + nginx's X-Forwarded-Proto make this
  reliable, and it prevents the silent Secure-cookie login loop), `GET /api/auth/callback`,
  `POST /api/auth/logout`, `GET /api/auth/me` (returns `{authRequired, user?}` — the SPA's
  single source of truth; works in both modes; also the one-command way for operators to verify
  auth is actually on).
- **`services/sessions.ts` / `services/users.ts`**: session create/lookup/destroy with
  opportunistic expiry cleanup (delete that user's expired rows at login); user upsert with role
  computation from `OIDC_ROLE_CLAIM`/`OIDC_ADMIN_VALUES`, else `OIDC_DEFAULT_ROLE`.
- **tenant-context change**: resolve `tenantId` from `request.user.tenantId` (falls back to
  `'default'`); auth runs first per the registration order above.
- **Shared errors** (`packages/shared/src/errors.ts`): add `UNAUTHENTICATED` to
  `SERVICE_ERROR_CODES` and an `UnauthenticatedError` (401) ServiceError subclass so the hook's
  rejection flows through the existing error-handler envelope instead of falling through as
  `CLIENT_ERROR`. (`FORBIDDEN` arrives with role enforcement, not now.)

### Environment (validated in `env.ts` Zod schema)

- `AUTH_MODE`: `disabled` | `oidc`, default `disabled`. Loud warning when `disabled` in
  production. **Fail-closed refinement:** if `AUTH_MODE` is _absent_ while any `OIDC_*` var or
  `LOGIN_STATE_SECRET` is present, refuse to boot with an actionable error (partial config is a
  misconfiguration, not a choice). Explicit `AUTH_MODE=disabled` with OIDC vars present is
  allowed (deliberate escape hatch during an IdP outage) but warns loudly.
- When `oidc` (Zod refinement requires all): `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET`, `APP_BASE_URL` (canonical public origin — redirect URI is
  `${APP_BASE_URL}/api/auth/callback`; drives cookie `Secure`; **must exactly match the origin
  in the user's address bar, including scheme**), `LOGIN_STATE_SECRET` (≥32 chars; signs only
  the login-state cookie).
- Optional: `SESSION_TTL_HOURS` (default 12), `OIDC_SCOPES` (default `openid profile email`),
  `OIDC_ROLE_CLAIM`, `OIDC_ADMIN_VALUES` (CSV), `OIDC_DEFAULT_ROLE` (default `admin`),
  `OIDC_ALLOWED_EMAIL_DOMAINS` / `OIDC_ALLOWED_EMAILS` (CSV allowlist, checked at callback),
  `OIDC_ALLOW_INSECURE` (default `false`).
- Startup warning when `AUTH_MODE=oidc` and _neither_ an allowlist _nor_ a role claim is
  configured (see Security notes).

### Data model (Prisma; additive migration)

```prisma
model User {
  id          String    @id @default(cuid())
  tenantId    String    @default("default") @map("tenant_id")
  issuer      String
  subject     String
  email       String?
  displayName String?   @map("display_name")
  role        UserRole  @default(VIEWER)
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")
  lastLoginAt DateTime? @map("last_login_at")
  sessions    Session[]

  @@unique([issuer, subject])
  @@map("users")
}

model Session {
  id        String   @id @default(cuid())
  tokenHash String   @unique @map("token_hash")
  userId    String   @map("user_id")
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now()) @map("created_at")
  expiresAt DateTime @map("expires_at")

  @@map("sessions")
}

enum UserRole {
  ADMIN
  VIEWER
}
```

Role is re-computed from claims at each login (IdP is source of truth); the stored role is a
cache for the future audit log and enforcement work.

### Web components

- **Routing restructure (the largest web-side change):** `__root.tsx` becomes providers +
  `<Outlet/>` via `createRootRouteWithContext` (types the router context; one bootstrap fetch of
  `/api/auth/me` supplies auth state through it). A new **pathless layout route `_app.tsx`**
  owns AppShell and the `beforeLoad` guard (redirect to `/login` when `authRequired && !user`).
  Existing route files move under it (`index.tsx` → `_app.index.tsx`, likewise
  `clusters.index`, `clusters.$id`, `clusters.new`, `settings`); `routeTree.gen.ts` regenerates.
  `login.tsx` sits outside `_app` — genuinely outside the shell (no command palette/shortcuts),
  and outside the guard (no redirect loop).
- **`routes/login.tsx`**: product name + "Sign in" button as a plain anchor to
  `/api/auth/login`; error banner rendered only for the fixed error enum below.
- **`lib/api-client.ts`**: on any HTTP 401 (status, not error-code string), hard-redirect to
  `/login` (skip when already there); explicit `credentials: 'same-origin'`.
- **User menu**: avatar/initials dropdown in the Header `ml-auto` group (existing
  `dropdown-menu.tsx`): name, email, role badge, Sign out — logout POST then **full-page
  navigation** to `/login` so stale router context cannot pass the guard. When
  `authRequired=false` (disabled mode) the guard passes everyone and no user menu renders —
  the app looks exactly as today.

### Security notes

- **Session cookie**: `HttpOnly; SameSite=Lax; Path=/`; `Secure` + `__Host-` prefix iff
  `APP_BASE_URL` is https. Opaque random 256-bit value; only the SHA-256 hash at rest. The
  session cookie is **not** signed — the token is self-authenticating via its DB hash — so
  rotating `LOGIN_STATE_SECRET` only aborts in-flight logins, never established sessions.
- **Login-state cookie**: signed (`LOGIN_STATE_SECRET`), `HttpOnly; SameSite=Lax;
Path=/api/auth`; `Secure` iff https; 10-min TTL; cleared at callback on success and error.
  `Lax` is required — the IdP→callback hop is a cross-site top-level redirect (`Strict` breaks
  100% of logins). Accepted limitation: concurrent login tabs overwrite it; the older tab's
  callback fails with `state_mismatch`.
- **Access boundary**: with `OIDC_DEFAULT_ROLE=admin` and no allowlist, **IdP-side client/app
  assignment IS the access-control boundary**. Public-signup IdPs (Google without `hd`
  restriction, Auth0 with open signup, Entra apps without assignment requirement) must not be
  used without `OIDC_ALLOWED_EMAIL_DOMAINS`/`OIDC_ALLOWED_EMAILS`. The server warns at startup
  when neither an allowlist nor a role claim is configured.
- **Offboarding window**: sessions outlive IdP-side deactivation for up to `SESSION_TTL_HOURS`
  (default 12h) because request-time auth never calls the IdP. Revocation runbook:
  `DELETE FROM sessions WHERE user_id = …` (documented in operations.md). `SESSION_TTL_HOURS`
  is the exposure knob.
- **CSRF**: `state` protects login; `SameSite=Lax` + POST protects logout; the API is JSON-only
  with no CORS credentials, so cross-site forgery surface on domain routes is minimal — revisit
  if `CORS_ORIGIN` + credentials are ever enabled together.
- **Rate-limit**: tighter per-IP limit on `/api/auth/*` (code exchange is expensive; login is
  unauthenticated by definition).
- **Logging**: never log tokens; cookie/authorization headers already redacted; raw IdP
  `error`/`error_description` values are logged server-side, never echoed to the browser.
- **Plain HTTP**: cookies work (no `Secure` flag) but credentials transit cleartext — document
  in operations.md that HTTPS in front of nginx is strongly recommended once auth is on; most
  IdPs require https redirect URIs for non-localhost anyway.

### Error handling

- **IdP unreachable** (`AUTH_MODE=oidc`): background discovery retry (see OIDC module above);
  `/readyz` unaffected; login attempts get `/login?error=idp_unavailable`; established sessions
  unaffected.
- **Callback errors** (state mismatch, code-exchange failure, IdP `error=` param, allowlist
  rejection): redirect to `/login?error=<code>` with a **fixed enum** — `login_failed`,
  `state_mismatch`, `idp_error`, `access_denied`, `idp_unavailable`, `scheme_mismatch`. The
  login page renders copy only for known values; details go to server logs.
- **Session expiry mid-use**: next API call 401s → api-client redirects to `/login`; after
  re-login the user lands on `/`.

### Dev / CI / e2e strategy

- **Default dev**: `AUTH_MODE=disabled` — `pnpm dev` works exactly as today.
- **Auth dev**: `docker/docker-compose.dev.yml` gains an optional `keycloak` profile with a
  realm-import JSON (test realm, client, one test user); `.env.example` documents the matching
  `OIDC_*` values including `OIDC_ALLOW_INSECURE=true` (Keycloak serves http locally).
- **Server integration tests**: `oauth2-mock-server` (8.x, devDependency, in-process; per-test
  claims via its `beforeTokenSigning` hook; serves http, so tests set `OIDC_ALLOW_INSECURE`)
  covers login/callback/session/allowlist/role-mapping paths in vitest without containers; unit
  tests for role mapping, cookie flags, session expiry, env refinements.
- **Playwright**: existing suite runs `AUTH_MODE=disabled` unchanged. No browser-level auth spec
  in v1 (it would need its own Playwright project with a second server in oidc mode and would
  duplicate the vitest coverage) — file a follow-up if wanted.
- **CI**: no new services (the mock is in-process).

## Rollout

1. Ship with `AUTH_MODE` defaulting to `disabled`: image upgrade changes nothing; server logs a
   prominent warning in production while disabled.
2. **The compose diff is part of this feature**: `docker/docker-compose.yml` must add
   `AUTH_MODE` and all OIDC/session vars (plus the currently-missing `TRUST_PROXY`) to the
   server service's `environment:` allowlist — the compose file allowlists env explicitly, so
   without this, vars set in `.env` silently never reach the container. Enabling auth requires
   a compose file at/above this version.
3. Operator enables by setting `AUTH_MODE=oidc` + `OIDC_*` + `LOGIN_STATE_SECRET` +
   `APP_BASE_URL` in `.env`. Docs updated: README, docker/README, operations.md (incl. secret
   rotation for `LOGIN_STATE_SECRET`/`OIDC_CLIENT_SECRET`, offboarding runbook), .env.example.
4. **Mandatory post-enable verification** (documented in docker/README):
   `curl -i http://<host>/api/clusters` must return **401**, and
   `curl http://<host>/api/auth/me` must return `{"authRequired":true}`. Any other result means
   auth is NOT enabled (most likely the compose allowlist or `.env` is stale).
5. Migrations (`users`, `sessions`) auto-apply at container boot via existing `entrypoint.ts` —
   additive only; instant rollback = revert image tag (tables are inert when unused).
6. First admin: role claim mapping or `OIDC_DEFAULT_ROLE=admin` — no seeded local account.

## Open questions (for user review)

1. **Confirm/override D1–D4** (chosen while you were AFK): generic OIDC; Postgres BFF sessions;
   `AUTH_MODE` opt-in rollout; roles derived-but-not-enforced with JIT provisioning.
2. Real production origin + whether a TLS terminator fronts nginx (affects `Secure` cookies and
   IdP redirect-URI registration; design works either way).
3. If v1 **must** enforce roles after all: it ships whole (server enforcement + hidden admin
   controls) and must exempt `POST /api/clusters/:id/forecast/scenario` and `/api/auth/*` from
   any non-GET=admin rule.
4. Should an auth epic issue be filed before implementation, per repo convention? (Recommended.)
5. Unrelated, noticed during survey: is the untracked `docs/audit-fix-report-2026-07.html`
   meant to be committed?
