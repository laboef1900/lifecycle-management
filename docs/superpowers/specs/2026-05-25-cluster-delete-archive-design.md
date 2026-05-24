# Cluster delete + archive — design spec

**Date:** 2026-05-25
**Status:** Approved, ready for implementation plan
**Sub-project:** 3 of 3 (preceded by configurable thresholds, then identity + baseline edit)
**Scope:** Add cluster lifecycle controls to the Settings tab — Archive (hide from list but keep restorable; history preserved) and Delete (permanent purge). Adds a "Show archived" toggle to the clusters list, an "Archived YYYY-MM-DD" badge on detail + list, and an `archivedAt` column on `Cluster`. Fleet KPIs and the overview page continue to reflect active clusters only.

## Why

After sub-projects 1 and 2, the Settings tab edits a cluster's thresholds, identity, and baseline. The remaining lifecycle operations — taking a decommissioned cluster out of fleet KPIs without losing its history, or permanently removing one created in error — still require dropping into the database. Operators need a UI for both, with the safety the two operations deserve (archive is reversible; delete is not).

The `DELETE /api/clusters/:id` endpoint already exists and cascades cleanly. Archive is genuinely new — a soft-delete column plus a small surface of endpoints, plus the filtering logic to keep archived clusters out of fleet aggregates.

## Design principles

1. **Three explicit states, no implicit transitions.** `active`, `archived`, `deleted`. Every transition is a user action with its own confirm dialog. No auto-archive after N months, no auto-delete after archive, no soft-delete with "undo" timer.
2. **Archive ≠ read-only.** Archived clusters can still be edited (thresholds, identity, baseline) — the only thing archive changes is visibility in default lists. This keeps the implementation simple and matches user expectations: "I archived this cluster but I still want to fix that wrong baseline date I noticed."
3. **Fleet aggregates stay active-only.** Overview KPIs, clusters-list KPIs, command palette — none of them include archived clusters. The "Show archived" toggle on `/clusters` only changes the list rows, not the KPI strip above.
4. **Delete cascades naturally.** Existing `onDelete: Cascade` FK rules on hosts/applications/events/baselines/cluster_settings already do the right thing. No new code for cleanup.

## What changes

### 1. Lifecycle states

A cluster is in exactly one of:

- **active** — `archivedAt IS NULL`. Default state on creation.
- **archived** — `archivedAt = <ISO timestamp>`. Hidden from default lists, still readable + editable, restorable.
- **deleted** — row gone via `DELETE /api/clusters/:id`. Cascade removes baselines, hosts, applications, events, cluster_settings.

Transitions:

```
[active] ──archive──→ [archived] ──unarchive──→ [active]
   │                       │
   └──delete──┐    ┌──delete──┘
              ↓    ↓
           [deleted forever]
```

All transitions are user-initiated through the Settings tab "Lifecycle" card.

### 2. Data model

Add one nullable column to `Cluster` (Prisma):

```prisma
model Cluster {
  // ...existing fields...
  archivedAt DateTime? @map("archived_at")
}
```

No CHECK constraint, no partial index. Filtering is `WHERE archived_at IS NULL` on a single-tenant query that already scans a small set of cluster rows. Add a partial index later if a tenant's cluster count crosses ~10k.

`ClusterMetricBaseline`, `Host`, `Application`, `Event`, `ClusterSettings` already have `onDelete: Cascade` against `Cluster` — nothing changes there. Permanent delete removes the cluster row and the FK cascade does the rest.

### 3. API surface

| Method   | Route                                | Body | Response                                         | Notes                                                                                                       |
| -------- | ------------------------------------ | ---- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/clusters?includeArchived=bool` | —    | `ClusterResponse[]` (`archivedAt` field present) | Default `false`. Filters `WHERE archivedAt IS NULL` when omitted or `false`.                                |
| `POST`   | `/api/clusters/:id/archive`          | —    | `ClusterResponse` with non-null `archivedAt`     | Idempotent: re-archiving an archived cluster returns it unchanged (still archived). 404 if cluster missing. |
| `POST`   | `/api/clusters/:id/unarchive`        | —    | `ClusterResponse` with `archivedAt: null`        | Idempotent: unarchiving an active cluster is a no-op. 404 if cluster missing.                               |
| `DELETE` | `/api/clusters/:id`                  | —    | 204 No Content                                   | **Unchanged.** Permanent; cascade-deletes children.                                                         |
| `GET`    | `/api/clusters/:id`                  | —    | `ClusterResponse` (`archivedAt` field present)   | **Unchanged behavior;** field is new. Archived clusters still returned.                                     |
| `GET`    | `/api/clusters/:id/forecast`         | —    | `ForecastResponse`                               | **Unchanged.** Archived clusters still produce forecasts (history preserved).                               |
| `PUT`    | `/api/clusters/:id`                  | —    | `ClusterResponse`                                | **Unchanged.** Archived clusters can still be edited.                                                       |

**Schemas (`packages/shared/src/schemas/cluster.ts`):**

- `ClusterResponse` interface gains `archivedAt: string | null`.
- New `clustersListQuerySchema = z.object({ includeArchived: z.coerce.boolean().optional() })`.

**Service (`apps/api/src/services/clusters.ts`):**

- `list(tenantId, { includeArchived })` — filter on `archivedAt IS NULL` when `includeArchived` is falsy.
- `archive(tenantId, id)` — `UPDATE clusters SET archived_at = now() WHERE id AND tenant_id`. If already archived, no-op (idempotent). Returns the cluster.
- `unarchive(tenantId, id)` — `UPDATE ... SET archived_at = NULL`. Same idempotency rule.
- `toResponse(row)` — include `archivedAt: row.archivedAt?.toISOString() ?? null`.

### 4. Web client (`apps/web/src/lib/api-client.ts`)

```ts
clusters: {
  list: (params?: { includeArchived?: boolean }) => {
    const qs = params?.includeArchived ? '?includeArchived=true' : '';
    return request<ClusterResponse[]>(`/api/clusters${qs}`);
  },
  // ...existing get, create, update, delete...
  archive: (id: string) =>
    request<ClusterResponse>(`/api/clusters/${id}/archive`, { method: 'POST' }),
  unarchive: (id: string) =>
    request<ClusterResponse>(`/api/clusters/${id}/unarchive`, { method: 'POST' }),
},
```

`api.clusters.list()` (no args) continues to return active clusters only — backwards-compatible with existing call sites (`/`, `/clusters`, command palette).

### 5. UI surfaces

**5a. Clusters list page (`/clusters`)**

Add a "Show archived" toggle near the header. Use a simple `<button>` styled as a chip (the codebase has no `Switch` primitive). Visual:

```
Capacity Forecast
Clusters                            [☐ Show archived]    [+ Add cluster]
12 clusters tracked
```

State management:

- `const [showArchived, setShowArchived] = useState(false);`
- Two queries with separate keys: `['clusters', { includeArchived: false }]` (always; powers KPIs + list when toggle off) and `['clusters', { includeArchived: true }]` (enabled only when toggle on; powers list when toggle on).
- KPIs always read from the active-only query.
- The cluster list switches between the two queries' `data` based on `showArchived`.

Archived clusters in the list (both table and mobile card) render an "Archived" badge after the name using the existing `Badge` `variant="outline"` from sub-project 1. Date is not shown in the list — it appears on the detail page where there's room.

A small clarifying caption appears below the KPI strip when `showArchived` is on: `"KPIs reflect active clusters only."`

**5b. Cluster detail page header**

When `cluster.archivedAt !== null`, render a badge next to the H1:

```
Cluster
CL-PROD-Old · Archived 2026-05-25
Baseline 2024-01-01
```

Badge variant: `outline` (muted). Date format: `YYYY-MM-DD` (matches `baselineDate` formatting elsewhere).

**5c. Settings tab — new Lifecycle card**

Stack at the bottom of `SettingsTab`, after `BaselineEditForm`:

```
LIFECYCLE

  Archive cluster
  Archived clusters are hidden by default but stay readable and
  restorable. Forecast history is preserved.
                                                       [Archive]

  ─────────────────────────────────────────────────────────────

  Delete cluster
  Permanently removes this cluster, its baselines, hosts,
  applications, and events. This cannot be undone.
                                                        [Delete]
```

When the cluster is archived, the top row inverts:

```
  Unarchive cluster
  Restore this cluster to the active list. Its forecasts, hosts,
  applications, and events are unaffected.
                                                     [Unarchive]
```

Both archive and unarchive use the existing `ConfirmDialog` primitive with `destructive=false`:

- Archive dialog: `title="Archive cluster?"`, `confirmLabel="Archive cluster"`.
- Unarchive dialog: `title="Unarchive cluster?"`, `confirmLabel="Unarchive"`.

Both dialogs use `<Button variant="accent">` for confirmation (matches existing non-destructive confirms).

Delete uses `ConfirmDialog` with `destructive=true`:

- Title: `"Delete cluster permanently?"`
- Description: `"This removes ${cluster.name} and all its hosts, applications, events, baselines, and settings. This cannot be undone."`
- `confirmLabel="Delete forever"`
- Confirm button: `variant="destructive"`.

On delete success: navigate to `/clusters` and toast `"Cluster deleted."` Invalidate both `['clusters', { includeArchived: false }]` and `['clusters', { includeArchived: true }]`.

On archive/unarchive success: update both `['cluster', id]` (with the returned row) and invalidate both clusters list queries. Stay on the page — the archived badge appears next to the H1.

**5d. Overview page (`/`)** — no UI changes. `api.clusters.list()` defaults to `includeArchived: false`, so archived clusters disappear from the fleet view automatically.

**5e. Command palette** — no UI changes. Same reason.

## Files

**New:**

- `apps/api/prisma/migrations/<timestamp>_add_cluster_archived_at/migration.sql`
- `apps/web/src/components/clusters/cluster-lifecycle-card.tsx`
- `apps/web/src/components/clusters/cluster-lifecycle-card.test.tsx`

**Modified (backend):**

- `apps/api/prisma/schema.prisma` — add `archivedAt DateTime?` to `Cluster`.
- `apps/api/src/services/clusters.ts` — add `archive` + `unarchive` methods; extend `list` signature; include `archivedAt` in `toResponse`.
- `apps/api/src/routes/clusters.ts` — register `POST /:id/archive`, `POST /:id/unarchive`; parse `includeArchived` query into `list` call.
- `apps/api/src/__tests__/clusters.test.ts` — new tests for archive/unarchive/filter; update existing list tests to confirm default-hides archived.

**Modified (shared):**

- `packages/shared/src/schemas/cluster.ts` — add `archivedAt: string | null` to `ClusterResponse`; add `clustersListQuerySchema`.

**Modified (web):**

- `apps/web/src/lib/api-client.ts` — `archive`, `unarchive` methods; extend `list` to accept `{ includeArchived? }`.
- `apps/web/src/routes/clusters.index.tsx` — `showArchived` state + toggle button + caption + two-query split.
- `apps/web/src/components/clusters/cluster-table.tsx` — render archived badge per row.
- `apps/web/src/components/clusters/cluster-list-card.tsx` — render archived badge on mobile card.
- `apps/web/src/routes/clusters.$id.tsx` — render archived badge next to H1.
- `apps/web/src/components/clusters/settings-tab.tsx` — mount `<ClusterLifecycleCard>` at the bottom.
- `apps/web/playwright/settings.spec.ts` — e2e for archive → unarchive → delete flow.

**Untouched:**

- `Cluster.delete` service method + route — already exist, work as-is.
- All cascade rules (`onDelete: Cascade` on baselines, hosts, applications, events, cluster_settings).
- Forecast service.
- Overview page (`/`).
- Command palette.

## Testing

**Server (`apps/api/src/__tests__/clusters.test.ts`):**

- `POST /api/clusters/:id/archive` sets `archivedAt` and returns the row.
- `POST /api/clusters/:id/archive` on an already-archived cluster returns 200 + unchanged `archivedAt` (idempotent).
- `POST /api/clusters/:id/unarchive` clears `archivedAt`.
- `POST /api/clusters/:id/archive` on unknown cluster returns 404.
- `GET /api/clusters` hides archived by default.
- `GET /api/clusters?includeArchived=true` returns active + archived.
- `GET /api/clusters/:id` returns archived clusters too (no filtering on detail route).
- `DELETE /api/clusters/:id` still works on archived clusters (regression check).

**Web (`apps/web/src/components/clusters/cluster-lifecycle-card.test.tsx`):**

- Renders "Archive cluster" + "Delete cluster" rows when cluster is active.
- Renders "Unarchive cluster" + "Delete cluster" rows when cluster is archived.
- Archive button click opens the archive confirm dialog; confirm calls `api.clusters.archive`; cache updates with new `archivedAt`.
- Delete button click opens the delete confirm dialog; confirm calls `api.clusters.delete`; navigates to `/clusters` and shows toast.
- Cancel in either dialog does not submit.

**E2E (`apps/web/playwright/settings.spec.ts`):**

One new test: open `/clusters/<id>` → Settings tab → Archive (confirm) → cluster gains "Archived" badge → navigate to `/clusters` → not in list → toggle "Show archived" on → cluster appears with badge → click cluster → back on detail page → Unarchive (confirm) → cluster gone from archived view → toggle off → cluster appears in active list again.

Delete is exercised in a separate test that creates a throwaway cluster first (avoid wiping a seeded cluster that other tests depend on): `request.post('/api/clusters', { ... })` → navigate to its Settings → Delete (confirm) → assert redirect to `/clusters` + cluster missing from both queries.

## Migration safety

The migration is additive:

```sql
ALTER TABLE clusters ADD COLUMN archived_at TIMESTAMPTZ NULL;
```

No data backfill needed. All existing clusters become `active` (null `archivedAt`) automatically. Rollback is `DROP COLUMN`.

The migration runs automatically via `api-entrypoint.sh` on container start (Sub-project 1 verified this works).

## Definition of done

- `archived_at` column exists on `clusters`.
- All 4 new endpoints work per the table in §3; integration tests green.
- Clusters list page shows "Show archived" toggle; default hides archived; toggle on reveals them with badge.
- Cluster detail page shows `Archived YYYY-MM-DD` badge next to H1 for archived clusters.
- Settings tab shows Lifecycle card with Archive/Unarchive + Delete rows, each with a confirm dialog matching the destructive convention.
- Archive/unarchive update the cluster's appearance in the list within one query refetch; delete navigates away and the cluster is gone from both queries.
- Overview page (`/`) and command palette continue to show active clusters only.
- E2E walkthrough green; full `pnpm --filter @lcm/web test`, `pnpm --filter @lcm/api test`, `pnpm --filter @lcm/web test:e2e` green; typecheck + lint clean.

## Out of scope

- Bulk archive / bulk delete (one cluster at a time).
- Search across archived clusters (command palette is active-only).
- Audit log of who archived / deleted what, and when (the `archivedAt` timestamp is the only history).
- Soft-delete or archive for hosts, applications, events — only the cluster itself.
- Auto-archive after N months of inactivity.
- A "deleted clusters" trash / restore-within-N-days flow. Delete is permanent.
- Forecast for archived clusters being downgraded (still computed normally — that's the spec, since history is meant to be preserved).
- Fleet KPIs including archived clusters under any toggle. The "Show archived" toggle only affects the list rendering, never the KPI computation.
