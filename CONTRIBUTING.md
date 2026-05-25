# Contributing

A few conventions to keep the repo coherent while it's small.

## Branches

- Name feature branches `feat/<short-slug>` (e.g. `feat/xlsx-import`) or
  `fix/<short-slug>` / `chore/<short-slug>` to match the conventional commit
  prefix. If a GitHub issue drives the branch, prefixing the slug with the
  issue number is fine too (e.g. `feat/13-dashboard-cluster-list`).
- Branch off `main`. Don't merge `main` back in mid-PR; rebase if needed.
- One branch per concern; one PR per branch.

## Commits

- Write the first line in the imperative present, ~70 chars max — what the
  commit _does_, not what you did. Example: `Add Hosts REST API with capacity
timeline`.
- Body explains _why_, mentions the issue (`Closes #6`), and notes any
  caveats a future reader needs (e.g. "Prisma `migrate reset` was blocked by
  the AI guard, so verification ran against a throwaway DB instead").
- Co-author trailers are added by the harness when relevant.

## Pull requests

- PR title mirrors the commit title.
- PR body links the issue (`Closes #N`) and includes a short test plan or
  evidence (screenshots for UI work, commands run for backend work).
- CI must be green before merging; the workflow runs lint, typecheck, the
  full test suite (api uses Testcontainers — needs Docker, ubuntu-latest has
  it), and the web build.
- Merge with `--merge` (default; preserves the per-task TDD history of feature
  branches). Squash-merge is fine for branches with churn that nobody will
  ever want to bisect (typo fixes, lint sweeps, dependency bumps).

### Merging stacked PRs

When a PR's base is another open PR (not `main`), the merge order matters:

- Use `--merge` (not `--squash` or `--rebase`) for every PR in the stack.
  Squash and rebase rewrite SHAs, which orphans every dependent branch and
  causes GitHub to **close** the dependent PRs instead of retargeting them.
- Before merging PR _N_, retarget PR _N+1_'s base to `main` first:
  `gh pr edit <N+1> --base main`. GitHub closes any PR the moment its base
  branch is deleted, _before_ any retargeting could fire, so the swap has to
  happen first.
- Then `gh pr merge <N> --merge --delete-branch`.

In short: **retarget the next, then merge the current.** Once `main` has
caught up, the dependent branch's ancestry is fully reachable and the next
merge is clean.

## Code style

- TypeScript everywhere, `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes`. New code must typecheck without comments
  suppressing errors.
- ESLint flat config + Prettier are wired via `pnpm lint` / `pnpm format`.
  The Husky pre-commit hook runs lint-staged + a project-wide typecheck on
  every commit; don't disable it.
- No new files that simply describe what code does. Reserve comments for
  the non-obvious "why".

## Tests

- New backend behaviour gets at least one integration test in the matching
  `apps/api/src/__tests__/*.test.ts` file. Factories in `factories.ts` are
  preferred over hand-rolled fixtures.
- New frontend components that have non-trivial logic (sorting, validation,
  prop mapping) get a Vitest + React Testing Library unit test next to the
  component.
- The Playwright golden path in `apps/web/playwright/` covers the
  end-to-end smoke; extend it if a major user flow changes.

## What lives where

- `apps/api` — Fastify + Prisma. Tests run with Testcontainers (`docker required`).
- `apps/api/scripts/` — one-time data tools (e.g. `db:import-xlsx`). Each is a
  thin CLI in `scripts/` backed by a pure module in `scripts/lib/` with its
  own Vitest unit tests; not part of the runtime image.
- `apps/web` — Vite + React. Vitest for unit tests, Playwright for e2e.
- `packages/shared` — Zod schemas + inferred types. Anything used by both
  api and web must live here (single source of truth).
- `docker/` and the root `docker-compose.yml` — production deployment;
  `docker-compose.dev.yml` is dev DB only.
- `docs/` — vision, design specs, operations runbook, and the reference
  capacity-planning spreadsheet (`Capacity_Forecast_vSphere.xlsx`) the import
  script consumes.

## Running the dev loop

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d db
pnpm --filter @lcm/api exec prisma migrate deploy
pnpm seed
pnpm --filter @lcm/api db:import-xlsx   # optional — adds realistic forecast events
pnpm dev                                # api on :8090, web on :5173 with HMR
```

For full background see [`README.md`](README.md).
