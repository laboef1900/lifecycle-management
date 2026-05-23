# Contributing

A few conventions to keep the repo coherent while it's small.

## Branches

- Name feature branches `<issue-number>-<short-slug>`, e.g. `13-dashboard-cluster-list`.
- Branch off `main`. Don't merge `main` back in mid-PR; rebase if needed.
- One branch per issue; one PR per branch.

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
- Squash-merge to keep `main` history linear, unless the branch has
  meaningful intermediate commits worth keeping.

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
- `apps/web` — Vite + React. Vitest for unit tests, Playwright for e2e.
- `packages/shared` — Zod schemas + inferred types. Anything used by both
  api and web must live here (single source of truth).
- `docker/` and the root `docker-compose.yml` — production deployment;
  `docker-compose.dev.yml` is dev DB only.
- `docs/` — vision, design specs, operations runbook.

## Running the dev loop

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d db
pnpm --filter @lcm/api exec prisma migrate deploy
pnpm seed
pnpm dev   # api on :8090, web on :5173 with HMR
```

For full background see [`README.md`](README.md).
