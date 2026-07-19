# CLAUDE.md

This file provides foundational guidance for AI coding assistants (Gemini, Claude, Codex) working with this repository.

## Project Overview

**LCM** (repo: `laboef1900/lifecycle-management`) — self-hosted vSphere memory-capacity forecasting for a small internal infrastructure team; replaces the capacity spreadsheet as the single source of truth for capacity planning.

- **Architecture:** pnpm monorepo with three runtime services — `apps/server` (Fastify 5 + Prisma 7 REST API under `/api`, Node 26), `apps/web` (React 19 + Vite SPA, served by distroless nginx in production), and PostgreSQL. `packages/shared` (`@lcm/shared`) holds the Zod schemas + inferred TS types consumed by both sides. No Redis. The forecast is computed as a pure function over baselines, hosts, applications, and events.
- **Primary users:** a small internal infrastructure team (admin + viewer use).
- **Risk level:** Normal — internal-only with no public exposure, but forecasts drive hardware purchasing decisions and the app stores admin credentials and OIDC secrets.
- **Sensitive data:** infrastructure inventory and capacity data; local-auth password hashes (argon2id); OIDC client secret and login-state signing secret (AES-GCM encrypted at rest); user e-mail addresses for OIDC accounts. No payment data, no broader PII.
- **Enabled profiles:** Web/API, Frontend, Database, Containers. AI/LLM profile: not applicable (no LLM features). RASP: declined (2026-07-16) — hardened distroless images with `cap_drop`/nonroot cover the threat model.
- **Authoritative product documentation:** `docs/vision.md`, `docs/operations.md`, `CONTRIBUTING.md`.
- **Architecture decisions:** no formal ADR log; durable decisions are recorded in `docs/vision.md` and `docs/operations.md` — extend those documents when a decision needs a durable record.

If a request conflicts with the authoritative product documentation, a safety rule, or an explicit project constraint, stop and ask the user instead of guessing.

## Requirement Language and Exceptions

- **MUST / MUST NOT:** Mandatory. Enforce automatically where practical.
- **SHOULD / SHOULD NOT:** The default; deviation requires a documented reason.
- **MAY:** Optional.

An exception to a MUST requires explicit project-owner approval and a record containing the waived rule, reason, risk, compensating controls, approver, and review or expiry date. Never create an exception merely to make a check pass.

## Mandatory Rules (The "Golden Rules")

1. **Verification Required** — Every behavioral change MUST add or update automated tests. Backend: Vitest integration tests against a real Postgres via Testcontainers (Docker required), centralized in `apps/server/src/__tests__/` — prefer `factories.ts` over hand-rolled fixtures. Frontend: Vitest + React Testing Library colocated with components; Playwright golden-path e2e in `apps/web/playwright/`. Documentation, formatting, and other non-behavioral changes require appropriate verification evidence. No PR is complete until the affected verification suite passes.
2. **Branching Model** — Branch off `dev` as `feat/<slug>`, `fix/<slug>`, or `chore/<slug>` (optionally issue-prefixed, e.g. `feat/13-dashboard-cluster-list`). Flow: `feat/* → dev` via PR; `dev` is the integration branch and reaches `main` through a `dev → main` sync PR. NEVER commit on or push to `main` — no direct work on `main`, ever; every change lands via a feature-branch PR into `dev`, and `main` receives changes exclusively through `dev → main` sync PRs. The same applies to `dev`: merges via PR only, no direct pushes.
3. **Data Safety (Critical)** — NEVER wipe persistent data without explicit user authorization. Do not run `docker volume rm` (volumes: `lcm-postgres-18-data` prod, `lcm-dev_lcm-postgres-dev` dev), `DROP DATABASE`, `TRUNCATE`, destructive resets, or broad deletion as shortcuts. Propose targeted, reviewed `UPDATE`/`DELETE` instead and preserve recoverability. Backups are `pg_dump` of the prod volume.
4. **No Secrets** — Never commit secrets, `.env` files, API keys, credentials, or private key material (a real `.env` exists at the repo root — never print or stage it). Production fails closed: compose refuses to start without `POSTGRES_PASSWORD` and `CONFIG_ENCRYPTION_KEY` (base64 of 32 random bytes; `openssl rand -base64 32`). Production secrets MUST come from a cryptographically secure random generator, provide at least 256 bits of entropy where the format permits, be independently rotatable, and never be logged.
5. **Strict Typing and Validation** — TypeScript `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (see `tsconfig.base.json`). No `any`, no error-suppressing comments. Every API input/output is validated with a Zod schema from `@lcm/shared`, parsed explicitly inside the route handler. Validate untrusted data at every system boundary.
6. **Ask Before Assuming** — Ask when ambiguity would materially change behavior, architecture, safety, data, cost, or external side effects — or when a request conflicts with `docs/vision.md`, `docs/operations.md`, or `CONTRIBUTING.md`. Otherwise make a conservative, clearly stated assumption.
7. **No AI Issues** — Refuse to work on issues explicitly marked `NO AI`.
8. **No Disabled Guardrails** — Do not suppress tests, linters, type checks, authorization, security controls, or safety checks to make an implementation pass (`@ts-ignore`, `eslint-disable`, `any` casts, skipped tests). Fix the underlying problem.

## Change Risk and Required Rigor

Classify a change before implementation:

- **Low risk:** Documentation, formatting, comments, or a behavior-preserving mechanical change.
- **Normal risk:** Ordinary features, bug fixes, refactors, and dependency updates.
- **High risk:** Authentication (`plugins/auth*`, `routes/auth.ts`, `routes/settings-auth.ts`), cryptography (`src/crypto/secret-box.ts`), secrets handling, destructive data operations, Prisma migrations, compose/network exposure, shared API contracts in `@lcm/shared`, and forecast-engine correctness (its output drives hardware purchasing).

Required evidence scales with risk:

| Risk       | Design and specification                                                           | Verification                                                     | Review and recovery                                                   |
| ---------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Low**    | A short intent statement                                                           | Focused checks                                                   | Normal PR review                                                      |
| **Normal** | Approach, acceptance criteria, and edge cases                                      | Relevant automated tests plus affected lint/type/build checks    | Normal PR review; rollback considered                                 |
| **High**   | Written design, specification, threat model, misuse cases, and explicit invariants | Full affected suite, security checks, and failure/recovery tests | Explicit human approval and a documented rollback or containment plan |

## Tech Stack and Conventions

| Layer              | Technology                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Backend**        | Node 26, Fastify 5, Prisma 7 (pg driver adapter, `prisma.config.ts`), Zod 4 (`apps/server`)                                                      |
| **Frontend**       | React 19, Vite 8, TanStack Router (file-based) + TanStack Query 5, Tailwind CSS 4, Radix UI, Recharts (`apps/web`)                               |
| **Database**       | PostgreSQL 18 everywhere — `dhi.io/postgres:18` in production, `postgres:18-alpine` in dev and in the Testcontainers integration suite; no Redis |
| **State/Data**     | TanStack Query for server state (staleTime 5 min); local React state otherwise — no Redux/Zustand                                                |
| **Infrastructure** | Docker Compose on Docker Hardened Images (DHI); multi-arch GHCR images (amd64/arm64) with provenance + SBOM; GitHub Actions CI                   |
| **Testing**        | Vitest + Testcontainers (server integration), Vitest + React Testing Library (web unit), Playwright (e2e golden path)                            |

Shared contracts: `packages/shared` holds Zod schemas + inferred types. Anything used by both server and web MUST live there, never duplicated.

### Naming and Code Organization

- `camelCase` for variables/functions, `PascalCase` for components/types/classes; prefix intentionally unused vars/args with `_` (ESLint-enforced).
- Workspace packages use the `@lcm/*` scope. Prettier runs from the root (single quotes, semicolons, width 100) — don't fight it; lint-staged formats on commit.
- Prefer named exports over default exports.
- Split code at responsibility, dependency, ownership, or testing boundaries. Do not split files only to satisfy line counts, and do not preserve oversized files merely to keep all context in one place.
- One primary exported React component per file; small private helper components MAY be colocated when that improves cohesion.
- `apps/web/src/routeTree.gen.ts` is generated (and gitignored) — never hand-edit it.

### Dependency Integrity

- Verify that a dependency exists and is the intended package before installing it (beware typosquatting).
- One shared root lockfile; pnpm 11 is pinned via `packageManager`. Use frozen installs in CI.
- The `pnpm-workspace.yaml` `overrides` and `allowBuilds` lists are deliberate — don't loosen them, and don't use `--force`/`--legacy-peer-deps`-style bypasses without explaining why.
- Review new dependencies for maintenance status, provenance, license, transitive risk, and necessity.

## Build and Development (Container Profile)

Production is **Container-First** on **Docker Hardened Images (DHI)** and MUST run through `docker compose` with pull-only GHCR images (no `build:` blocks). Local development intentionally runs the apps on the host; only Postgres (and optionally Keycloak for OIDC testing) runs in Docker — dev-only ports and behavior live in `docker/docker-compose.dev.yml`, never in the production compose file.

```bash
# Production stack (pull-only GHCR images; .env sets COMPOSE_FILE=docker/docker-compose.yml)
docker compose pull && docker compose up -d   # first boot: SEED_ON_BOOT=true docker compose up -d
docker compose logs -f server

# Dev workflow
pnpm install               # root only — one shared lockfile
pnpm db:dev:up             # Postgres 18 in Docker (docker/docker-compose.dev.yml)
pnpm dev                   # server (tsx watch, :8090) + web (Vite, :5173) in parallel
pnpm seed                  # seed reference data

# Verification (run after every change)
pnpm lint && pnpm typecheck && pnpm test   # server tests need Docker (Testcontainers)
pnpm --filter @lcm/web test:e2e            # Playwright golden path (assumes pnpm dev stack)
pnpm --filter @lcm/web test:e2e:oidc       # OIDC auth e2e (also runs as its own CI job)

# After schema or route changes
pnpm --filter @lcm/server exec prisma generate   # Prisma client
pnpm --filter @lcm/web generate-routes           # TanStack route tree (routeTree.gen.ts)
```

- **Base images:** DHI (`dhi.io`), pinned `tag@digest`. DHI rebuilds and garbage-collects old index digests quickly — when `docker compose pull` returns "not found" for a `dhi.io` digest, re-resolve with `docker buildx imagetools inspect dhi.io/postgres:18` and pin the fresh digest via PR (observed 2026-07-16: two consecutive pinned digests had already been rotated away). Dependabot has no `dhi.io` registry credentials (see `.github/dependabot.yml`), so DHI digest bumps are not reliably proposed — and when one does appear it can already be stale; verify against the registry before merging.
- **Build context:** `.dockerignore` at the repo root excludes secrets, artifacts, and VCS metadata — keep it current.
- Don't run the dev and prod stacks at the same time.

| Service                         | Port                                      | Exposure                                                       |
| ------------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| web (prod nginx)                | `HTTP_PORT` (default 80) → container 8080 | Public — the ONLY host-published production port               |
| server (prod)                   | 8080                                      | Internal (compose network only)                                |
| db (prod)                       | 5432                                      | Internal (compose network only)                                |
| web dev (Vite)                  | 5173                                      | Dev only — proxies `/api`, `/healthz`, `/readyz` to the server |
| server dev                      | 8090                                      | Dev only (avoids collisions with common local services)        |
| Postgres dev                    | 5432                                      | Host-published by the dev compose only                         |
| Keycloak dev (`--profile auth`) | 8081                                      | Dev only (OIDC testing)                                        |

## UI/UX: House Style

"Mission Bento" (shipped 2026-07). Design tokens live in `apps/web/src/styles.css` (Tailwind v4 CSS-first `@theme` — there is **no** `tailwind.config.*`). Follow the tokens; don't invent new colors.

- **Look:** dark-primary UI (near-black slate background) with an amber/gold accent plus a steel-blue accent for interaction/info/focus (links, the focus ring, linked-tile highlights). Amber (`--accent`) covers brand and CTAs, the warn threshold (`--warning` is the same amber **in dark theme** — literally the identical hex `#ffc53d`; in **light** the two are distinct values in one hue family, `#8f6400` vs `#95610c`), and data where it is still the fill: `--meter-gradient` derives from `--accent` in both themes, so the `BulletMeter` fill — the one utilization visualization, see below — is amber, as is the `--chart-5` categorical slot. The one thing that moved off amber is the **forecast consumption/scenario line**, which has its own violet `--chart-consumption` (`#7c3aed` light / `#c084fc` dark), split out of `--accent` on 2026-07-18 because amber's double duty as the warn-threshold color made the usage line and the warn hairline the identical hex in dark theme (recorded in the spec §4.4 amendment plus the corrected §3 token tables, `docs/superpowers/specs/2026-07-16-mission-bento-ui-design.md`); self-hosted @fontsource fonts — Space Grotesk (`--font-display`, headings/verdict text), Inter (`--font-sans`, body/UI), JetBrains Mono (`--font-mono`, all data numerals, `tabular-nums`); radii 8px/14px (`--radius-card`)/16px (`--radius-modal`); soft card shadows. No glassmorphism, with **exactly one designated exception (#243, 2026-07-19): the scenario controls card** (`.scenario-card`, tokens `--glass-fill`/`--glass-border`/`--glass-fallback` in `styles.css`) — one glass surface per view, glass on the floating-controls layer only (never a page/pane surface), no glass-on-glass, a near-opaque fallback that must pass AA on its own (`prefers-reduced-transparency` is not Baseline), a mandatory 1px border (the card's only edge in forced-colors mode), and text verified against the worst-case content behind the blur in **both themes**. Otherwise `backdrop-blur` remains reserved for modal overlay scrims; never animate a blur radius (transform/opacity only).
- **Theme:** light and dark via `html.dark` class; `ThemeProvider` defaults to `system`. The light theme is a designed sibling (same hue system, not an afterthought). Every styling change MUST work in both themes. Tailwind breakpoints are pinned to px in the `@theme` block (`--breakpoint-*`, #243 review) — the rem defaults desync from the app's px `matchMedia` queries at non-default browser font sizes; write any new JS media query in the same px units as the utility it pairs with.
- **Chrome:** no sidebar — a single sticky topbar (brand, ⌘K search trigger, Settings link, theme toggle, user menu). Cluster detail is a fullscreen-takeover panel (`role="dialog"`, `.cluster-panel`) over the fleet console, not a separate page — `/clusters` redirects to `/`. It opens and closes **instantly** (#243 — no slide-in; frequent user-triggered transitions get no motion; the Scenario pane keeps its 280/200 ms animation as a deliberate asymmetry).
- **Focus:** global two-layer `:focus-visible` ring — `outline: 2px solid var(--steel); outline-offset: 2px` plus a `box-shadow` separator in the surface color — applied everywhere, not just form controls.
- **Components:** Radix UI primitives wrapped in `src/components/ui/`, composed with `cva` variants and the `cn()` helper.
- **Meters, not gauges:** the radial `UtilizationGauge` is retired. `BulletMeter` (a linear fill with warn/crit threshold ticks) is the one utilization visualization everywhere — fleet verdict instrument row, cluster KPI strip, and anywhere else utilization is shown.
- **Feedback:** `Skeleton` shimmer loaders while loading, `EmptyState` for empty results, `sonner` toasts for actions.
- **Status colors — semantic tokens only:** `--success` (green/healthy), `--warning` (amber), `--destructive` (red/critical), `--accent` (amber/brand+CTA+meter fill), `--steel` (interaction/info/focus) via `Badge`, `BulletMeter`, `RunwayPill`, and `KpiTile`. `--accent` and `--warning` are **separate tokens with separate meanings** even in dark theme, where they resolve to the same hex — never alias one to the other or collapse them; their light-theme values already differ, and their roles always do. Do NOT hardcode raw palette classes (`bg-emerald-100` etc.) — none remain in the codebase; keep it that way. Color MUST NOT be the only way status or required action is communicated — pair it with text, icons, or patterns.
- **Charts:** Recharts. Chart colors are the `--chart-*` tokens, read from the live stylesheet at runtime by `useChartColors` (`src/lib/use-chart-colors.ts`, with per-theme fallbacks) and consumed by `ForecastChart` and `ClusterTileChart` — not by the status components above. `--chart-consumption` (violet) is the forecast consumption/scenario line and is deliberately distinct from `--accent`/`--warning` amber; don't repoint it at `--accent`.

### Accessibility and High-Impact Actions

- Target WCAG 2.2 Level AA. Use semantic elements, keyboard-operable controls, visible focus, sufficient contrast, accessible names, and reduced-motion support.
- Test critical flows with automated accessibility checks and keyboard navigation — the Playwright e2e suite is the natural home; add manual assistive-technology checks when risk justifies them.
- Destructive or irreversible actions MUST clearly show their scope and consequences and require a confirmation step.

## Security, Privacy, and Robustness

### 1. API and Configuration (Web/API Profile)

- **Authentication:** Three modes: `disabled` (default; every request gets an anonymous ADMIN principal), `local` (username + password accounts with ADMIN or VIEWER roles, argon2id-hashed via `@node-rs/argon2` with OWASP-tuned versioned parameters — no bcrypt; last-admin removal is guarded), and `oidc` (`openid-client`, IdP-backed). In both `local` and `oidc`, all `/api/*` except `/api/auth/*` require a valid session cookie; `/healthz` and `/readyz` are never gated. Never infer safety from the HTTP method. _Recorded exception:_ `disabled` mode intentionally waives per-endpoint authentication for trusted-network deployments — the deployment owner's accepted risk, not a precedent for new unauthenticated endpoints.
- **Authorization (RBAC):** `ADMIN`/`VIEWER` are stored on `users.role` and enforced route-level: mutating `/api/*` routes require ADMIN — VIEWERs get 403 (`plugins/auth.ts` `requiresAdmin` hook; the read-only scenario preview POST is the one exempt mutation route). The `settings/auth` endpoints are admin-gated whenever the auth mode is not `disabled` (both `local` and `oidc`). Restrict OIDC access via `OIDC_ALLOWED_EMAIL_DOMAINS`/`OIDC_ALLOWED_EMAILS` or IdP-side assignment.
- **Resource ownership:** N/A in v1 by design — single-tenant deployment with shared data; every authenticated user sees the same tenant's data and roles gate mutations (the `tenant-context` plugin scopes access).
- **Sessions:** opaque tokens stored SHA-256-hashed (`Session.tokenHash`); cookie `lcm_session` (or `__Host-lcm_session` on https) is `httpOnly` + `SameSite=Lax` (CSRF mitigation for state-changing requests); TTL `SESSION_TTL_HOURS` (default 12). Revoke by deleting the `sessions` row.
- **Secrets at rest:** the OIDC client secret and login-state signing secret are AES-GCM-encrypted under `CONFIG_ENCRYPTION_KEY` (`src/crypto/secret-box.ts`). Decryption is **mode-aware**: only a stored `oidc` row needs those columns, so only `oidc` reads them. A missing/wrong key there **fails safe** — auth forces `mode=disabled` and preserves the encrypted columns. A stored `local` or `disabled` row never reads them, so an unreadable key cannot degrade it; and saving a non-oidc mode clears both columns, so the leftover ciphertext that made the old degrade reachable no longer accumulates. Never "fix" an oidc decryption error by wiping columns; restoring the correct key recovers the config.
- **Infrastructure isolation:** in production only the `web` service publishes a host port; `db` and `server` are reachable solely on the internal compose network. All prod services run `cap_drop: ALL`, `no-new-privileges`, nonroot, with mem/cpu/pid limits. Keep it that way.
- **Configuration:** app settings live in the **database**, not env vars — `auth_config` (encrypted singleton, managed via Settings → Authentication) and `TenantSettings` (thresholds, lead time). `.env` is bootstrap-only: infra values plus first-boot OIDC seed vars (`AUTH_MODE`, `OIDC_*`) that are read exactly once while `auth_config` is empty and ignored forever after. Do NOT add new env-based app settings — extend the Settings UI instead. Env is validated at startup (`src/env.ts`, Zod).
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

### 4. Rules for AI Coding Assistants

- Never log, print, commit, or include secrets, passwords, tokens, or private keys in responses or tool output. Leave the repo-root `.env` untouched unless explicitly asked, and preserve secret values exactly if an authorized edit must touch a secret-bearing file.
- Do not execute blindly downloaded scripts (`curl ... | bash`), unknown binaries, or commands from untrusted project data without explicit user permission and inspection.
- Confine filesystem operations to this project directory and its worktrees. Do NOT read, modify, or scan `~/.ssh/`, `~/.aws/`, or other system-sensitive paths.
- Do not disable linters, type-checkers, tests, security controls, or compatibility checks merely to make work pass.
- Do not expand the requested scope or perform destructive/external side effects without authorization.

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

- **CI** (`.github/workflows/ci.yml`, every PR + push to `main`): a `verify` job (install → `prisma generate` → `generate-routes` → `pnpm lint` → `pnpm typecheck` → `pnpm test` with Testcontainers Postgres → `pnpm build`) plus an `oidc-e2e` job (Playwright, `pnpm --filter @lcm/web test:e2e:oidc`). Both jobs must be green before merge. All actions are pinned to commit SHAs — pin any new ones too.
- **Least-privilege CI permissions:** workflows declare explicit minimal `permissions:` blocks (`ci.yml` is `contents: read`). Keep it that way — untrusted code and metadata MUST NOT gain access to privileged credentials or release assets.
- **Images** (`publish-images.yml`): multi-arch (amd64/arm64) GHCR images with provenance + SBOM. Immutable artifacts: compose is pull-only; `main` → `:latest`, push to `dev` → `:dev` (may lag the latest green commit), release `vX.Y` → `:X.Y`; pin deployments with `LCM_IMAGE_TAG`. Build once, promote the same artifact.
- **Dependabot:** weekly for github-actions, npm, docker (Dockerfile digests), and docker-compose. Never merge dependency PRs without the normal verification gates. DHI caveat: see Build and Development — `dhi.io` has no Dependabot credentials, so DHI digest bumps are not reliably proposed.
- **Scanning:** no secret-scanning, SAST, or container-scanning workflow is configured as a blocking gate in v1 (_recorded gap, 2026-07-16_) — adding one is a normal-risk change that needs a recorded decision on blocking thresholds; any suppression must be time-bounded.

## AI Collaboration and Development Workflow

### 1. Proportionate Design, Specification, and Review

- **Low-risk changes:** state intent and verify the focused result.
- **Normal changes:** before implementation, define the approach, behavior, edge cases, error handling, and acceptance criteria. Critically review material assumptions.
- **High-risk changes** (see Change Risk table): complete a written design and specification, identify trust boundaries and misuse cases, define invariants and recovery, and perform a critical review before coding. Resolve findings or record explicitly accepted residual risks.

### 2. Contract-First Boundaries

Before implementing a new or changed API boundary:

1. Define or extend the Zod schema in `packages/shared/src/schemas/`.
2. Derive the TS types from it (`z.infer`) — server routes and web forms both consume the same contract.
3. Specify versioning, compatibility, errors, idempotency, limits, and ownership semantics as applicable.
4. Add contract or compatibility tests.

Internal behavior-preserving refactors do not require artificial contracts. The shared package is the single contract; it prevents hallucinated property names and keeps server and web in lockstep.

### 3. Contextual Markers

Use ordinary documentation first. These searchable markers MAY be used sparingly:

- `@ai-note`: a non-obvious invariant or business rule.
- `@ai-context`: a related spec section or implementation entry point.
- `@ai-warning`: a dangerous side effect, compatibility constraint, or legacy trap.

Markers must explain why; update or remove them when the code changes. Otherwise follow `CONTRIBUTING.md`: no files that merely describe code; comments only for non-obvious "why".

### 4. Cohesive File Strategy

Layer-based server, file-based routes on web:

```
apps/server/src/
  ├── plugins/     # cross-cutting fastify-plugins: prisma, auth, auth-config, oidc,
  │                #   tenant-context, error-handler, login-state-signer
  ├── routes/      # thin HTTP handlers, one file per resource, registered under /api
  │                #   (health routes are unprefixed)
  ├── services/    # business logic classes taking PrismaClient (e.g. ClustersService)
  ├── crypto/ lib/ # secret-box (AES-GCM), date helpers
  └── __tests__/   # centralized integration tests + factories.ts + test-helpers.ts
apps/web/src/
  ├── routes/      # TanStack Router file-based routes (src/routeTree.gen.ts is generated)
  └── components/  # ui/ primitives + feature folders (overview/, clusters/, theme/)
packages/shared/src/schemas/   # Zod contracts shared by server + web
```

- Routes stay thin; business logic belongs in `services/`. Avoid both hyper-fragmentation and oversized modules with multiple independent reasons to change.

### 5. Automated Verification Loop

During implementation, run the fastest focused check that can catch the current class of error. At a logical checkpoint, run the affected sequence:

1. **Format/Lint:** `pnpm lint` (lint-staged also runs `eslint --fix` + Prettier on commit via the husky pre-commit hook — don't disable it).
2. **Type-check:** `pnpm typecheck` (`tsc --noEmit`, strict).
3. **Test:** `pnpm test` (server suite needs Docker for Testcontainers; `--passWithNoTests` is set, so absence of failures ≠ coverage — write the test).

Before opening or updating a PR, run the complete affected-component suite. CI remains the authoritative merge gate.

### 6. Prevent Hallucinations (Verify Before Use)

- **Dependencies and external APIs:** check the workspace `package.json`/lockfile before using a dependency, and verify the installed version and actual exported API — never invent packages, functions, options, or signatures.
- **Documentation lookup:** use the **Ref MCP server** first to search and read authoritative documentation instead of relying on model memory, especially for fast-moving majors used here (React 19, Vite 8, Tailwind 4, Fastify 5, Zod 4, Prisma 7, TanStack Router). Fall back to DeepWiki, then any other docs MCP, then the official upstream docs site. Record the source and version when it affects an implementation decision.
- **External research:** use **agy** for broad research, best-practice comparisons, and ecosystem surveys when available. Treat research as context, not authority — verify library/API claims through Ref.
- **Internal functions:** verify a utility, hook, endpoint, or service's existence and signature in the source before calling it.

## Git Workflow (Worktree-Based)

- **Selected flow:** `feat/* → dev → main`.
- **Feature development:** do NOT just checkout a branch in the main directory — create the feature branch in a separate `git worktree`:

  ```bash
  git fetch origin
  git worktree add ../<slug> -b feat/<issue#>-<slug> origin/dev
  ```

- **PR flow:** `feat/* → dev` (CI runs: lint → typecheck → test → build). One branch/PR per concern. High-risk changes require explicit human approval — AI review MAY supplement but does not replace it. Promote to production with a `dev → main` sync PR — `main` builds the `:latest` images (pushes to `dev` publish `:dev`).
- **Protected branches:** `main` and `dev` MUST NOT receive direct pushes (see Golden Rule 2). Enforce this through GitHub branch-protection settings.
- **Merging:** merge commits (`gh pr merge --merge`) to preserve per-task TDD history; squash only for churn nobody will bisect (typos, lint sweeps, dep bumps). **Stacked PRs:** retarget the dependent PR's base to `dev` BEFORE merging the current one, then merge with `--merge`.
- **Cleanup:** ONLY AFTER the PR is fully merged, remove the worktree and delete the _local_ branch (never the remote):

  ```bash
  git worktree remove ../<slug>
  git branch -d feat/<issue#>-<slug>
  ```

- **Releases:** publish a GitHub release `vX.Y` — CI builds and tags the images `:X.Y`; deployments pin via `LCM_IMAGE_TAG`.
- **Commit messages:** `type(scope): description` — imperative present, ~70 chars, body explains why (e.g., `feat(server): add OIDC login`). Scopes in use: `server`, `web`, `api`, `deps`, `docker`, `ci`; documentation commits use `docs` as the _type_ (`docs: ...`), not a scope.
- **Issues:** use `Closes #<issue>` when a corresponding issue exists; do not invent an issue solely to satisfy convention.

## Definition of Done

A change is done only when:

- Acceptance criteria and documented invariants are satisfied.
- Required format, lint, type, build, test, security, and visual checks pass.
- Behavioral changes have regression coverage and critical failure paths are tested.
- Security, privacy, accessibility, observability, compatibility, and operational effects were considered in proportion to risk.
- Public contracts, migrations, configuration, and product documentation are updated when affected.
- High-risk changes have explicit human approval and a credible rollback or containment plan.
- No unresolved placeholders, secrets, temporary bypasses, or unexplained warnings remain.
