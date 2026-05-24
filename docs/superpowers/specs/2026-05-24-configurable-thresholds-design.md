# Configurable warn/crit thresholds — design spec

**Date:** 2026-05-24
**Status:** Approved, ready for implementation plan
**Sub-project:** 1 of 3 (followed by: edit cluster name/description, then delete/archive/baseline-reset)
**Scope:** Replace hard-coded `WARN_THRESHOLD = 0.7` / `CRIT_THRESHOLD = 0.9` with persisted, configurable values at two scopes — tenant-wide defaults editable in `/settings`, plus per-cluster overrides editable in a new "Settings" tab on the cluster detail page. Update the Capacity forecast chart to label its reference lines with the threshold percent rather than the absolute GB at that line.

## Why

Today the lifecycle of every cluster forecast assumes 70%/90% as the warn/crit bands. Different teams, different workload classes, and different procurement cycles need different bands. Hard-coded constants force product teams to fork the code or live with the defaults. The user has been operating under the implicit constraint and wants explicit knobs.

The chart-label change is cosmetic but load-bearing for the same reason: today the chart says "Warn 800" (an absolute GB derived from the current capacity), which conflates the _threshold semantics_ (a percentage) with one specific projection point. "Warn 70%" reads the threshold the way the user thinks about it.

Per-cluster overrides are needed because clusters in the same tenant can have very different reasonable thresholds (e.g. a batch-processing cluster routinely runs at 85% utilization; a critical-path cluster panics at 60%).

## Design principles

1. **One resolution function, two callers.** The same `resolveThresholds(cluster, tenant, defaults)` runs server-side (forecast service) and client-side (status hooks). Single source of truth for the inheritance rule.
2. **Effective values are always defined.** Null in `ClusterSettings.warn_threshold` means "inherit"; the resolved hook never returns null. Components consume effective numbers, not nullable values.
3. **System defaults are the floor of safety.** Even if both DB rows are missing, the resolver falls back to `0.70` / `0.90` (the historical constants). No view ever crashes on a missing settings row.
4. **Validation runs at three layers.** Zod schema (request body), service-level (`warn < crit`), DB CHECK constraint (storage invariant). Each layer protects against the layer above failing.

## What changes

### 1. Resolution rule

A new function `resolveThresholds(cluster, tenantSettings, defaults)` returns `{ warn: number, crit: number }`:

```ts
export const SYSTEM_DEFAULTS = { warn: 0.7, crit: 0.9 } as const;

export function resolveThresholds(
  clusterSettings: { warnThreshold: number | null; critThreshold: number | null } | null,
  tenantSettings: { warnThreshold: number; critThreshold: number } | null,
  defaults: { warn: number; crit: number } = SYSTEM_DEFAULTS,
): { warn: number; crit: number } {
  return {
    warn: clusterSettings?.warnThreshold ?? tenantSettings?.warnThreshold ?? defaults.warn,
    crit: clusterSettings?.critThreshold ?? tenantSettings?.critThreshold ?? defaults.crit,
  };
}
```

Lives in `packages/shared/src/settings/resolve-thresholds.ts` so server and client share it.

A client hook `useEffectiveThresholds(clusterId?: string)` returns `{ warn, crit, source: 'system' | 'tenant' | 'cluster' }`:

- `clusterId` provided → fetches `/api/clusters/:id/settings`, which already returns `effective` (see §2). Source = whichever level the value came from. If warn and crit come from different levels, source reports the _most specific_ of the two (consistent with "this cluster has any override at all").
- `clusterId` omitted → fetches `/api/settings/tenant` only. Source = `'tenant'` if a row exists, else `'system'`.

The hook is built on TanStack Query with the same 5-minute `staleTime` as the rest of the app's queries.

### 2. Data model

Two new Prisma models. Both use `Decimal(4, 3)` so values like `0.700` are stored without floating-point drift.

```prisma
model TenantSettings {
  tenantId       String   @id @map("tenant_id")
  warnThreshold  Decimal  @default(0.70) @map("warn_threshold") @db.Decimal(4, 3)
  critThreshold  Decimal  @default(0.90) @map("crit_threshold") @db.Decimal(4, 3)
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  tenant         Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@map("tenant_settings")
}

model ClusterSettings {
  clusterId      String   @id @map("cluster_id")
  warnThreshold  Decimal? @map("warn_threshold") @db.Decimal(4, 3)
  critThreshold  Decimal? @map("crit_threshold") @db.Decimal(4, 3)
  updatedAt      DateTime @updatedAt @map("updated_at")

  cluster        Cluster  @relation(fields: [clusterId], references: [id], onDelete: Cascade)

  @@map("cluster_settings")
}
```

`Tenant` gets a `settings TenantSettings?` relation; `Cluster` gets a `settings ClusterSettings?` relation. Both are nullable — absence means "inherit from the next level."

**Raw SQL constraints** in the migration (Prisma doesn't model CHECK natively):

```sql
ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_warn_lt_crit
  CHECK (warn_threshold > 0 AND warn_threshold < crit_threshold AND crit_threshold <= 1);

ALTER TABLE cluster_settings ADD CONSTRAINT cluster_settings_warn_lt_crit_when_both_set
  CHECK (
    warn_threshold IS NULL
    OR crit_threshold IS NULL
    OR (warn_threshold > 0 AND warn_threshold < crit_threshold AND crit_threshold <= 1)
  );
```

The cluster constraint is conditional because a partial override (warn only or crit only) is legal as long as the effective combination still satisfies `warn < crit`. Cross-row validation happens at the service layer (see §4).

### 3. API surface

| Method   | Route                        | Body                                                               | Response                                                                                              |
| -------- | ---------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/settings/tenant`       | —                                                                  | `{ warnThreshold: number, critThreshold: number }` — auto-creates row with defaults on first GET.     |
| `PUT`    | `/api/settings/tenant`       | `{ warnThreshold: number, critThreshold: number }`                 | updated row                                                                                           |
| `GET`    | `/api/clusters/:id/settings` | —                                                                  | `{ warnThreshold: number \| null, critThreshold: number \| null, effective: { warn, crit, source } }` |
| `PUT`    | `/api/clusters/:id/settings` | `{ warnThreshold: number \| null, critThreshold: number \| null }` | updated row + recomputed effective                                                                    |
| `DELETE` | `/api/clusters/:id/settings` | —                                                                  | `{ warnThreshold: null, critThreshold: null, effective: <inherited> }` — deletes ClusterSettings row. |

**Validation (Zod in `@lcm/shared`):**

```ts
const percentSchema = z.number().min(0.01).max(0.99);
const tenantSettingsSchema = z
  .object({
    warnThreshold: percentSchema,
    critThreshold: percentSchema,
  })
  .refine((s) => s.warnThreshold < s.critThreshold, {
    message: 'warnThreshold must be less than critThreshold',
    path: ['warnThreshold'],
  });

const clusterSettingsInputSchema = z
  .object({
    warnThreshold: percentSchema.nullable(),
    critThreshold: percentSchema.nullable(),
  })
  .refine(
    (s) => {
      if (s.warnThreshold === null || s.critThreshold === null) return true;
      return s.warnThreshold < s.critThreshold;
    },
    {
      message: 'warnThreshold must be less than critThreshold',
      path: ['warnThreshold'],
    },
  );
```

When a partial cluster override is saved (e.g. user sets only warn), the service additionally checks the _combined effective_ values satisfy `warn < crit` by reading the current tenant settings and the proposed cluster overrides together. Failures return HTTP 400 with `{ code: 'effective_thresholds_invalid', field: 'warnThreshold' }`.

### 4. Forecast service integration

`apps/api/src/services/forecast.ts` currently uses hard-coded 0.70/0.90 implicitly (the forecast just emits utilization values; the runway computation lives in `forecast-summary.ts` on the client). The change:

1. **Load effective thresholds once per request** in the forecast loader (`apps/api/src/services/forecast-loader.ts`): query `TenantSettings` (cached at app start, invalidated on PUT) and `ClusterSettings` for the requested cluster.
2. **Expose `effectiveThresholds` on the ForecastResponse** so the client doesn't have to re-fetch them: extend the response schema with `{ warn: number, crit: number, source: 'system' | 'tenant' | 'cluster' }`. This means every chart consumer gets the right values without an extra query.
3. **Server-side breach hints stay unchanged in shape.** The existing `month.utilization` field is a raw ratio; the threshold band classification still happens client-side via `utilStatus(util, effectiveThresholds)`.

The runway computation (`runwayToWarn` in `apps/web/src/lib/forecast-summary.ts`) becomes a function that accepts the warn threshold rather than reading the module constant:

```ts
export function runwayToWarn(
  points: ForecastMonthPoint[],
  warnThreshold = SYSTEM_DEFAULTS.warn,
): RunwaySummary { ... }
```

Callers thread `effectiveThresholds.warn` through.

### 5. UI surfaces

**5a. `/settings` page — Forecast thresholds section**

The current placeholder gets a real section. Layout:

```
Configuration
Settings
─────────────────────────────────────────────────────────────
  FORECAST THRESHOLDS

  Warn %      [  70 ]                Below this percent, OK.
                                      Above, the chart marks the
                                      breach with the warn band.
  Crit %      [  90 ]                Below this, warn. Above, crit.

  ▌ Saved [Save]                     Source: System defaults
```

- Inputs are integer-percent (1–99). Internally stored as `0.70`.
- Submit button disabled until values change AND form is valid.
- On submit: PUT `/api/settings/tenant`. Optimistic update via TanStack Query; rollback + toast on error.
- "Source: System defaults" before first save, "Source: Saved 2026-05-24" after.

Implementation in `apps/web/src/components/settings/forecast-thresholds-form.tsx`. The page itself becomes a section host so sub-projects can add more sections without expanding the file.

**5b. Cluster Settings tab**

The cluster detail page (`/clusters/:id`) gets a fourth tab alongside Hosts / Applications / Events, labeled "Settings". The tab mounts `apps/web/src/components/clusters/settings-tab.tsx`, which today renders one section: "Thresholds". Sub-projects 2 and 3 add more sections (cluster identity, lifecycle ops) to this same component.

The Thresholds section:

```
THRESHOLDS

  Warn %      [    ] placeholder: 70   ◇ Inherited from tenant defaults
  Crit %      [    ] placeholder: 90

  [Save override]  [Reset to inherited]
```

- Empty inputs show the inherited value as placeholder text in `--fg-subtle`.
- Typing into an input switches it into "overridden" state (the placeholder disappears, the value becomes editable).
- Saving any override creates the `ClusterSettings` row → source pill flips from "Inherited from tenant defaults" to "Cluster override" with honey accent.
- "Reset to inherited" calls DELETE → the row is removed and the source pill flips back. Disabled when no override is in effect.
- Partial overrides allowed: a user can override only warn and leave crit inherited (cluster row has warn populated, crit null).
- "Save override" button is disabled when both inputs are empty (no overrides to save). Clearing all overrides is done via "Reset to inherited" (DELETE), not by saving an empty PUT — this prevents accumulating no-op `ClusterSettings` rows.
- Validation errors render inline under the offending field (Section 3 rules); the cross-field check ("warn < crit" using effective values) shows under warn.

**5c. Chart labels — percent**

Both `apps/web/src/components/clusters/forecast-chart.tsx` and `apps/web/src/components/overview/fleet-capacity-chart.tsx` change their `<ReferenceLine>` label format:

```tsx
// before
value: `Warn ${numberFormat.format(Math.round(maxCeiling * 0.7))}`,

// after
value: `Warn ${Math.round(warn * 100)}%`,
```

Reference-line `y` position stays `maxCeiling × warn` (or `× crit`) — the line geometry is unchanged, only the label text changes.

For the per-cluster chart, `warn` and `crit` come from `forecast.effectiveThresholds` (server-provided, §4).

For the fleet chart, `warn`/`crit` come from `useEffectiveThresholds()` (no cluster id → tenant defaults). The fleet chart does not aggregate per-cluster overrides — that semantic would require deciding e.g. "show the strictest threshold across clusters" or "show the average", and neither is obviously right. Out of scope for sub-project 1.

**5d. Threshold consumers**

Four components currently hard-code `0.7`/`0.9`:

- `apps/web/src/lib/forecast-summary.ts` — `utilStatus(util)` becomes `utilStatus(util, { warn, crit })`.
- `apps/web/src/components/ui/utilization-gauge.tsx` — `bandOf(value)` becomes `bandOf(value, { warn, crit })`. The component accepts optional `warn?`/`crit?` props.
- `apps/web/src/components/ui/runway-pill.tsx` — already consumes a `RunwaySummary`; its variant logic stays the same since the breach point is captured in the summary. No threshold prop needed.
- `apps/web/src/components/clusters/utilization-badge.tsx` — accepts optional `warn?`/`crit?` props.

All three components default to `SYSTEM_DEFAULTS` when props are missing, keeping current call sites working. Call sites that have a cluster context (`routes/clusters.$id.tsx`, KpiStrip) pass effective values from the hook.

### 6. Migration safety

The migration is additive:

1. `CREATE TABLE tenant_settings` (no data).
2. `CREATE TABLE cluster_settings` (no data).
3. Add CHECK constraints.

No backfill needed. Existing clusters have no `ClusterSettings` row, which means they inherit from tenant, which has no row, which means they inherit `SYSTEM_DEFAULTS = (0.70, 0.90)` — identical to current behavior.

On first GET of `/api/settings/tenant`, the service uses `upsert` to create a default row (so subsequent PUTs have something to update). This is a get-or-create pattern, idempotent.

Migration is reversible: dropping both tables restores the prior state.

## Files

**New (9):**

- `apps/api/prisma/migrations/<ts>_add_settings_tables/migration.sql`
- `apps/api/src/services/settings.ts`
- `apps/api/src/routes/settings.ts`
- `apps/api/src/services/__tests__/settings.test.ts`
- `packages/shared/src/schemas/settings.ts`
- `packages/shared/src/settings/resolve-thresholds.ts`
- `apps/web/src/lib/use-effective-thresholds.ts`
- `apps/web/src/components/settings/forecast-thresholds-form.tsx`
- `apps/web/src/components/clusters/threshold-overrides-form.tsx`
- `apps/web/src/components/clusters/settings-tab.tsx`

**Modified (~14):**

- `apps/api/prisma/schema.prisma` — add models and relations.
- `apps/api/src/services/forecast.ts` and `forecast-loader.ts` — load + thread effective thresholds.
- `apps/api/src/services/forecast.ts` — extend `ForecastResponse` schema.
- `apps/api/src/server.ts` (or wherever routes register) — wire `settingsRoutes`.
- `packages/shared/src/index.ts` — export new schemas + resolver.
- `packages/shared/src/schemas/forecast.ts` — add `effectiveThresholds` to `ForecastResponse`.
- `apps/web/src/lib/api-client.ts` — add `api.settings.{tenant,cluster}.*` methods.
- `apps/web/src/lib/forecast-summary.ts` — accept thresholds in `runwayToWarn` and `utilStatus`.
- `apps/web/src/components/ui/utilization-gauge.tsx`, `runway-pill.tsx`.
- `apps/web/src/components/clusters/utilization-badge.tsx`.
- `apps/web/src/components/clusters/forecast-chart.tsx`, `apps/web/src/components/overview/fleet-capacity-chart.tsx` — percent labels.
- `apps/web/src/routes/settings.tsx` — host tenant thresholds form.
- `apps/web/src/routes/clusters.$id.tsx` — add fourth tab "Settings".

## Out of scope (sub-project 1)

- **Edit cluster name/description** — sub-project 2.
- **Delete / archive / baseline reset** — sub-project 3.
- **Multi-tenant switching UI** — there is still one default tenant; this work scopes settings via the existing tenant resolution.
- **Audit log** of threshold changes.
- **Per-metric thresholds** — only `memory_gb` exists today; per-metric is a future concern that would change the column shape from `(warn, crit)` to `(metric_key, warn, crit)`.
- **Aggregated fleet-chart thresholds** — fleet view uses tenant defaults only.
- **Status pill on the chart itself** to indicate the source — the pill lives only in the Settings tab form.

## Testing

**Server:**

- `apps/api/src/services/__tests__/settings.test.ts`:
  - `resolveThresholds()` covers all 8 combinations of (null, set) × (null, set) × (cluster, tenant).
  - Service `getTenantSettings` auto-creates on first call (idempotent).
  - `updateClusterSettings` rejects effective `warn ≥ crit` even when one value is inherited.
  - DB constraint rejects invalid rows (integration test against a real Postgres in the CI matrix).
- Route integration tests for all 5 endpoints (200, 400 validation, 404 unknown cluster).

**Client:**

- `apps/web/src/lib/__tests__/use-effective-thresholds.test.ts` — hook resolution, source field correctness.
- Form components have their own behavioral tests (save, reset, validation errors).
- `forecast-chart` snapshot updates for the new label format.

**E2E:**

- `apps/web/playwright/settings.spec.ts` (new): set tenant defaults to 65/85 → fleet chart shows "Warn 65%" / "Crit 85%". Override one cluster to 75/95 → cluster chart shows "Warn 75%" / "Crit 95%" while sibling clusters still inherit tenant. Reset cluster override → back to inherited.

## Definition of done

- Migration applies cleanly to a dev DB; rollback also clean.
- All 5 API endpoints work per the table in §3; integration tests green.
- Resolver function covered by unit tests; client + server import the same module.
- `/settings` page renders the Forecast thresholds form; saving updates persistence and all charts/badges/gauges reflect the new values within one refetch interval.
- Cluster detail page has a fourth "Settings" tab containing the Thresholds override form; source pill flips correctly between inherited and override.
- `forecast-chart` and `fleet-capacity-chart` labels read "Warn N%" / "Crit N%" where N derives from the effective threshold.
- Existing snapshot + unit tests updated; full `pnpm --filter @lcm/web test` and `pnpm --filter @lcm/api test` green.
- E2E walkthrough in `settings.spec.ts` green.
- No regression in cluster forecast accuracy (same `month.utilization` values; only the classification thresholds change).
