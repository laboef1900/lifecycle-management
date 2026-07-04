# CLAUDE.md

This file provides foundational guidance for AI coding assistants (Gemini, Claude, Codex) working with this repository.

## Project Overview

**LCM** (repo: `laboef1900/lifecycle-management`) — self-hosted vSphere memory-capacity forecasting for a small internal infrastructure team; replaces the capacity spreadsheet as the single source of truth for capacity planning.
**Architecture:** pnpm monorepo with three runtime services — `apps/server` (Fastify 5 + Prisma 7 REST API under `/api`, Node 22), `apps/web` (React 19 + Vite SPA, served by distroless nginx in production), and PostgreSQL. `packages/shared` (`@lcm/shared`) holds the Zod schemas + inferred TS types consumed by both sides. No Redis. The forecast is computed as a pure function over baselines, hosts, applications, and events.

## Mandatory Rules (The "Golden Rules")

1.  **Tests Required** — Every change needs a test. No PR is complete without verification. Backend: Vitest integration tests against a real Postgres via Testcontainers (Docker required), centralized in `apps/server/src/__tests__/` — prefer `factories.ts` over hand-rolled fixtures. Frontend: Vitest + React Testing Library colocated with components; Playwright golden-path e2e in `apps/web/playwright/`.
2.  **Branching Model** — Branch off `main` as `feat/<slug>`, `fix/<slug>`, or `chore/<slug>` (optionally issue-prefixed, e.g. `feat/13-dashboard-cluster-list`). Flow: `feat/* → main` via PR. Never push to `main` directly. An `origin/dev` branch exists but is stale (fully merged into `main`) — do not target it.
3.  **Data Safety (Critical)** — NEVER wipe persistent data without explicit user authorization. Do not run `docker volume rm` (volumes: `lcm-postgres-18-data` prod, `lcm-dev_lcm-postgres-dev` dev), `DROP DATABASE`, or `TRUNCATE` as shortcuts. Propose targeted `UPDATE` or `DELETE` instead. Backups are `pg_dump` of the prod volume.
4.  **No Secrets** — Never commit `.env`, API keys, or credentials (a real `.env` exists at the repo root — never print or stage it). Production fails closed: compose refuses to start without `POSTGRES_PASSWORD` and `CONFIG_ENCRYPTION_KEY` (base64 of 32 random bytes; `openssl rand -base64 32`).
5.  **Strict Typing & Validation** — TypeScript `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (see `tsconfig.base.json`). No `any`, no error-suppressing comments. Every API input/output is validated with a Zod schema from `@lcm/shared`, parsed explicitly inside the route handler.
6.  **Ask Before Assuming** — If a request is ambiguous or conflicts with existing decisions (`docs/vision.md`, `docs/operations.md`, `CONTRIBUTING.md`), ask for clarification first.
7.  **No AI Issues** — Refuse to work on issues explicitly marked as `NO AI`.

## Tech Stack & Conventions

| Layer                | Technology                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Backend**          | Node 22, Fastify 5, Prisma 7 (pg driver adapter, `prisma.config.ts`), Zod 4 (`apps/server`)                                                      |
| **Frontend**         | React 19, Vite 8, TanStack Router (file-based) + TanStack Query 5, Tailwind CSS 4, Radix UI, Recharts (`apps/web`)                               |
| **Database**         | PostgreSQL 18 everywhere — `dhi.io/postgres:18` in production, `postgres:18-alpine` in dev and in the Testcontainers integration suite; no Redis |
| **State/Data**       | TanStack Query for server state (staleTime 5 min); local React state otherwise — no Redux/Zustand                                                |
| **Shared contracts** | `packages/shared`: Zod schemas + inferred types. Anything used by both server and web MUST live here                                             |

### Naming Conventions

- `camelCase` for variables/functions, `PascalCase` for components/types/classes; prefix intentionally unused vars/args with `_` (ESLint-enforced).
- Workspace packages use the `@lcm/*` scope. Prettier runs from the root (single quotes, semicolons, width 100) — don't fight it; lint-staged formats on commit.
- **Exports:** Prefer named exports over default exports.

## Build & Development

Production is **Container-First** on **Docker Hardened Images (DHI)**. Local development runs the apps on the host; only Postgres (and optionally Keycloak for OIDC testing) runs in Docker.

```bash
# Dev workflow
pnpm install               # root only — one shared lockfile (pnpm 11, pinned via packageManager)
pnpm db:dev:up             # Postgres 18 in Docker (docker/docker-compose.dev.yml)
pnpm dev                   # server (tsx watch, :8090) + web (Vite, :5173) in parallel
pnpm seed                  # seed reference data

# Verification (run after every change)
pnpm lint && pnpm typecheck && pnpm test   # server tests need Docker (Testcontainers)
pnpm --filter @lcm/web test:e2e            # Playwright golden path (assumes pnpm dev stack)

# After schema or route changes
pnpm --filter @lcm/server exec prisma generate   # Prisma client
pnpm --filter @lcm/web generate-routes           # TanStack route tree (routeTree.gen.ts)

# Production stack (pull-only GHCR images; .env sets COMPOSE_FILE=docker/docker-compose.yml)
docker compose pull
docker compose up -d       # first boot: SEED_ON_BOOT=true docker compose up -d
```

**Ports:**

- Web dev (Vite): `5173` — proxies `/api`, `/healthz`, `/readyz` to the server
- Server: `8090` dev (avoids collisions with common local services) / `8080` prod (compose-internal only)
- PostgreSQL: `5432` — published to the host by the dev compose only; the prod `db` service stays inside the compose network (don't run both stacks at once)
- Web prod: `HTTP_PORT` (default `80`) → nginx container `:8080` — the ONLY host-published production port
- Keycloak (dev OIDC, `--profile auth`): `8081`

## UI/UX: House Style

Design tokens live in `apps/web/src/styles.css` (Tailwind v4 CSS-first `@theme` — there is **no** `tailwind.config.*`). Follow the tokens; don't invent new colors.

- **Look:** warm stone-gray neutrals with an amber/gold accent, IBM Plex Sans + IBM Plex Mono, radii 8/12/16px, soft card shadows. No glassmorphism — `backdrop-blur` is reserved for modal overlay scrims.
- **Theme:** light and dark via `html.dark` class; `ThemeProvider` defaults to `system`. Every styling change must work in both themes.
- **Components:** Radix UI primitives wrapped in `src/components/ui/`, composed with `cva` variants and the `cn()` helper. One primary exported component per file.
- **Feedback:** `Skeleton` shimmer loaders while loading, `EmptyState` for empty results, `sonner` toasts for actions.
- **Status colors — semantic tokens only:** `--success` (green/healthy), `--warning` (amber), `--destructive` (red/critical), `--accent` (amber/info) via `Badge`, `StatusDot`, `RunwayPill`, and `KpiTile`. Do NOT hardcode raw palette classes (`bg-emerald-100` etc.); the few files that do (`host-state-badge.tsx`, `host-eol-pill.tsx`, and `text-emerald-700` deltas in `hosts-tab.tsx`/`items-tab.tsx`) are legacy exceptions, not precedent.
- **Charts:** Recharts.

## Security & Robustness Patterns

### 1. API & Configuration (Secure by Default)

- **Authentication:** OIDC only (`openid-client`) — there are no local passwords, so no bcrypt/argon2. Two modes: `disabled` (default; every request gets an anonymous ADMIN principal) and `oidc` (all `/api/*` except `/api/auth/*` require a valid session cookie; `/healthz` and `/readyz` are never gated).
- **Roles:** `ADMIN`/`VIEWER` are stored on `users.role`, but route-level role enforcement is deferred in v1 — do NOT assume RBAC exists. The `settings/auth` endpoints are admin-gated once `oidc` mode is active. Restrict access via `OIDC_ALLOWED_EMAIL_DOMAINS`/`OIDC_ALLOWED_EMAILS` or IdP-side assignment.
- **Sessions:** opaque tokens stored SHA-256-hashed (`Session.tokenHash`); cookie `lcm_session` (or `__Host-lcm_session` on https); TTL `SESSION_TTL_HOURS` (default 12). Revoke by deleting the `sessions` row.
- **Secrets at rest:** the OIDC client secret and login-state signing secret are AES-GCM-encrypted under `CONFIG_ENCRYPTION_KEY` (`src/crypto/secret-box.ts`). A missing/wrong key **fails safe** — auth forces `mode=disabled` and preserves the encrypted columns. Never "fix" decryption errors by wiping columns; restoring the correct key recovers the config.
- **Infrastructure Isolation:** in production only the `web` service publishes a host port; `db` and `server` are reachable solely on the internal compose network. All prod services run `cap_drop: ALL`, `no-new-privileges`, nonroot, with mem/cpu/pid limits. Keep it that way.
- **Configuration Management:** app settings live in the **database**, not env vars — `auth_config` (encrypted singleton, managed via Settings → Authentication) and `TenantSettings` (thresholds, lead time). `.env` is bootstrap-only: infra values plus first-boot OIDC seed vars (`AUTH_MODE`, `OIDC_*`) that are read exactly once while `auth_config` is empty and ignored forever after. Do NOT add new env-based app settings — extend the Settings UI instead.

### 2. API Robustness

- Validate every request body/query with the `@lcm/shared` Zod schema _inside_ the handler before touching the database.
- Never return raw Prisma/DB errors to the client — the `error-handler` plugin sanitizes responses; log details server-side (the pino request id correlates them) and keep responses generic.
- Middleware already in place (registered in `src/server.ts`): helmet, CORS off unless `CORS_ORIGIN` allowlist is set, rate-limit (`RATE_LIMIT_MAX`, default 300/min/IP), under-pressure load shedding, 1 MiB body limit, graceful shutdown (10s). Do not remove or bypass any of it to make something work.

### 3. AI Assistant Security Guidelines (Rules for the AI Developer)

These rules apply directly to YOU, the AI coding assistant, while working in this repository:

- **OWASP Integration:** Actively develop with the **OWASP Top 10** in mind — SQLi (Prisma parameterizes, don't use raw queries), XSS (React escapes; never `dangerouslySetInnerHTML` untrusted data), SSRF (the OIDC discovery endpoint is the known SSRF-adjacent surface while auth is disabled — see `docs/operations.md`).
- **Secret Protection:** NEVER log, print, or include secrets in responses or tool output. The repo root contains a real `.env`; leave it untouched unless explicitly asked, and preserve secrets exactly when editing files that contain them.
- **Command Execution Safety:** Do NOT execute blindly downloaded scripts (`curl ... | bash`) or unknown binaries without explicit user permission.
- **Dependency Integrity:** Beware typosquatting; verify package names before installing. The `pnpm-workspace.yaml` `overrides` and `allowBuilds` lists are deliberate — don't loosen them, and don't use `--force`/`--legacy-peer-deps`-style bypasses without explaining why.
- **System Isolation:** Confine file operations to this project directory and its worktrees. Do NOT read, modify, or scan `~/.ssh/`, `~/.aws/`, or other system-sensitive paths.
- **No Hacky Workarounds:** Do NOT disable linters, type-checkers, or tests (`@ts-ignore`, `eslint-disable`, `any` casts, skipped tests) to make a build pass. Fix the underlying issue — CONTRIBUTING.md forbids error-suppressing comments.

## System Architecture & SRE Practices

### 1. Twelve-Factor App Principles

- **Stateless Processes:** the server holds no local state; everything persistent lives in Postgres.
- **Logs as Event Streams:** structured JSON logs to stdout via pino (Fastify's built-in logger): level from `LOG_LEVEL`, UUID request ids (`genReqId`), `authorization`/`cookie` headers redacted, `pino-pretty` in dev only. Never write log files.
- **Database Migrations:** Prisma migrations only (`apps/server/prisma/migrations/`). The container entrypoint runs `prisma migrate deploy` on every boot (idempotent) before starting Fastify. Never mutate the schema by hand or via raw SQL.

### 2. Observability

- Correlate everything through the pino request id. There is no OpenTelemetry/tracing in v1 — don't claim or fabricate metrics that don't exist; `/healthz` (liveness) and `/readyz` (readiness) are the operational probes.

### 3. Resilience (Design for Failure)

- **Fail safe, not crash:** undecryptable auth config degrades to `mode=disabled`; OIDC discovery retries with capped exponential backoff (2s→32s); `RECOVERY_DISABLE_AUTH=true` is the break-glass path. Follow this pattern for new failure modes: degrade with a clear log line, never take the app down or destroy state.

### 4. CI/CD & Automation

- **CI** (`.github/workflows/ci.yml`, every PR + push to `main`): install → `prisma generate` → `generate-routes` → `pnpm lint` → `pnpm typecheck` → `pnpm test` (Testcontainers Postgres) → `pnpm build`. Must be green before merge. All actions are pinned to commit SHAs — pin any new ones too.
- **Images** (`publish-images.yml`): multi-arch (amd64/arm64) GHCR images with provenance + SBOM. Immutable artifacts: compose is pull-only (no `build:` blocks); `main` → `:latest`, release `vX.Y` → `:X.Y`; pin deployments with `LCM_IMAGE_TAG`.
- **Dependabot:** weekly for github-actions, npm, docker (Dockerfile digests), and docker-compose. Known caveat: `dhi.io` is a private registry with no configured Dependabot credentials, so DHI digest bumps are not proposed automatically.

## AI Collaboration & Workflow (Streamlining)

### 1. Rigorous SDLC (Design, Spec, Review)

Before writing any implementation code, the AI MUST follow a strict Software Development Life Cycle:

- **Phase 1: Design (The "How"):** Formulate the software design — architectural approach, component relationships, state management, data models, and API contracts.
- **Phase 2: Specifications (The "What"):** Define functional and non-functional requirements, edge cases, error handling, and exact acceptance criteria.
- **The Critical Review Loop:** After each phase, perform a critical self-review (play devil's advocate for logical gaps, untested assumptions, security flaws). Fix findings, re-review, and only then proceed. Do NOT start coding until both phases have passed critique.

### 2. The "Contract-First" Handshake

- **Process:** after the SDLC loop and before logic implementation:
  1. Define or extend the Zod schema in `packages/shared/src/schemas/`.
  2. Derive the TS types from it (`z.infer`) — server routes and web forms both consume the same contract.
- **Why:** the shared package is the single contract; it prevents hallucinated property names and keeps server and web in lockstep.

### 3. Contextual Markers (@ai-notes)

- Use JSDoc/docstring-style comment blocks to leave "hints" for future AI sessions:
  - `@ai-note`: explains a non-obvious business rule.
  - `@ai-context`: points to a related file or ADR.
  - `@ai-warning`: warns about a side-effect or legacy "trap."
- Otherwise follow CONTRIBUTING.md: no files that merely describe code; comments only for non-obvious "why".

### 4. Cohesive File Strategy

- **Logical Boundaries over Line Counts:** don't split files just to keep them short — a service file should contain all logic cohesive to that service.
- **One Component Per File:** for React, one primary exported component per file.
- **Why:** hyper-fragmentation makes it harder to understand the complete data flow. Keep related logic in one context window.

### 5. Automated Verification Loop

After every edit:

1. **Lint/Format:** `pnpm lint` (lint-staged also runs `eslint --fix` + Prettier on commit via the husky pre-commit hook — don't disable it).
2. **Type-Check:** `pnpm typecheck` (`tsc --noEmit`, strict).
3. **Test:** `pnpm test` (server suite needs Docker for Testcontainers; `--passWithNoTests` is set, so absence of failures ≠ coverage — write the test).

### 6. Directory Structure (Layer-Based Server, File-Based Routes on Web)

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
  ├── routes/      # TanStack Router file-based routes (routeTree.gen.ts is generated — never hand-edit)
  └── components/  # ui/ primitives + feature folders (overview/, clusters/, theme/)
packages/shared/src/schemas/   # Zod contracts shared by server + web
```

- Routes stay thin; business logic belongs in `services/`. Shared logic/types go in `@lcm/shared`, never duplicated.

### 7. Prevent Hallucinations (Verify Before Use)

- **Dependencies & External APIs:** NEVER assume a package is installed or exists — check the workspace `package.json` first, and verify a library's actual exported API (local type definitions, source, docs) before calling it.
- **Documentation Lookup:** fetch official docs via an MCP docs server rather than relying on pre-trained knowledge, especially for fast-moving majors used here (React 19, Vite 8, Tailwind 4, Fastify 5, Zod 4, Prisma 7, TanStack Router). Priority: **(1) Ref** (`ref.tools`), **(2) DeepWiki**, **(3)** any other docs/search MCP; fall back to the official docs site only if none is available.
- **Internal Functions:** NEVER call a utility, hook, or service without first verifying its existence and signature in the source.

## Git Workflow (Worktree-Based)

- **Feature Development:** do NOT just checkout a branch in the main directory — create the feature branch in a separate `git worktree`:
  ```bash
  git fetch origin
  git worktree add ../<slug> -b feat/<issue#>-<slug> origin/main
  ```
- **PR Flow:** `feat/* → main` (CI runs: lint → typecheck → test → build). One branch/PR per concern.
- **Merging:** merge commits (`gh pr merge --merge`) to preserve per-task TDD history; squash only for churn nobody will bisect (typos, lint sweeps, dep bumps). **Stacked PRs:** retarget the dependent PR's base to `main` BEFORE merging the current one, then merge with `--merge`.
- **Cleanup:** ONLY AFTER the PR is fully merged, remove the worktree and delete the _local_ branch (never the remote):
  ```bash
  git worktree remove ../<slug>
  git branch -d feat/<issue#>-<slug>
  ```
- **Releases:** publish a GitHub release `vX.Y` — CI builds and tags the images `:X.Y`; deployments pin via `LCM_IMAGE_TAG`.
- **Commit Messages:** `type(scope): description` — imperative present, ~70 chars, body explains why (e.g., `feat(server): add OIDC login`). Scopes in use: `server`, `web`, `api`, `deps`, `docker`, `ci`; documentation commits use `docs` as the _type_ (`docs: ...`), not a scope.
- **Link Issues:** always use `Closes #<issue>` in PR descriptions.
