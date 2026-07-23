# Contributing

A few conventions to keep the repo coherent while it's small.

## Branches

- Name feature branches `feat/<short-slug>` (e.g. `feat/xlsx-import`) or
  `fix/<short-slug>` / `chore/<short-slug>` to match the conventional commit
  prefix. If a GitHub issue drives the branch, prefixing the slug with the
  issue number is fine too (e.g. `feat/13-dashboard-cluster-list`).
- Branch off `dev`, never off `main`. `dev` is the integration branch; `main`
  receives changes exclusively through a `dev → main` sync PR. Don't merge the
  base branch back in mid-PR; rebase if needed.
- One branch per concern; one PR per branch.

## Commits

- Write the first line in the imperative present, ~70 chars max — what the
  commit _does_, not what you did. Example: `Add Hosts REST API with capacity
timeline`.
- Body explains _why_, mentions the issue (`Closes #6`), and notes any
  caveats a future reader needs.
- Co-author trailers are added by the harness when relevant.

## Pull requests

- PR title mirrors the commit title.
- Open the PR against `dev` (`gh pr create --base dev`). Only a `dev → main`
  sync PR targets `main`.
- PR body links the issue (`Closes #N`) and includes a short test plan or
  evidence (screenshots for UI work, commands run for backend work).
- CI must be green before merging; the workflow runs lint, typecheck, the
  full test suite (server uses Testcontainers — needs Docker, ubuntu-latest has
  it), and the web build.
- Merge with `--merge` (default; preserves the per-task TDD history of feature
  branches). Squash-merge is fine for branches with churn that nobody will
  ever want to bisect (typo fixes, lint sweeps, dependency bumps).

### The `ApprovedByAI` label

`ApprovedByAI` means the AI feasibility review passed and the issue is
approved to **implement now**. It is _not_ merge approval, and it encodes
nothing about merge order.

- Merge ordering, blockers, and caveats live in the AI review comment on the
  issue — read that comment before merging, not just before implementing. When
  an issue must land after another, its comment says so (`Blocked by: #NNN`).
- The label never replaces CI, human review, or the project owner's approval.
  Merging is always the owner's call.

An issue can therefore carry `ApprovedByAI` and still be unmergeable today —
that is the normal state for a stacked issue whose dependency is still open.

### Merging stacked PRs

When a PR's base is another open PR (not `dev`), the merge order matters:

- Use `--merge` (not `--squash` or `--rebase`) for every PR in the stack.
  Squash and rebase rewrite SHAs, which orphans every dependent branch and
  causes GitHub to **close** the dependent PRs instead of retargeting them.
- Before merging PR _N_, retarget PR _N+1_'s base to `dev` first:
  `gh pr edit <N+1> --base dev`. GitHub closes any PR the moment its base
  branch is deleted, _before_ any retargeting could fire, so the swap has to
  happen first.
- Then `gh pr merge <N> --merge --delete-branch`.

In short: **retarget the next, then merge the current.** Once `dev` has
caught up, the dependent branch's ancestry is fully reachable and the next
merge is clean.

## Code style

- TypeScript everywhere, `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes`. New code must typecheck without comments
  suppressing errors.
- ESLint flat config + Prettier are wired via `pnpm lint` / `pnpm format`.
  The Husky pre-commit hook runs `lint-staged` on every commit (eslint +
  prettier on the changed files); don't disable it. `lint-staged` is
  sub-second on a typical commit, so it stays local to save a CI round-trip
  for trivial format / lint misses. Typecheck and the full test suite are
  heavier and run only in CI on the PR.
- No new files that simply describe what code does. Reserve comments for
  the non-obvious "why".

## Tests

- New backend behaviour gets at least one integration test in the matching
  `apps/server/src/__tests__/*.test.ts` file. Factories in `factories.ts` are
  preferred over hand-rolled fixtures.
- New frontend components that have non-trivial logic (sorting, validation,
  prop mapping) get a Vitest + React Testing Library unit test next to the
  component.
- The Playwright golden path in `apps/web/playwright/` covers the
  end-to-end smoke; extend it if a major user flow changes.
- **The Vitest suites resolve `@lcm/shared` to its TypeScript source, not the
  built `dist`.** Both `apps/web/vitest.config.ts` and
  `apps/server/vitest.config.ts` alias `@lcm/shared` to `packages/shared/src`,
  so a new or changed shared export is picked up by the tests immediately —
  no `pnpm --filter @lcm/shared build` needed first. This closes the former
  stale-`dist` footgun where web tests could pass against a _previous_
  implementation. Note the **running dev servers and the production build still
  use `dist`**: if you need a shared change reflected in a live `pnpm dev` app
  (rather than in tests), rebuild shared. See issue #265.

## What lives where

- `apps/server` — Fastify + Prisma. Tests run with Testcontainers (`docker required`).
- `apps/server/scripts/` — one-time data tools (e.g. `db:import-xlsx`). Each is a
  thin CLI in `scripts/` backed by a pure module in `scripts/lib/` with its
  own Vitest unit tests; not part of the runtime image.
- `apps/web` — Vite + React. Vitest for unit tests, Playwright for e2e.
- `packages/shared` — Zod schemas + inferred types. Anything used by both
  server and web must live here (single source of truth).
- `docker/` — production Dockerfiles + compose files. `docker/docker-compose.yml`
  is the production stack; `docker/docker-compose.dev.yml` is dev DB only.
- `docs/` — vision, design specs, operations runbook, and the reference
  capacity-planning spreadsheet (`Capacity_Forecast_vSphere.xlsx`) the import
  script consumes.

## Running the dev loop

See [`README.md`](README.md#run-locally-for-development).
