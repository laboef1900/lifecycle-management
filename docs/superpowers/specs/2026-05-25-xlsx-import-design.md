# Capacity_Forecast_vSphere.xlsx import — design spec

**Date:** 2026-05-25
**Status:** Approved, ready for implementation plan
**Scope:** Add a one-time CLI tool that parses `docs/Capacity_Forecast_vSphere.xlsx` and replaces all events + hosts on the 4 reference clusters with the events the spreadsheet records (32 across the four). Cluster baselines are unchanged (the seed already matches the xlsx). No schema changes, no shared-package changes, no UI.

## Why

The reference spreadsheet is the original capacity-planning source of truth. The existing seed (`apps/api/prisma/seed.ts`) carries only the May 2026 baseline numbers (consumption + capacity per cluster); it does not seed any of the growth, OpenShift roll-out, or hardware-expansion events the spreadsheet records over the May 2026 → Dec 2027 horizon. That makes the forecast chart for every seeded cluster a flat line — exactly the unhelpful state the rest of this product is designed to surface.

Importing the events once gives every cluster a realistic 18-month forecast at startup, which is the right baseline for demos and for evaluating the chart redesigns we shipped earlier today.

## Design principles

1. **One-time tool, not a runtime feature.** The script lives in `apps/api/scripts/` and is intended to be run twice (once against the dev DB, once against the prod DB on this branch) and then never again. `xlsx` is a `devDependency`, not a runtime dep.
2. **Wipe and replace, scoped to the 4 named clusters.** Operator-entered data on any other cluster is untouched. Operator-entered data on CL-DMZ-P1, CL-Prod-P2, CL-Test-P2, CL-Prod-P2-Oracle is intentionally destroyed in favour of the spreadsheet's authoritative events. (Per the brainstorming decision; the seed has run, the operator has experimented, the spreadsheet should now win.)
3. **Parser is a separate, pure function.** The DB-mutating script is a thin wrapper; the parser takes a file path and returns plain objects. The parser is unit-tested; the script is exercised via a documented manual run.
4. **Fail loudly on unknown shapes.** New event-title prefixes the spreadsheet author might add, sheet renames, missing clusters in the DB — all throw before any DB write. We'd rather see the error than silently lose data.

## What changes

### 1. File layout

**Add** (under `apps/api/`)

- `scripts/import-xlsx.ts` — the CLI. Reads the xlsx, opens a Prisma transaction, wipes events + hosts on the 4 reference clusters, inserts the parsed events, commits.
- `scripts/lib/parse-capacity-xlsx.ts` — the parser. Pure function, no DB access. Walks the single `Forecast` sheet, returns `ParsedCluster[]`.
- `scripts/lib/parse-capacity-xlsx.test.ts` — Vitest tests for the parser. Runs against the real `docs/Capacity_Forecast_vSphere.xlsx` plus a tiny inline fixture for the error case.

**Modify**

- `apps/api/package.json` — add `xlsx` (^0.18, MIT) as a `devDependency`. Add a convenience script `"db:import-xlsx": "tsx scripts/import-xlsx.ts"`.

**No** schema migration, **no** shared-package change, **no** seed.ts change. The seed continues to produce baselines only; the import script runs after the seed to populate events.

### 2. Source shape

The spreadsheet has a single sheet `Forecast` (in German: "Forecast - Monatliche Kapazität"). Its layout, confirmed by `python -m openpyxl` walk during brainstorming:

- **Row 7 is the month header.** Columns F → AA carry month dates from 2026-05-01 to 2027-12-01, with two gaps: column L (no header) and column P (no header).
- **Cluster blocks start at rows 9, 18, 26, 34.** Column B of each row holds the cluster name (`CL-DMZ-P1`, `CL-Prod-P2`, `CL-Test-P2`, `CL-Prod-P2-Oracle`). Column C holds current consumption (GB), column D holds current capacity (GB) — both match the seed.
- **Each cluster block is 7 rows tall.** From the cluster's name row, the relative offsets are:
  - offset +0 — **event labels**, one per column, free-text German titles
  - offset +1 — blank
  - offset +2 — `E = "HW-Limit Δ GB"`; numeric capacity deltas per event column
  - offset +3 — `E = "Verbrauch Δ GB"` (`"Verbrauch GB"` for the CL-DMZ-P1 block); numeric consumption deltas per event column
  - offset +4 — running consumption (used as cross-check only)
  - offset +5 — running capacity (used as cross-check only)
  - offset +6 — running utilization (unused)
- **Columns L and P are mid-month sub-event slots.** They share their calendar month with the column immediately to their right: column L belongs to October 2026 (column K's month — running totals confirm), column P belongs to January 2027 (column O's month). The parser assigns L-column events `effectiveDate = '2026-10-01'` and P-column events `effectiveDate = '2027-01-01'`.

### 3. Parser contract

```ts
export type ParsedEventCategory = 'growth' | 'hardware_change' | 'openshift';

export interface ParsedEvent {
  effectiveDate: string; // 'YYYY-MM-DD'
  title: string; // verbatim from xlsx (German is fine)
  category: ParsedEventCategory;
  capacityDelta: number | null; // GB; null when row has no Δ for this column
  consumptionDelta: number | null;
}

export interface ParsedCluster {
  name: string; // 'CL-DMZ-P1' etc.
  baselineConsumption: number; // col C of cluster's header row
  baselineCapacity: number; // col D
  events: ParsedEvent[];
}

export function parseCapacityXlsx(filePath: string): ParsedCluster[];
```

### 4. Category inference

First match wins (case-insensitive), in this order:

| Match                                                                           | Category          |
| ------------------------------------------------------------------------------- | ----------------- |
| Starts with `Wachstum`                                                          | `growth`          |
| Starts with `Ausbau` _or_ `Umbau`                                               | `hardware_change` |
| Contains `OpenShift` anywhere (incl. `START OpenShift`, `OpenShift - Aufbau …`) | `openshift`       |

Anything that matches none of the above throws an explicit error naming the offending title and column. We'd rather refuse the import than guess.

### 5. Zero-delta filter

Events with `capacityDelta == null && consumptionDelta == null` (or both `== 0`, treated as null) are skipped during parsing. The Event schema (`packages/shared/src/schemas/event.ts`, `hasUsefulPayload`) rejects such rows unless category is `note`; we never produce them. This drops the 5 `Wachstum Q*` rows on CL-Prod-P2-Oracle that the spreadsheet author left at 0 as placeholders.

### 6. Script flow (`import-xlsx.ts`)

1. Resolve path: argv[2] if given, else `<repo-root>/docs/Capacity_Forecast_vSphere.xlsx`.
2. Validate the file exists; abort otherwise.
3. Print `"Importing from <path>"`.
4. Call `parseCapacityXlsx(path)` → `clusters: ParsedCluster[]`. Print a per-cluster line: `"  CL-DMZ-P1: 12 events"`.
5. Open a Prisma transaction:
   - Look up the `memory_gb` MetricType once; abort if missing.
   - For each parsed cluster:
     - Look up `Cluster { tenantId: 'default', name }`. Abort the transaction with a clear message if missing.
     - `prisma.event.deleteMany({ where: { clusterId } })` — wipes both operator events and any prior imports.
     - `prisma.host.deleteMany({ where: { clusterId } })` — cascades to `HostMetricCapacity`.
     - For each parsed event: `prisma.event.create({ data: { clusterId, tenantId, metricTypeId, effectiveDate, category, title, capacityDelta, consumptionDelta } })`.
6. Commit. Print a per-cluster summary: `"  CL-DMZ-P1: deleted N events, M hosts; inserted 12 events"`.
7. Exit 0 on success.

### 7. Error handling

- Missing or unreadable xlsx file → exit 1 with the resolved path.
- Sheet `Forecast` missing → exit 1.
- Cluster name from xlsx not present in the DB → throw before opening the transaction (the transaction never starts; nothing is deleted).
- Unknown event-title prefix → throw inside the parser (likewise no DB write).
- Any Prisma error inside the transaction → rolls back; nothing partially imported.

### 8. Testing

`apps/api/scripts/lib/parse-capacity-xlsx.test.ts` (Vitest, no DB) covers:

1. Parses the real `docs/Capacity_Forecast_vSphere.xlsx` and asserts:
   - 4 clusters in the expected order.
   - Names + baselines match the seed (`CL-DMZ-P1` 3378/7680, `CL-Prod-P2` 19188/40960, `CL-Test-P2` 3345/8192, `CL-Prod-P2-Oracle` 1564/4096).
   - Event counts: CL-DMZ-P1 = 12, CL-Prod-P2 = 9, CL-Test-P2 = 11, CL-Prod-P2-Oracle = 0. The CL-DMZ-P1 `"START OpenShift"` marker at column G has no deltas in either Δ row, so the zero-delta filter drops it (12 = 13 raw event-label cells − 1 marker). CL-Prod-P2-Oracle's 5 `Wachstum Q*` rows are all dropped for the same reason.
2. CL-DMZ-P1's "Ausbau Memory HPE-Server" event is end-to-end correct: `effectiveDate = '2026-10-01'` (the L→K mapping), `category = 'hardware_change'`, `capacityDelta = 2560`, `consumptionDelta = null`.
3. A tiny inline fixture xlsx with an unmapped title prefix (e.g. `"Foobar Q1"`) causes the parser to throw with a message naming the title.

The script itself is not unit-tested. It is exercised via the manual run described next.

### 9. Manual verification

After the script lands and the dev DB is seeded, run from the repo root:

```bash
pnpm --filter @lcm/api db:import-xlsx
```

Then:

- `curl -s http://localhost:8090/api/clusters/<CL-DMZ-P1-id>/events | jq length` — expect 12.
- Open the running web app at `/`, navigate to CL-DMZ-P1, confirm the forecast chart shows capacity step-ups at Oct 26, Dec 26, and May 27 (matching the spreadsheet's HW-Limit row).
- After dev verification passes, repeat against the prod DB on this branch — the actual one-time import.

## Out of scope

- Re-importing on a schedule, or detecting xlsx changes — explicitly one-time.
- A UI upload form for arbitrary xlsx files — separate feature, not in this scope.
- Persisting hosts from the spreadsheet — the spreadsheet only models capacity changes as events, not as named host inventory. Adding host records would require a different source.
- Updating seed.ts to also run the import — the seed stays baseline-only; the script is a separate, explicit step.
- Cross-tenant support — assumes the default tenant.
