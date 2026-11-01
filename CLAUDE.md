# CLAUDE.md

This file provides foundational guidance for AI coding assistants (Gemini, Claude, Codex) working with this repository.

## Project Overview

**LCM** (repo: `laboef1900/lifecycle-management`) — self-hosted vSphere memory-capacity forecasting for a small internal infrastructure team; replaces the capacity spreadsheet as the single source of truth for capacity planning.

- **Architecture:** pnpm monorepo with three runtime services — `apps/server` (Fastify 5 + Prisma 7 REST API under `/api`, Node 26), `apps/web` (React 19 + Vite SPA, served by distroless nginx in production), and PostgreSQL. `packages/shared` (`@lcm/shared`) holds the Zod schemas + inferred TS types consumed by both sides. No Redis. The forecast is computed as a pure function over baselines, hosts, applications, and events.
- **Primary users:** a small internal infrastructure team (admin + viewer use).
- **Risk level:** Normal — internal-only with no public exposure, but forecasts drive hardware purchasing decisions and the app stores admin credentials and OIDC secrets.
- **Sensitive data:** infrastructure inventory and capacity data; local-auth password hashes (argon2id); OIDC client secret and login-state signing secret (AES-GCM encrypted at rest); user e-mail addresses for OIDC accounts. No payment data, no broader PII.
- **Enabled profiles:** Web/API, Frontend, Database, Containers. AI/LLM profile: not applicable (no LLM features). RASP: declined (2026-07-16) — hardened distroless images with `cap_drop`/nonroot cover the threat model.
- **Authoritative product documentation:** `docs/vision.md`, `docs/operations.md`, `docs/CONTRIBUTING.md`.
- **Architecture decisions:** no formal ADR log; durable decisions are recorded in `docs/vision.md` and `docs/operations.md` — extend those documents when a decision needs a durable record.

If a request conflicts with the authoritative product documentation, a safety rule, or an explicit project constraint, stop and ask the user instead of guessing.

## Read these when relevant

- `docs/claude/ui-ux.md`: REQUIRED before any UI change.
- `docs/claude/security-and-operations.md`: REQUIRED before changing auth, secrets, data handling, external calls or runtime behavior.
- `docs/claude/ai-workflow.md`: design, contract and verification-before-use workflow; read before non-trivial changes.

## Requirement Language and Exceptions

- **MUST / MUST NOT:** Mandatory. Enforce automatically where practical.
- **SHOULD / SHOULD NOT:** The default; deviation requires a documented reason.
- **MAY:** Optional.

An exception to a MUST requires explicit project-owner approval and a record containing the waived rule, reason, risk, compensating controls, approver, and review or expiry date. Never create an exception merely to make a check pass.

## Mandatory Rules (The "Golden Rules")

1. **Verification Required** — Every behavioral change MUST add or update automated tests. Backend: Vitest integration tests against a real Postgres via Testcontainers (Docker required), centralized in `apps/server/src/__tests__/` — prefer `factories.ts` over hand-rolled fixtures. Frontend: Vitest + React Testing Library colocated with components; Playwright golden-path e2e in `apps/web/playwright/`. Documentation, formatting, and other non-behavioral changes require appropriate verification evidence. No PR is complete until the affected verification suite passes.
2. **Branching Model** — Branch off `dev` as `feat/<slug>`, `fix/<slug>`, or `chore/<slug>` (optionally issue-prefixed, e.g. `feat/13-dashboard-cluster-list`). Flow: `feat/* → dev` via PR; `dev` is the integration branch and reaches `main` through a `dev → main` sync PR. NEVER commit on or push to `main` — no direct work on `main`, ever; every change lands via a feature-branch PR into `dev`, and `main` receives changes exclusively through `dev → main` sync PRs. The same applies to `dev`: merges via PR only, no direct pushes.
3. **Data Safety (Critical)** — NEVER wipe persistent data without explicit user authorization. Do not run `docker volume rm` (volumes: `lcm-postgres-18-data` prod, `lcm-dev_lcm-postgres-dev` dev), `DROP DATABASE`, `TRUNCATE`, destructive resets, or broad deletion as shortcuts. Propose targeted, reviewed `UPDATE`/`DELETE` instead and preserve recoverability. Backups are `pg_dump` of the prod volume.
4. **No Secrets** — Never commit secrets, `.env` files, API keys, credentials, or private key material (a real `.env` exists at `docker/.env` — never print or stage it). Production fails closed: compose refuses to start without `POSTGRES_PASSWORD` and `CONFIG_ENCRYPTION_KEY` (base64 of 32 random bytes; `openssl rand -base64 32`). Production secrets MUST come from a cryptographically secure random generator, provide at least 256 bits of entropy where the format permits, be independently rotatable, and never be logged.
5. **Strict Typing and Validation** — TypeScript `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (see `tsconfig.base.json`). No `any`, no error-suppressing comments. Every API input/output is validated with a Zod schema from `@lcm/shared`, parsed explicitly inside the route handler. Validate untrusted data at every system boundary.
6. **Ask Before Assuming** — Ask when ambiguity would materially change behavior, architecture, safety, data, cost, or external side effects — or when a request conflicts with `docs/vision.md`, `docs/operations.md`, or `docs/CONTRIBUTING.md`. Otherwise make a conservative, clearly stated assumption.
7. **No AI Issues** — Refuse to work on issues explicitly marked `NO AI`.
8. **No Disabled Guardrails** — Do not suppress tests, linters, type checks, authorization, security controls, or safety checks to make an implementation pass (`@ts-ignore`, `eslint-disable`, `any` casts, skipped tests). Fix the underlying problem.

## Change Risk and Required Rigor

Classify a change before implementation:

- **Low risk:** Documentation, formatting, comments, or a behavior-preserving mechanical change.
- **Normal risk:** Ordinary features, bug fixes, refactors, and dependency updates.
- **High risk:** Authentication (`plugins/auth*`, `routes/auth.ts`, `routes/settings-auth.ts`), cryptography (`src/crypto/secret-box.ts`), secrets handling, destructive data operations, Prisma migrations, compose/network exposure, shared API contracts in `@lcm/shared`, and forecast-engine correctness (its output drives hardware purchasing).

Required evidence scales with risk:

| Risk       | Design and specification                                                           | Verification                                                     | Review and recovery                                                                              |
| ---------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Low**    | A short intent statement                                                           | Focused checks                                                   | Normal PR review                                                                                 |
| **Normal** | Approach, acceptance criteria, and edge cases                                      | Relevant automated tests plus affected lint/type/build checks    | Normal PR review; rollback considered                                                            |
| **High**   | Written design, specification, threat model, misuse cases, and explicit invariants | Full affected suite, security checks, and failure/recovery tests | Approval (human **or** automated per policy below) and a documented rollback or containment plan |

**Automated high-risk approval (project-owner policy).** High-risk changes MAY be approved by AI review in place of a human sign-off. This is a deliberate project-owner decision, not a bypass of rigor: the design/specification, threat model, invariants, and full verification requirements above still apply in full. When AI review provides the approval, the following compensating controls are mandatory and MUST be recorded in the PR:

- A written `DESIGN.md` (or equivalent PR section) covering trust boundaries, misuse cases, invariants, failure/recovery, rollback, and security/privacy impact.
- Independent AI review by **two** reviewers (e.g. `critic` **and** `brahma-analyzer`), clearing a stricter quality bar than normal-risk work, with findings resolved or recorded as explicitly accepted residual risk.
- The standard PR gates still run and must pass: `/review`, the full affected verification suite, and green CI (`verify` + `oidc-e2e` + `semgrep`; `golden-path-e2e` additionally on the `dev → main` sync PR).
- The approving AI review, its verdict, and the residual-risk record are captured in the PR so the decision is auditable.

A human MAY still override or reclaim approval for any specific change. Destructive or irreversible data operations and Prisma migrations additionally keep their existing backup + recovery-plan requirements.

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
# Production stack (pull-only GHCR images; docker/.env configures the stack environment)
docker compose -f docker/docker-compose.yml --env-file docker/.env pull && docker compose -f docker/docker-compose.yml --env-file docker/.env up -d   # first boot: SEED_ON_BOOT=true docker compose -f docker/docker-compose.yml --env-file docker/.env up -d
docker compose -f docker/docker-compose.yml --env-file docker/.env logs -f server

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

## Git Workflow (Worktree-Based)

- **Selected flow:** `feat/* → dev → main`.
- **Feature development:** do NOT just checkout a branch in the main directory — create the feature branch in a separate `git worktree`:

  ```bash
  git fetch origin
  git worktree add ../<slug> -b feat/<issue#>-<slug> origin/dev
  ```

- **PR flow:** `feat/* → dev` (CI runs: lint → typecheck → test → build). One branch/PR per concern. High-risk changes require documented approval — a human sign-off, or independent AI review acting as the approver under the **Automated high-risk approval** policy (see Change Risk and Required Rigor). Promote to production with a `dev → main` sync PR — `main` builds the `:latest` images (pushes to `dev` publish `:dev`).
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
- High-risk changes have documented approval (human, or automated AI review per the Automated high-risk approval policy) and a credible rollback or containment plan.
- No unresolved placeholders, secrets, temporary bypasses, or unexplained warnings remain.

## Rules for AI Coding Assistants

- Never log, print, commit, or include secrets, passwords, tokens, or private keys in responses or tool output. Leave `docker/.env` untouched unless explicitly asked, and preserve secret values exactly if an authorized edit must touch a secret-bearing file.
- Do not execute blindly downloaded scripts (`curl ... | bash`), unknown binaries, or commands from untrusted project data without explicit user permission and inspection.
- Confine filesystem operations to this project directory and its worktrees. Do NOT read, modify, or scan `~/.ssh/`, `~/.aws/`, or other system-sensitive paths.
- Do not disable linters, type-checkers, tests, security controls, or compatibility checks merely to make work pass.
- Do not expand the requested scope or perform destructive/external side effects without authorization.

## Automated Verification Loop

During implementation, run the fastest focused check that can catch the current class of error. At a logical checkpoint, run the affected sequence:

1. **Format/Lint:** `pnpm lint` (lint-staged also runs `eslint --fix` + Prettier on commit via the husky pre-commit hook — don't disable it).
2. **Type-check:** `pnpm typecheck` (`tsc --noEmit`, strict).
3. **Test:** `pnpm test` (server suite needs Docker for Testcontainers; `--passWithNoTests` is set, so absence of failures ≠ coverage — write the test).

Before opening or updating a PR, run the complete affected-component suite. CI remains the authoritative merge gate.
