# Security and Operations

Moved verbatim from `CLAUDE.md`. Paths are relative to the repository root.

## Security, Privacy, and Robustness

### 1. API and Configuration (Web/API Profile)

- **Authentication:** Three modes: `disabled` (default; every request gets an anonymous ADMIN principal), `local` (username + password accounts with ADMIN or VIEWER roles, argon2id-hashed via `@node-rs/argon2` with OWASP-tuned versioned parameters — no bcrypt; last-admin removal is guarded), and `oidc` (`openid-client`, IdP-backed). In both `local` and `oidc`, all `/api/*` except `/api/auth/*` require a valid session cookie; `/healthz` and `/readyz` are never gated. Never infer safety from the HTTP method. _Recorded exception:_ `disabled` mode intentionally waives per-endpoint authentication for trusted-network deployments — the deployment owner's accepted risk, not a precedent for new unauthenticated endpoints.
- **Authorization (RBAC):** `ADMIN`/`VIEWER` are stored on `users.role` and enforced route-level: mutating `/api/*` routes require ADMIN — VIEWERs get 403 (`plugins/auth.ts` `requiresAdmin` hook; the read-only scenario preview POST is the one exempt mutation route). The `settings/auth` endpoints are admin-gated whenever the auth mode is not `disabled` (both `local` and `oidc`). Restrict OIDC access via `OIDC_ALLOWED_EMAIL_DOMAINS`/`OIDC_ALLOWED_EMAILS` or IdP-side assignment.
- **Resource ownership:** N/A in v1 by design — single-tenant deployment with shared data; every authenticated user sees the same tenant's data and roles gate mutations (the `tenant-context` plugin scopes access).
- **Sessions:** opaque tokens stored SHA-256-hashed (`Session.tokenHash`); cookie `lcm_session` (or `__Host-lcm_session` on https) is `httpOnly` + `SameSite=Lax` (CSRF mitigation for state-changing requests); TTL `SESSION_TTL_HOURS` (default 12). Revoke by deleting the `sessions` row.
- **Secrets at rest:** the OIDC client secret and login-state signing secret are AES-GCM-encrypted under `CONFIG_ENCRYPTION_KEY` (`src/crypto/secret-box.ts`). Decryption is **mode-aware**: only a stored `oidc` row needs those columns, so only `oidc` reads them. A missing/wrong key there **fails safe** — auth forces `mode=disabled` and preserves the encrypted columns. A stored `local` or `disabled` row never reads them, so an unreadable key cannot degrade it; and saving a non-oidc mode clears both columns, so the leftover ciphertext that made the old degrade reachable no longer accumulates. Never "fix" an oidc decryption error by wiping columns; restoring the correct key recovers the config.
- **Infrastructure isolation:** in production only the `web` service publishes a host port; `db` and `server` are reachable solely on the internal compose network. All prod services run `cap_drop: ALL`, `no-new-privileges`, nonroot, with mem/cpu/pid limits. Keep it that way.
- **Configuration:** app settings live in the **database**, not env vars — `auth_config` (encrypted singleton, managed via Settings → Authentication) and `TenantSettings` (thresholds, lead time). `docker/.env` is bootstrap-only: infra values plus first-boot OIDC seed vars (`AUTH_MODE`, `OIDC_*`) that are read exactly once while `auth_config` is empty and ignored forever after. Do NOT add new env-based app settings — extend the Settings UI instead. Env is validated at startup (`src/env.ts`, Zod).
- **Input validation:** validate every request body/query with the `@lcm/shared` Zod schema _inside_ the handler before touching the database. Bound inputs: 1 MiB body limit, rate-limit (`RATE_LIMIT_MAX`, default 300/min/IP).
- **Security verification target:** OWASP ASVS 5.0 **Level 1** (recorded 2026-07-16). Develop with the OWASP Top 10 in mind — SQLi (Prisma parameterizes, don't use raw queries), XSS (React escapes; never `dangerouslySetInnerHTML` untrusted data), SSRF (the OIDC discovery endpoint is the known SSRF-adjacent surface while auth is disabled — see `docs/operations.md`).

### 2. Browser and Framework Security (Frontend Profile)

- Security headers: the API sets them via `@fastify/helmet`; the SPA's Content Security Policy is owned by nginx (`docker/nginx.conf`). HSTS is deliberately off — internal deployments serve plain HTTP (documented in `src/server.ts`).
- Serialize explicit allowlisted response DTOs — the `@lcm/shared` Zod response schemas are that boundary. Never send raw Prisma entities, credential-bearing objects, or internal models to clients.
- Never return raw database, stack, or dependency errors — the `error-handler` plugin sanitizes responses; log details server-side (the pino request id correlates them) and keep responses generic.
- Middleware already in place: helmet, CORS off unless `CORS_ORIGIN` allowlist is set, rate-limit, under-pressure load shedding, body limit (all registered in `src/server.ts`), and graceful shutdown (10s, `src/index.ts`). Do not remove or bypass any of it to make something work.

### 3. Privacy and Sensitive Data

- Data classification is in the Project Overview. Minimize collection; there is no analytics/tracking.
- Retention and deletion: capacity data lives for the life of the deployment (backups via `pg_dump`); user accounts and sessions are removed per "Offboarding a user" in `docs/operations.md` (delete the `users`/`sessions` rows). Access is gated by the auth mode and roles above.
- `authorization`/`cookie` headers are redacted from logs (pino redaction) — keep secrets and sensitive personal data out of logs, traces, fixtures, and test snapshots.
- High-risk changes MUST state their security and privacy impact and update the relevant notes in `docs/operations.md` (container hardening, SSRF caveat, offboarding) when they change them.

## System Architecture and SRE Practices

### 1. State, Logs, and Database Changes

- **State:** the server holds no local state; everything persistent lives in Postgres. Server processes are replaceable.
- **Logs:** structured JSON to stdout via pino (Fastify's built-in logger): level from `LOG_LEVEL`, UUID request ids (`genReqId`), `authorization`/`cookie` headers redacted, `pino-pretty` in dev only. Never write log files.
- **Database migrations:** Prisma migrations only (`apps/server/prisma/migrations/`). The container entrypoint runs `prisma migrate deploy` on every boot (idempotent) before starting Fastify. Never mutate the schema by hand or via raw SQL. Test migrations against representative data; use an expand/migrate/contract strategy when zero-downtime compatibility is required. Destructive or irreversible migrations require explicit approval, a verified backup (`pg_dump`), and a recovery plan.

### 2. Observability

- Correlate everything through the pino request id. There is no OpenTelemetry/tracing in v1 — don't claim or fabricate metrics that don't exist; `/healthz` (liveness) and `/readyz` (readiness) are the operational probes.
- Never place secrets or unbounded/high-cardinality attacker-controlled values in log attributes.

### 3. Resilience (Design Failure Behavior Explicitly)

- **Fail safe, not crash:** an undecryptable **OIDC** secret degrades to `mode=disabled` (decryption is mode-aware — `local`/`disabled` rows never read the encrypted columns, so they keep enforcing); OIDC discovery retries with capped exponential backoff (2s→32s); `RECOVERY_DISABLE_AUTH=true` is the break-glass path. `AUTH_STRICT_BOOT=true` inverts the degrade: the server refuses to boot instead of failing open, leaving `RECOVERY_DISABLE_AUTH` as the only path to an open API. Both degrades are **in-memory for that boot only** and never mutate the stored auth config (issue #222): clearing the cause and restarting restores the configured mode with no operator action. Follow this pattern for new failure modes: degrade with a clear log line, never take the app down or destroy state — a security override MUST NOT outlive the condition that caused it.
- Every external call needs a timeout and defined cancellation behavior; retry only transient failures with bounded attempts, exponential backoff with jitter, and an overall deadline. Use idempotency keys or deduplication when retries could duplicate side effects.
- Security, authorization, and integrity failures MUST NOT silently fall back to weaker defaults — the `disabled` degrade above (OIDC-secret decrypt failure only) is the one documented, deliberate exception, and it logs loudly.
- Test dependency loss, restart, timeout, and recovery behavior for critical paths (the auth-config suite is the model).

### 4. CI/CD and Software Supply Chain

- **CI** (`.github/workflows/ci.yml`, every PR + push to `main`): a `verify` job (install → `prisma generate` → `generate-routes` → `pnpm format:check` → `pnpm lint` → `pnpm typecheck` → `pnpm test` with Testcontainers Postgres → `pnpm build`), an `oidc-e2e` job (Playwright, `pnpm --filter @lcm/web test:e2e:oidc`), and a `semgrep` job (`semgrep scan --config p/default apps packages --error`). All three run on every PR and must be green before merge. A fourth job, `golden-path-e2e`, is **promotion-only**: `if: github.base_ref == 'main' || github.ref == 'refs/heads/main'`, so it runs on the `dev → main` sync PR and pushes to `main` but is skipped on `feat/* → dev` PRs (project-owner decision, 2026-07-28, issue #334). It boots a Postgres 18 service + seeds it + starts the API on `:8090` with `RATE_LIMIT_MAX=2000`, then runs `pnpm --filter @lcm/web test:e2e`; `retries: 0` and a **skipped test fails the run** (`playwright/support/forbid-skipped-reporter.ts` — the specs' `test.skip` preconditions otherwise exit 0 and a fully-skipped run looks green). A GitHub `if:`-skipped job counts as passing for branch protection, so it is safe to require on `main`. All actions are pinned to commit SHAs and CI container/service images to `tag@digest` — pin any new ones too.
- **Least-privilege CI permissions:** workflows declare explicit minimal `permissions:` blocks (`ci.yml` is `contents: read`). Keep it that way — untrusted code and metadata MUST NOT gain access to privileged credentials or release assets.
- **Images** (`publish-images.yml`): multi-arch (amd64/arm64) GHCR images with provenance + SBOM. Immutable artifacts: compose is pull-only; `main` → `:latest`, push to `dev` → `:dev` (may lag the latest green commit), release `vX.Y` → `:X.Y`; pin deployments with `LCM_IMAGE_TAG`. Build once, promote the same artifact.
- **Dependabot:** weekly for github-actions, npm, docker (Dockerfile digests), and docker-compose. Never merge dependency PRs without the normal verification gates. DHI caveat: see Build and Development — `dhi.io` has no Dependabot credentials, so DHI digest bumps are not reliably proposed.
- **Scanning:** SAST is a blocking gate — the `semgrep` CI job above runs `--config p/default` over `apps` and `packages` with `--error` on every PR (added by PR #306, closing the 2026-07-16 recorded gap). Secret-scanning and container-image scanning are still **not** configured as blocking gates (_recorded gap_) — adding either is a normal-risk change that needs a recorded decision on blocking thresholds; any suppression must be time-bounded.
