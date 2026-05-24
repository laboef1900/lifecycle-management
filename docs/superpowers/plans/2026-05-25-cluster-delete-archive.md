# Cluster Delete + Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators archive a cluster (hide it from default lists + fleet KPIs while preserving forecast history and the ability to unarchive) and permanently delete a cluster (cascade through hosts/applications/events/baselines/settings), both controlled from a new Lifecycle card on the Settings tab.

**Architecture:** Add one nullable `archivedAt` column to `Cluster`. Extend `ClustersService` with `archive` / `unarchive` methods + an `includeArchived` option on `list`. Two new endpoints (`POST /:id/archive`, `POST /:id/unarchive`). The existing `DELETE /:id` is unchanged. Web: extend `api.clusters.list` to accept `{ includeArchived }`, add `api.clusters.{archive,unarchive}`, build a `ClusterLifecycleCard` with archive/unarchive + delete confirm dialogs, add a "Show archived" toggle to `/clusters`, render an "Archived" badge on archived rows + an "Archived YYYY-MM-DD" badge next to the detail page H1.

**Tech Stack:** Prisma + Postgres, Fastify, Zod, TanStack Query, React 19, TanStack Router (`useNavigate`), Sonner (toast), Vitest + Testing Library, Playwright.

**Spec:** [`docs/superpowers/specs/2026-05-25-cluster-delete-archive-design.md`](../specs/2026-05-25-cluster-delete-archive-design.md)

---

## File map

**Shared schemas**

- `packages/shared/src/schemas/cluster.ts` — add `archivedAt: string | null` to `ClusterResponse`; add `clustersListQuerySchema = z.object({ includeArchived: z.coerce.boolean().optional() })`; export the inferred type.

**Backend**

- `apps/api/prisma/schema.prisma` — add `archivedAt DateTime? @map("archived_at")` to `Cluster`.
- `apps/api/prisma/migrations/<timestamp>_add_cluster_archived_at/migration.sql` — Prisma-generated `ALTER TABLE`.
- `apps/api/src/services/clusters.ts` — `list` accepts `{ includeArchived }`; `toResponse` returns `archivedAt`; new `archive` + `unarchive` methods.
- `apps/api/src/routes/clusters.ts` — parse `includeArchived` query on `GET /clusters`; register `POST /:id/archive` and `POST /:id/unarchive`.
- `apps/api/src/__tests__/clusters.test.ts` — new archive/unarchive/filter tests; verify existing `GET /clusters` hides archived by default.

**Web client**

- `apps/web/src/lib/api-client.ts` — extend `api.clusters.list` to take optional `{ includeArchived }`; add `archive`, `unarchive` methods.

**Web UI**

- `apps/web/src/components/clusters/cluster-lifecycle-card.tsx` — new card with Archive/Unarchive row + Delete row, each with `ConfirmDialog`.
- `apps/web/src/components/clusters/cluster-lifecycle-card.test.tsx` — TDD tests for both flows.
- `apps/web/src/components/clusters/settings-tab.tsx` — mount the new card at the bottom.
- `apps/web/src/components/clusters/cluster-table.tsx` — render "Archived" badge on archived rows.
- `apps/web/src/components/clusters/cluster-list-card.tsx` — render "Archived" badge on archived mobile cards.
- `apps/web/src/routes/clusters.index.tsx` — `showArchived` state + toggle button + caption + two-query split (active-only powers KPIs; toggle switches the list view).
- `apps/web/src/routes/clusters.$id.tsx` — "Archived YYYY-MM-DD" badge next to H1 when `cluster.archivedAt` is set.

**E2E**

- `apps/web/playwright/settings.spec.ts` — new tests: archive → unarchive flow; delete flow on a throwaway cluster.

**Untouched**

- `Cluster.delete` service + route (already exist).
- All cascade FK rules.
- Forecast service, overview page (`/`), command palette.

---

## Branch convention

Recommend feature branch `cluster-delete-archive`. If executing via `superpowers:using-git-worktrees`, the worktree is created up-front. All commits stay on this branch; PR at the end (Task 11).

---

## Task 1: Schema migration — add `archivedAt` to `Cluster`

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_cluster_archived_at/migration.sql`

- [ ] **Step 1: Add the column to the Prisma schema**

Open `apps/api/prisma/schema.prisma`. Find the `model Cluster { ... }` block. After the existing `updatedAt` field (and before the relations), add:

```prisma
  archivedAt   DateTime? @map("archived_at")
```

The field name `archivedAt` (camelCase) matches the existing `baselineDate`/`createdAt`/`updatedAt` convention; `@map("archived_at")` keeps the column name consistent with the existing snake_case columns.

- [ ] **Step 2: Generate the migration (create only, don't apply)**

```bash
pnpm --filter @lcm/api exec prisma migrate dev --name add_cluster_archived_at --create-only
```

Expected: prints the generated SQL and creates `apps/api/prisma/migrations/<timestamp>_add_cluster_archived_at/migration.sql`. The SQL should be a single `ALTER TABLE clusters ADD COLUMN archived_at TIMESTAMP(3) NULL` (or `TIMESTAMPTZ` — accept whatever Prisma generates).

If Prisma generates anything more than the single ALTER, STOP and report.

- [ ] **Step 3: Apply the migration**

```bash
pnpm --filter @lcm/api exec prisma migrate deploy
```

Expected: "1 migration applied" (or "Already in sync" if running against a freshly-reset DB — re-run with `prisma migrate dev` if so).

- [ ] **Step 4: Regenerate the Prisma client**

```bash
pnpm --filter @lcm/api exec prisma generate
```

Expected: "Generated Prisma Client". This is required so `prisma.cluster` has the new `archivedAt` field typed.

- [ ] **Step 5: Run typecheck + tests**

```bash
pnpm --filter @lcm/api typecheck
pnpm --filter @lcm/api test
```

Expected: typecheck PASS, all 124 existing tests PASS (the new column is unused so far).

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(api): add archivedAt column to cluster"
```

---

## Task 2: Extend shared `ClusterResponse` + add list query schema

**Files:**

- Modify: `packages/shared/src/schemas/cluster.ts`

- [ ] **Step 1: Read the current file**

```bash
cat packages/shared/src/schemas/cluster.ts
```

- [ ] **Step 2: Add `archivedAt` to `ClusterResponse`**

Find the `ClusterResponse` interface (it's exported alongside other types). Add `archivedAt` after `updatedAt`:

```ts
export interface ClusterResponse {
  id: string;
  name: string;
  description: string | null;
  baselineDate: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  metrics: MetricStateResponse[];
}
```

(If `ClusterResponse` is defined as a Zod schema with `.infer`, edit the schema accordingly — but per the existing pattern in this file it's a hand-written interface.)

- [ ] **Step 3: Add `clustersListQuerySchema`**

After the existing `clusterIdParamsSchema` export, add:

```ts
export const clustersListQuerySchema = z.object({
  includeArchived: z.coerce.boolean().optional(),
});

export type ClustersListQuery = z.infer<typeof clustersListQuerySchema>;
```

- [ ] **Step 4: Run typecheck**

```bash
pnpm --filter @lcm/shared typecheck
pnpm -r typecheck
```

Expected: shared package PASS. The `apps/api` and `apps/web` typechecks will likely fail because they construct `ClusterResponse` objects (api `toResponse`) or have test mocks. That's expected; Tasks 3 + 5 + 6 fix them.

If the pre-commit hook blocks workspace-wide typecheck failure, hold off committing — combine with Task 3.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @lcm/shared test
```

Expected: PASS.

- [ ] **Step 6: Don't commit yet**

Skip the commit for this task and proceed to Task 3 — committing together avoids a broken-typecheck intermediate state that the pre-commit hook would reject.

---

## Task 3: Backend service + routes for archive/unarchive/list-filter

**Files:**

- Modify: `apps/api/src/services/clusters.ts`
- Modify: `apps/api/src/routes/clusters.ts`

- [ ] **Step 1: Update `toResponse` to include `archivedAt`**

Open `apps/api/src/services/clusters.ts`. Find `private toResponse(row: ClusterRow): ClusterResponse` (around line 158). At the return statement (around line 219), add `archivedAt` to the returned object:

```ts
return {
  id: row.id,
  name: row.name,
  description: row.description,
  baselineDate: formatDate(row.baselineDate),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  archivedAt: row.archivedAt?.toISOString() ?? null,
  metrics,
};
```

- [ ] **Step 2: Update `list` to accept `{ includeArchived }`**

Find `async list(tenantId: string): Promise<ClusterResponse[]>` (around line 32). Change the signature and filter:

```ts
  async list(
    tenantId: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<ClusterResponse[]> {
    const where = options.includeArchived
      ? { tenantId }
      : { tenantId, archivedAt: null };
    const rows = await this.prisma.cluster.findMany({
      where,
      include: clusterInclude,
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => this.toResponse(row));
  }
```

- [ ] **Step 3: Add `archive` and `unarchive` methods**

After the existing `delete` method (around line 140), add:

```ts
  async archive(tenantId: string, id: string): Promise<ClusterResponse> {
    const existing = await this.prisma.cluster.findFirst({
      where: { id, tenantId },
      select: { id: true, archivedAt: true },
    });
    if (!existing) {
      throw new NotFoundError('Cluster', id);
    }
    if (existing.archivedAt === null) {
      await this.prisma.cluster.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
    }
    return this.getById(tenantId, id);
  }

  async unarchive(tenantId: string, id: string): Promise<ClusterResponse> {
    const existing = await this.prisma.cluster.findFirst({
      where: { id, tenantId },
      select: { id: true, archivedAt: true },
    });
    if (!existing) {
      throw new NotFoundError('Cluster', id);
    }
    if (existing.archivedAt !== null) {
      await this.prisma.cluster.update({
        where: { id },
        data: { archivedAt: null },
      });
    }
    return this.getById(tenantId, id);
  }
```

Both methods are idempotent (re-archiving / re-unarchiving is a no-op that returns the current state).

- [ ] **Step 4: Update routes to parse query + register new endpoints**

Open `apps/api/src/routes/clusters.ts`. Add `clustersListQuerySchema` to the existing `@lcm/shared` import at the top:

```ts
import {
  clusterCreateInputSchema,
  clusterIdParamsSchema,
  clusterUpdateInputSchema,
  clustersListQuerySchema,
} from '@lcm/shared';
```

Update the `GET /clusters` handler (around line 14):

```ts
fastify.get('/clusters', async (request) => {
  const query = clustersListQuerySchema.parse(request.query);
  return service.list(request.tenantId, { includeArchived: query.includeArchived ?? false });
});
```

After the `fastify.delete('/clusters/:id', ...)` handler (around line 36), add:

```ts
fastify.post('/clusters/:id/archive', async (request) => {
  const { id } = clusterIdParamsSchema.parse(request.params);
  return service.archive(request.tenantId, id);
});

fastify.post('/clusters/:id/unarchive', async (request) => {
  const { id } = clusterIdParamsSchema.parse(request.params);
  return service.unarchive(request.tenantId, id);
});
```

- [ ] **Step 5: Run typecheck**

```bash
pnpm -r typecheck
```

Expected: shared PASS, api PASS. Web typecheck may still fail on the missing `archivedAt` in test mocks — Task 6 fixes that.

If pre-commit hook is workspace-wide, complete Task 6 before committing this batch. Otherwise commit now.

- [ ] **Step 6: Run API tests**

```bash
pnpm --filter @lcm/api test
```

Expected: existing 124 tests PASS. The new endpoints have no tests yet — added in Task 4.

- [ ] **Step 7: Commit (with Task 2's shared changes if not already committed)**

```bash
git add packages/shared/src/schemas/cluster.ts apps/api/src/services/clusters.ts apps/api/src/routes/clusters.ts
git commit -m "feat(api): archive/unarchive cluster endpoints + includeArchived filter"
```

If the pre-commit hook fails on web typecheck, the web mocks (in `aggregate-fleet.test.ts` and elsewhere) need `archivedAt: null` added. Either:

- (a) Add those minimal mock fixes inline to this commit, OR
- (b) Use `git commit --no-verify` ONLY if you immediately do Task 6 next to restore green.

Prefer (a). Find the web ClusterResponse literals:

```bash
grep -rn "id:.*name:.*description:" apps/web/src --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Add `archivedAt: null` to each `ClusterResponse` literal you find (likely `aggregate-fleet.test.ts`, `cluster-tile.test.tsx`, `cluster-identity-form.test.tsx`, `baseline-edit-form.test.tsx`, `command-palette.test.tsx`).

---

## Task 4: API integration tests for archive/unarchive

**Files:**

- Modify: `apps/api/src/__tests__/clusters.test.ts`

- [ ] **Step 1: Read the existing test file to find the helper + pattern**

```bash
head -80 apps/api/src/__tests__/clusters.test.ts
```

The file already has a `uniqueName()` helper and a `server.inject(...)` pattern. Reuse them.

- [ ] **Step 2: Add new tests**

At the end of the file (after the existing describe blocks), append:

```ts
describe('POST /api/clusters/:id/archive', () => {
  it('sets archivedAt and returns the cluster', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name: uniqueName('archive'),
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = createRes.json() as { id: string };

    const archiveRes = await server.inject({
      method: 'POST',
      url: `/api/clusters/${id}/archive`,
    });
    expect(archiveRes.statusCode).toBe(200);
    const body = archiveRes.json() as { archivedAt: string | null };
    expect(body.archivedAt).not.toBeNull();
    expect(new Date(body.archivedAt!).getTime()).toBeGreaterThan(0);
  });

  it('is idempotent — re-archiving keeps the original timestamp', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name: uniqueName('archive-idem'),
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = createRes.json() as { id: string };

    const first = await server.inject({ method: 'POST', url: `/api/clusters/${id}/archive` });
    const firstBody = first.json() as { archivedAt: string };
    const second = await server.inject({ method: 'POST', url: `/api/clusters/${id}/archive` });
    const secondBody = second.json() as { archivedAt: string };
    expect(secondBody.archivedAt).toBe(firstBody.archivedAt);
  });

  it('returns 404 for unknown cluster', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/clusters/clbogusclubogusclubogus0/archive',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/clusters/:id/unarchive', () => {
  it('clears archivedAt', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name: uniqueName('unarchive'),
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = createRes.json() as { id: string };

    await server.inject({ method: 'POST', url: `/api/clusters/${id}/archive` });
    const res = await server.inject({ method: 'POST', url: `/api/clusters/${id}/unarchive` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { archivedAt: string | null };
    expect(body.archivedAt).toBeNull();
  });
});

describe('GET /api/clusters (archived filter)', () => {
  it('hides archived clusters by default', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name: uniqueName('hidden-by-default'),
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = createRes.json() as { id: string };
    await server.inject({ method: 'POST', url: `/api/clusters/${id}/archive` });

    const listRes = await server.inject({ method: 'GET', url: '/api/clusters' });
    const body = listRes.json() as Array<{ id: string }>;
    expect(body.some((c) => c.id === id)).toBe(false);
  });

  it('returns archived clusters when includeArchived=true', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name: uniqueName('shown-with-flag'),
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = createRes.json() as { id: string };
    await server.inject({ method: 'POST', url: `/api/clusters/${id}/archive` });

    const listRes = await server.inject({
      method: 'GET',
      url: '/api/clusters?includeArchived=true',
    });
    const body = listRes.json() as Array<{ id: string; archivedAt: string | null }>;
    const found = body.find((c) => c.id === id);
    expect(found).toBeDefined();
    expect(found!.archivedAt).not.toBeNull();
  });
});

describe('GET /api/clusters/:id (archived)', () => {
  it('returns archived clusters from the detail endpoint', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/clusters',
      payload: {
        name: uniqueName('detail-archived'),
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = createRes.json() as { id: string };
    await server.inject({ method: 'POST', url: `/api/clusters/${id}/archive` });

    const detailRes = await server.inject({ method: 'GET', url: `/api/clusters/${id}` });
    expect(detailRes.statusCode).toBe(200);
    const body = detailRes.json() as { id: string; archivedAt: string | null };
    expect(body.id).toBe(id);
    expect(body.archivedAt).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run the new tests**

```bash
pnpm --filter @lcm/api test clusters
```

Expected: 124 + 7 = 131 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/clusters.test.ts
git commit -m "test(api): archive/unarchive endpoints + includeArchived filter"
```

---

## Task 5: Update test fixtures across the workspace

**Files:**

- Search-and-add: every test/fixture that constructs a `ClusterResponse` literal needs `archivedAt: null`.

This is mechanical cleanup so subsequent web typecheck stays clean.

- [ ] **Step 1: Find all `ClusterResponse` literals**

```bash
grep -rn "baselineConsumption\|currentConsumption" apps/web/src --include="*.tsx" --include="*.ts" | grep -v node_modules | grep -i "test\|__tests__" | head -20
```

This catches fixtures that have metric-state fields, which are unique to `ClusterResponse`. Cross-check with:

```bash
grep -rn ": ClusterResponse\|as ClusterResponse" apps/web/src --include="*.tsx" --include="*.ts" | head -10
```

Likely sites (based on prior task exploration):

- `apps/web/src/__tests__/aggregate-fleet.test.ts`
- `apps/web/src/components/overview/cluster-tile.test.tsx`
- `apps/web/src/components/clusters/cluster-identity-form.test.tsx`
- `apps/web/src/components/clusters/baseline-edit-form.test.tsx`
- `apps/web/src/__tests__/command-palette.test.tsx` (uses unknown-cast pattern — may not need a literal field)

- [ ] **Step 2: Add `archivedAt: null` to each literal**

For each file with a `ClusterResponse` literal, find the object that has `createdAt`/`updatedAt` and add `archivedAt: null` after `updatedAt`:

```ts
{
  // ...existing fields...
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  archivedAt: null,
  metrics: [ /* ... */ ],
}
```

If a file uses `as unknown as ClusterResponse` or a `Partial<ClusterResponse>` cast, no edit needed — typecheck won't complain.

- [ ] **Step 3: Run web typecheck + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
```

Expected: typecheck PASS, all 99 web tests PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "test(web): add archivedAt: null to ClusterResponse fixtures"
```

---

## Task 6: Extend web api-client with archive/unarchive + list filter

**Files:**

- Modify: `apps/web/src/lib/api-client.ts`

- [ ] **Step 1: Extend `api.clusters.list`**

Open `apps/web/src/lib/api-client.ts`. Find the `clusters` group (around line 169). Replace the `list` line:

```ts
    list: () => request<ClusterResponse[]>('/api/clusters'),
```

with:

```ts
    list: (params?: { includeArchived?: boolean }) => {
      const qs = params?.includeArchived ? '?includeArchived=true' : '';
      return request<ClusterResponse[]>(`/api/clusters${qs}`);
    },
```

This is backwards-compatible: `api.clusters.list()` still works and still returns active clusters only.

- [ ] **Step 2: Add `archive` and `unarchive`**

In the same `clusters` group, after `delete` (and before `forecast`), add:

```ts
    archive: (id: string) =>
      request<ClusterResponse>(`/api/clusters/${id}/archive`, { method: 'POST' }),
    unarchive: (id: string) =>
      request<ClusterResponse>(`/api/clusters/${id}/unarchive`, { method: 'POST' }),
```

- [ ] **Step 3: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api-client.ts
git commit -m "feat(web): api.clusters.archive/unarchive + list includeArchived"
```

---

## Task 7: Build `ClusterLifecycleCard`

**Files:**

- Create: `apps/web/src/components/clusters/cluster-lifecycle-card.tsx`
- Create: `apps/web/src/components/clusters/cluster-lifecycle-card.test.tsx`

The card renders two rows: Archive (or Unarchive) + Delete. Each row has its own confirm dialog. Delete navigates away on success.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/clusters/cluster-lifecycle-card.test.tsx`:

```tsx
import type { ClusterResponse } from '@lcm/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/lib/api-client';

import { ClusterLifecycleCard } from './cluster-lifecycle-card';

const CLUSTER_ID = 'clu_test_001';

const navigateMock = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const activeCluster: ClusterResponse = {
  id: CLUSTER_ID,
  name: 'CL-Active',
  description: null,
  baselineDate: '2026-05-01',
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
  archivedAt: null,
  metrics: [],
};

const archivedCluster: ClusterResponse = {
  ...activeCluster,
  name: 'CL-Archived',
  archivedAt: '2026-05-20T12:00:00Z',
};

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('<ClusterLifecycleCard>', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    vi.spyOn(api.clusters, 'get').mockResolvedValue(activeCluster);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Archive + Delete rows when cluster is active', async () => {
    renderWithClient(<ClusterLifecycleCard clusterId={CLUSTER_ID} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^archive$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    });
  });

  it('renders Unarchive + Delete rows when cluster is archived', async () => {
    vi.spyOn(api.clusters, 'get').mockResolvedValue(archivedCluster);
    renderWithClient(<ClusterLifecycleCard clusterId={CLUSTER_ID} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^unarchive$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    });
  });

  it('archive opens confirm dialog and submits on confirm', async () => {
    const archiveSpy = vi.spyOn(api.clusters, 'archive').mockResolvedValue(archivedCluster);
    renderWithClient(<ClusterLifecycleCard clusterId={CLUSTER_ID} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^archive$/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    expect(screen.getByRole('dialog', { name: /archive cluster/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^archive cluster$/i }));
    await waitFor(() => expect(archiveSpy).toHaveBeenCalledWith(CLUSTER_ID));
  });

  it('archive cancel does not submit', async () => {
    const archiveSpy = vi.spyOn(api.clusters, 'archive').mockResolvedValue(archivedCluster);
    renderWithClient(<ClusterLifecycleCard clusterId={CLUSTER_ID} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^archive$/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  it('unarchive opens confirm dialog and submits on confirm', async () => {
    vi.spyOn(api.clusters, 'get').mockResolvedValue(archivedCluster);
    const unarchiveSpy = vi.spyOn(api.clusters, 'unarchive').mockResolvedValue(activeCluster);
    renderWithClient(<ClusterLifecycleCard clusterId={CLUSTER_ID} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^unarchive$/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /^unarchive$/i }));
    expect(screen.getByRole('dialog', { name: /unarchive cluster/i })).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: /^unarchive$/i, hidden: false }).nth?.(1) ??
        screen.getAllByRole('button', { name: /^unarchive$/i })[1]!,
    );
    await waitFor(() => expect(unarchiveSpy).toHaveBeenCalledWith(CLUSTER_ID));
  });

  it('delete opens confirm dialog and navigates on confirm', async () => {
    const deleteSpy = vi.spyOn(api.clusters, 'delete').mockResolvedValue(undefined);
    renderWithClient(<ClusterLifecycleCard clusterId={CLUSTER_ID} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(screen.getByRole('dialog', { name: /delete cluster permanently/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /delete forever/i }));
    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith(CLUSTER_ID);
      expect(navigateMock).toHaveBeenCalledWith({ to: '/clusters' });
    });
  });
});
```

(Note: the "unarchive submits on confirm" test has a subtle selector issue because both the row button and the confirm button match `/^unarchive$/i`. If the test fails on selector ambiguity, change the confirm button selector to `screen.getAllByRole('button', { name: /^unarchive$/i })[1]` — i.e. the second matching button is the one inside the dialog. Or rename the confirm button label to e.g. `"Unarchive cluster"` if cleaner. The simpler approach: in the implementation, label the confirm button text differently from the row button so the regex matches uniquely. See Step 3.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @lcm/web test cluster-lifecycle-card
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/clusters/cluster-lifecycle-card.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import * as React from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/form/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { api } from '@/lib/api-client';

interface ClusterLifecycleCardProps {
  clusterId: string;
}

export function ClusterLifecycleCard({ clusterId }: ClusterLifecycleCardProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const clusterQuery = useQuery({
    queryKey: ['cluster', clusterId],
    queryFn: () => api.clusters.get(clusterId),
  });

  const [archiveDialogOpen, setArchiveDialogOpen] = React.useState(false);
  const [unarchiveDialogOpen, setUnarchiveDialogOpen] = React.useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);

  const isArchived =
    clusterQuery.data?.archivedAt !== null && clusterQuery.data?.archivedAt !== undefined;
  const clusterName = clusterQuery.data?.name ?? '';

  const invalidateClustersLists = (): Promise<void> => {
    return queryClient.invalidateQueries({ queryKey: ['clusters'] });
  };

  const archiveMutation = useMutation({
    mutationFn: () => api.clusters.archive(clusterId),
    onSuccess: (data) => {
      queryClient.setQueryData(['cluster', clusterId], data);
      void invalidateClustersLists();
      setArchiveDialogOpen(false);
      toast.success('Cluster archived.');
    },
    onError: () => {
      toast.error('Could not archive cluster.');
    },
  });

  const unarchiveMutation = useMutation({
    mutationFn: () => api.clusters.unarchive(clusterId),
    onSuccess: (data) => {
      queryClient.setQueryData(['cluster', clusterId], data);
      void invalidateClustersLists();
      setUnarchiveDialogOpen(false);
      toast.success('Cluster unarchived.');
    },
    onError: () => {
      toast.error('Could not unarchive cluster.');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.clusters.delete(clusterId),
    onSuccess: () => {
      void invalidateClustersLists();
      setDeleteDialogOpen(false);
      toast.success('Cluster deleted.');
      void navigate({ to: '/clusters' });
    },
    onError: () => {
      toast.error('Could not delete cluster.');
    },
  });

  return (
    <Card className="p-4">
      <header className="mb-4">
        <h2 className="text-base font-semibold">Lifecycle</h2>
      </header>
      <div className="space-y-4">
        {isArchived ? (
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Unarchive cluster</p>
              <p className="text-sm text-fg-muted">
                Restore this cluster to the active list. Its forecasts, hosts, applications, and
                events are unaffected.
              </p>
            </div>
            <Button
              type="button"
              variant="accent"
              size="sm"
              onClick={() => setUnarchiveDialogOpen(true)}
            >
              Unarchive
            </Button>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Archive cluster</p>
              <p className="text-sm text-fg-muted">
                Archived clusters are hidden by default but stay readable and restorable. Forecast
                history is preserved.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setArchiveDialogOpen(true)}
            >
              Archive
            </Button>
          </div>
        )}
        <div className="border-t border-border" />
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Delete cluster</p>
            <p className="text-sm text-fg-muted">
              Permanently removes this cluster, its baselines, hosts, applications, and events. This
              cannot be undone.
            </p>
          </div>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => setDeleteDialogOpen(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        title="Archive cluster?"
        description="Archived clusters are hidden from the default list and from fleet KPIs. Forecast history is preserved and the cluster can be unarchived at any time."
        confirmLabel="Archive cluster"
        pending={archiveMutation.isPending}
        onConfirm={() => archiveMutation.mutate()}
      />
      <ConfirmDialog
        open={unarchiveDialogOpen}
        onOpenChange={setUnarchiveDialogOpen}
        title="Unarchive cluster?"
        description="Restores this cluster to the active list and fleet KPIs."
        confirmLabel="Unarchive cluster"
        pending={unarchiveMutation.isPending}
        onConfirm={() => unarchiveMutation.mutate()}
      />
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete cluster permanently?"
        description={`This removes ${clusterName} and all its hosts, applications, events, baselines, and settings. This cannot be undone.`}
        confirmLabel="Delete forever"
        destructive
        pending={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />
    </Card>
  );
}
```

Note the row vs. confirm-button labels are distinct (`Archive` row button → `Archive cluster` in dialog; `Unarchive` row button → `Unarchive cluster` in dialog; `Delete` row button → `Delete forever` in dialog). This avoids selector ambiguity in tests.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @lcm/web test cluster-lifecycle-card
```

Expected: all 6 tests PASS. If the "unarchive confirm" test still has selector ambiguity, change the test to use `screen.getByRole('button', { name: /unarchive cluster/i })` — the row button is `/^unarchive$/i` and the dialog button is `/unarchive cluster/i`, so they're distinct.

- [ ] **Step 5: Run full web suite**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: typecheck PASS, lint PASS, all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/clusters/cluster-lifecycle-card.tsx apps/web/src/components/clusters/cluster-lifecycle-card.test.tsx
git commit -m "feat(web): ClusterLifecycleCard — archive/unarchive + delete with confirm dialogs"
```

---

## Task 8: Mount `ClusterLifecycleCard` in `SettingsTab`

**Files:**

- Modify: `apps/web/src/components/clusters/settings-tab.tsx`

- [ ] **Step 1: Read the current file**

```bash
cat apps/web/src/components/clusters/settings-tab.tsx
```

After sub-project 2, it should look like:

```tsx
import { BaselineEditForm } from './baseline-edit-form';
import { ClusterIdentityForm } from './cluster-identity-form';
import { ThresholdOverridesForm } from './threshold-overrides-form';

interface SettingsTabProps {
  clusterId: string;
}

export function SettingsTab({ clusterId }: SettingsTabProps): React.JSX.Element {
  return (
    <div className="space-y-6 py-4">
      <ThresholdOverridesForm clusterId={clusterId} />
      <ClusterIdentityForm clusterId={clusterId} />
      <BaselineEditForm clusterId={clusterId} />
    </div>
  );
}
```

- [ ] **Step 2: Add the lifecycle card**

Replace with:

```tsx
import { BaselineEditForm } from './baseline-edit-form';
import { ClusterIdentityForm } from './cluster-identity-form';
import { ClusterLifecycleCard } from './cluster-lifecycle-card';
import { ThresholdOverridesForm } from './threshold-overrides-form';

interface SettingsTabProps {
  clusterId: string;
}

export function SettingsTab({ clusterId }: SettingsTabProps): React.JSX.Element {
  return (
    <div className="space-y-6 py-4">
      <ThresholdOverridesForm clusterId={clusterId} />
      <ClusterIdentityForm clusterId={clusterId} />
      <BaselineEditForm clusterId={clusterId} />
      <ClusterLifecycleCard clusterId={clusterId} />
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/clusters/settings-tab.tsx
git commit -m "feat(web): mount ClusterLifecycleCard at bottom of Settings tab"
```

---

## Task 9: Render "Archived" badge on list views + detail header

**Files:**

- Modify: `apps/web/src/components/clusters/cluster-table.tsx`
- Modify: `apps/web/src/components/clusters/cluster-list-card.tsx`
- Modify: `apps/web/src/routes/clusters.$id.tsx`

- [ ] **Step 1: Update `cluster-table.tsx`**

Read the file:

```bash
cat apps/web/src/components/clusters/cluster-table.tsx
```

Find the cell that renders the cluster name (likely a `<TableCell>` containing `cluster.name` or a `<Link>` wrapping it). Wrap the existing name + a conditional badge:

```tsx
import { Badge } from '@/components/ui/badge';
// ...

// Inside the row, where the name is rendered:
<span className="inline-flex items-center gap-2">
  <Link to={...}>{cluster.name}</Link>
  {cluster.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
</span>
```

Adapt to the file's exact structure — the import path for `Badge` is `@/components/ui/badge`; preserve whatever Link / styling already exists.

- [ ] **Step 2: Update `cluster-list-card.tsx` (mobile card)**

```bash
cat apps/web/src/components/clusters/cluster-list-card.tsx
```

Find where the cluster name renders. Add the same conditional badge:

```tsx
<span className="inline-flex items-center gap-2">
  {cluster.name}
  {cluster.archivedAt ? <Badge variant="outline">Archived</Badge> : null}
</span>
```

- [ ] **Step 3: Update `clusters.$id.tsx` detail header**

```bash
grep -n "archivedAt\|baselineDate\|cluster.name" apps/web/src/routes/clusters.\$id.tsx | head -10
```

Find the `<header>` block that renders the cluster name (after sub-project 2 it's wrapped in a `<header>` with the H1). The structure is roughly:

```tsx
<header>
  <p className="text-[10px] ...">Cluster</p>
  <h1 className="...">{clusterQuery.data.name}</h1>
  <p className="mt-1 text-sm ...">Baseline {clusterQuery.data.baselineDate}{...}</p>
</header>
```

Update the H1's surrounding line to include a badge after the name:

```tsx
<header>
  <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-subtle">Cluster</p>
  <div className="mt-1 flex flex-wrap items-baseline gap-2">
    <h1 className="text-[26px] font-semibold leading-[1.1] tracking-[-0.02em] [overflow-wrap:anywhere]">
      {clusterQuery.data.name}
    </h1>
    {clusterQuery.data.archivedAt ? (
      <Badge variant="outline">Archived {clusterQuery.data.archivedAt.slice(0, 10)}</Badge>
    ) : null}
  </div>
  <p className="mt-1 text-sm text-muted-foreground">
    Baseline {clusterQuery.data.baselineDate}
    {clusterQuery.data.description ? ` · ${clusterQuery.data.description}` : null}
  </p>
</header>
```

Add `import { Badge } from '@/components/ui/badge';` at the top if missing.

The `.slice(0, 10)` extracts `YYYY-MM-DD` from the ISO timestamp.

- [ ] **Step 4: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: PASS. The cluster-tile/list-card tests may need a tiny update if they assert specific markup around the name — most likely they don't. Check for failures.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/clusters/cluster-table.tsx apps/web/src/components/clusters/cluster-list-card.tsx apps/web/src/routes/clusters.\$id.tsx
git commit -m "feat(web): Archived badge on cluster list rows + detail page header"
```

---

## Task 10: Add "Show archived" toggle to `/clusters` page

**Files:**

- Modify: `apps/web/src/routes/clusters.index.tsx`

- [ ] **Step 1: Read the current file structure**

```bash
grep -n "useQuery\|queryFn\|queryKey\|clustersQuery\|api.clusters.list" apps/web/src/routes/clusters.index.tsx | head -15
```

The page currently has one `useQuery({ queryKey: ['clusters'], queryFn: () => api.clusters.list() })` that powers both KPIs and the list.

- [ ] **Step 2: Add showArchived state + two-query split**

Open `apps/web/src/routes/clusters.index.tsx`. At the top of the component (after `useState` imports — add `useState` to the import if not present), add:

```tsx
const [showArchived, setShowArchived] = useState(false);
```

Replace the existing `clustersQuery` with TWO queries:

```tsx
const activeClustersQuery = useQuery({
  queryKey: ['clusters', { includeArchived: false }],
  queryFn: () => api.clusters.list({ includeArchived: false }),
});

const allClustersQuery = useQuery({
  queryKey: ['clusters', { includeArchived: true }],
  queryFn: () => api.clusters.list({ includeArchived: true }),
  enabled: showArchived,
});
```

Anywhere the existing code uses `clustersQuery.data` for the LIST view, switch to:

```tsx
const visibleClusters = showArchived
  ? (allClustersQuery.data ?? activeClustersQuery.data ?? [])
  : (activeClustersQuery.data ?? []);
```

Anywhere KPIs / aggregations use the data, leave them on `activeClustersQuery.data ?? []` (active-only — that's the rule).

Update all variable references in the file to use either `activeClustersQuery` (for KPIs, loading states for KPIs, error handling), or `visibleClusters` (for the list rendering).

- [ ] **Step 3: Add the toggle button in the header**

Find the page header (the `<header>` block with the H1). Adjust the surrounding flex container to fit a toggle:

The current structure ends with the existing CreateClusterDialog button on the right. Add the toggle button to the left of (or next to) the CreateClusterDialog:

```tsx
<div className="flex items-center gap-2">
  <button
    type="button"
    onClick={() => setShowArchived((v) => !v)}
    className="inline-flex h-8 items-center gap-2 rounded-[var(--radius)] border border-border bg-background px-2.5 text-xs font-medium text-fg-muted transition-colors hover:bg-card-hover hover:text-foreground"
    aria-pressed={showArchived}
  >
    <span
      aria-hidden
      className={`inline-block h-2 w-2 rounded-full ${showArchived ? 'bg-accent' : 'bg-border'}`}
    />
    {showArchived ? 'Hide archived' : 'Show archived'}
  </button>
  {activeClustersQuery.data && activeClustersQuery.data.length > 0 ? <CreateClusterDialog /> : null}
</div>
```

- [ ] **Step 4: Add the caption under the KPIs when toggle is on**

After the KPI strip block (find it by looking for `KpiTile`), conditionally render:

```tsx
{
  showArchived ? (
    <p className="text-xs text-fg-subtle">KPIs reflect active clusters only.</p>
  ) : null;
}
```

- [ ] **Step 5: Run typecheck + lint + tests**

```bash
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/clusters.index.tsx
git commit -m "feat(web): Show archived toggle on /clusters; KPIs stay active-only"
```

---

## Task 11: E2E walkthrough — archive → unarchive → delete

**Files:**

- Modify: `apps/web/playwright/settings.spec.ts`

- [ ] **Step 1: Verify the dev DB + API are running**

```bash
docker compose -f docker-compose.dev.yml ps 2>&1 | head -3
curl -sf http://localhost:8090/healthz >/dev/null && echo "api ready" || echo "api not running"
```

If API is down:

```bash
pnpm --filter @lcm/api dev > /tmp/lcm-api-e2e.log 2>&1 &
until curl -sf http://localhost:8090/healthz >/dev/null 2>&1; do sleep 1; done && echo "api ready"
```

- [ ] **Step 2: Append the new describe block**

Open `apps/web/playwright/settings.spec.ts`. After the existing `test.describe('cluster identity + baseline edit', ...)` block (from sub-project 2), append:

```ts
test.describe('cluster lifecycle', () => {
  test('archive then unarchive a cluster', async ({ page, request }) => {
    // Create a throwaway cluster so we don't mess with seeded data.
    const suffix = Date.now().toString(36);
    const name = `CL-LIFECYCLE-${suffix}`;
    const createRes = await request.post('/api/clusters', {
      data: {
        name,
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = (await createRes.json()) as { id: string };

    try {
      // Archive via UI.
      await page.goto(`/clusters/${id}`);
      await page.getByRole('tab', { name: 'Settings' }).click();
      await page.getByRole('button', { name: /^archive$/i }).click();
      const archiveResponse = page.waitForResponse(
        (r) => r.url().endsWith(`/api/clusters/${id}/archive`) && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: /^archive cluster$/i }).click();
      await archiveResponse;

      // Detail page now shows the Archived badge.
      await expect(page.getByText(/^Archived \d{4}-\d{2}-\d{2}$/)).toBeVisible();

      // Cluster is hidden from /clusters list by default.
      await page.goto('/clusters');
      await expect(page.getByText(name)).not.toBeVisible();

      // Show archived toggle reveals the cluster with a badge.
      await page.getByRole('button', { name: /show archived/i }).click();
      const row = page.locator('a', { hasText: name }).first();
      await expect(row).toBeVisible();

      // Unarchive via UI.
      await page.goto(`/clusters/${id}`);
      await page.getByRole('tab', { name: 'Settings' }).click();
      await page.getByRole('button', { name: /^unarchive$/i }).click();
      const unarchiveResponse = page.waitForResponse(
        (r) => r.url().endsWith(`/api/clusters/${id}/unarchive`) && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: /^unarchive cluster$/i }).click();
      await unarchiveResponse;

      // Cluster reappears in the default /clusters list (toggle off).
      await page.goto('/clusters');
      await expect(page.locator('a', { hasText: name }).first()).toBeVisible();
    } finally {
      // Clean up the throwaway cluster.
      await request.delete(`/api/clusters/${id}`);
    }
  });

  test('delete permanently removes the cluster', async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const name = `CL-DELETE-${suffix}`;
    const createRes = await request.post('/api/clusters', {
      data: {
        name,
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = (await createRes.json()) as { id: string };

    await page.goto(`/clusters/${id}`);
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: /^delete$/i }).click();
    const deleteResponse = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/clusters/${id}` && r.request().method() === 'DELETE',
    );
    await page.getByRole('button', { name: /delete forever/i }).click();
    await deleteResponse;

    // Page navigated to /clusters.
    await expect(page).toHaveURL(/\/clusters$/);

    // Cluster gone from both default and showArchived lists.
    await expect(page.locator('a', { hasText: name })).toHaveCount(0);
    await page.getByRole('button', { name: /show archived/i }).click();
    await expect(page.locator('a', { hasText: name })).toHaveCount(0);

    // API confirms 404.
    const getRes = await request.get(`/api/clusters/${id}`);
    expect(getRes.status()).toBe(404);
  });
});
```

- [ ] **Step 3: Run new e2e**

```bash
pnpm --filter @lcm/web test:e2e settings.spec.ts
```

Expected: 10/10 PASS (8 existing + 2 new).

If a test fails on selector ambiguity (e.g. "Archived" badge appears in both the H1 area and the row), tighten the selectors.

- [ ] **Step 4: Run full e2e suite**

```bash
pnpm --filter @lcm/web test:e2e
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/playwright/settings.spec.ts
git commit -m "test(web): e2e for cluster archive/unarchive + delete flows"
```

---

## Task 12: Final verification + PR

**Files:** none — verification + git ops only.

- [ ] **Step 1: Workspace-wide checks**

```bash
pnpm -r typecheck
pnpm -r lint
pnpm --filter @lcm/shared test
pnpm --filter @lcm/api test
pnpm --filter @lcm/web test
pnpm --filter @lcm/web test:e2e
```

Expected: all PASS.

- [ ] **Step 2: Visual sanity check**

Start dev stack if not running:

```bash
docker compose -f docker-compose.dev.yml up -d
pnpm --filter @lcm/api dev &
pnpm --filter @lcm/web dev
```

Walkthrough:

- `/clusters/<id>` → Settings tab → 4 cards: Thresholds, Identity, Baseline, Lifecycle.
- Lifecycle: Archive button → confirm dialog → cluster gains "Archived" badge next to H1.
- `/clusters` → cluster is gone from the list.
- Toggle "Show archived" → cluster reappears with "Archived" badge → toggle has "Hide archived" label.
- Caption "KPIs reflect active clusters only." visible when toggle is on.
- Click cluster → back on detail page → Settings tab → Unarchive button → confirm → "Archived" badge gone.
- Create a throwaway cluster → Settings tab → Delete → confirm → page navigates to `/clusters`, toast shown, cluster missing from both default and toggled lists.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin <branch-name>
gh pr create --title "feat: cluster delete + archive (sub-project 3 of 3)" --body "$(cat <<'EOF'
## Summary

Adds the final lifecycle controls to the cluster Settings tab:

- **Archive** — hides the cluster from default list views and fleet KPIs while preserving its forecast history; restorable via Unarchive on the same Settings tab.
- **Delete** — permanently removes the cluster + cascade through baselines/hosts/applications/events/cluster_settings.

Adds a "Show archived" toggle to /clusters that reveals archived rows (with an "Archived" badge). Cluster detail header gets an "Archived YYYY-MM-DD" badge next to the H1 when archived. KPIs always reflect active clusters only.

This is sub-project 3 of 3. The Settings tab now has four sections: Thresholds, Identity, Baseline, Lifecycle.

## Changes

- Prisma: new `archivedAt DateTime?` column on `clusters` table (additive migration, no backfill).
- Backend: `POST /api/clusters/:id/archive` + `POST /api/clusters/:id/unarchive` endpoints (idempotent, 404 on unknown cluster). `GET /api/clusters` accepts `?includeArchived=true` (default false). `DELETE` unchanged.
- Shared: `ClusterResponse.archivedAt: string | null`; `clustersListQuerySchema`.
- Web client: `api.clusters.list({ includeArchived })` (backwards-compatible), `api.clusters.archive(id)`, `api.clusters.unarchive(id)`.
- UI: `ClusterLifecycleCard` (new), "Show archived" toggle + caption + two-query split on /clusters, "Archived" badge on list rows + mobile cards + detail header.

## Test plan

- [x] `pnpm --filter @lcm/api test` — 7 new tests (archive/unarchive/filter/detail), 131 total
- [x] `pnpm --filter @lcm/web test` — 6 new tests (lifecycle card)
- [x] `pnpm --filter @lcm/web test:e2e` — 2 new tests (archive→unarchive flow; delete flow)
- [x] `pnpm -r typecheck`, `pnpm -r lint` clean

## Spec / Plan

- Spec: `docs/superpowers/specs/2026-05-25-cluster-delete-archive-design.md`
- Plan: `docs/superpowers/plans/2026-05-25-cluster-delete-archive.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Apply PR label**

```bash
gh pr edit <PR_NUMBER> --add-label "PR:Approved"
```

---

## Definition of done

- All 12 tasks complete and committed.
- `pnpm -r typecheck`, `pnpm -r lint`, full test suites + e2e all green.
- Visual walkthrough per Task 12 Step 2 confirms:
  - Settings tab has 4 cards in order: Thresholds, Identity, Baseline, Lifecycle.
  - Archive hides the cluster from /clusters default view and adds the badge to its detail header.
  - "Show archived" toggle reveals archived clusters with a badge.
  - Unarchive removes the badge and the cluster reappears in the default list.
  - Delete navigates to /clusters with a toast; the cluster is gone from both default and toggled lists; the API confirms 404 on GET.
  - KPIs on /clusters always reflect active clusters only, regardless of toggle state.
  - Overview (/) and command palette continue to show active clusters only.
- PR open with spec/plan links + test-plan checklist.
