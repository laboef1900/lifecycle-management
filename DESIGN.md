# DESIGN — Move a host between clusters (time-scoped membership) — #289

**Risk: HIGH** — touches forecast-engine correctness (drives hardware purchasing) and adds a
Prisma migration. Merge requires two independent AI reviews + green CI per the Automated
high-risk approval policy (CLAUDE.md). This document is the written design/spec/threat-model the
policy mandates.

## 1. Problem & owner decision

A manual host is pinned to its creating cluster: there is no cluster-changing path, so relocating a
host means delete + recreate, which loses its capacity history. Issue #289 adds a move.

The owner recorded (2026-07-22) that membership is **time-scoped**, NOT a naive `clusterId` flip. A
flip re-attributes the host's _entire_ capacity history to the destination across _all_ modelled
months, retroactively rewriting both clusters' forecasts on a purchasing surface. Time-scoped
attribution instead credits the **old** cluster before the move date and the **new** cluster after
it, and never rewrites the past.

## 2. Data model

New table `host_cluster_memberships` (`HostClusterMembership`):

| column           | type  | notes                                                  |
| ---------------- | ----- | ------------------------------------------------------ |
| `id`             | text  | cuid (client-generated), uuid for the SQL backfill     |
| `tenant_id`      | text  | tenant scope, default `'default'` (project convention) |
| `host_id`        | text  | FK → hosts, `ON DELETE CASCADE`                        |
| `cluster_id`     | text  | FK → clusters, `ON DELETE CASCADE`                     |
| `effective_from` | date  | inclusive start of the interval                        |
| `effective_to`   | date? | exclusive end; `NULL` = the current (open) membership  |
| `created_at`     | ts    | audit                                                  |

`HostMetricCapacity` stays FK'd to `host_id` (unchanged) — no capacity rows are moved or recreated.
Attribution is resolved through the membership timeline at forecast time.

`Host.clusterId` is retained as a denormalised "current cluster" pointer used pervasively (host
lists, host responses, replacements, sync's `missingHosts` query, the cluster panel's current-month
capacity). **Invariant kept by construction: `Host.clusterId` == the host's open membership's
`clusterId`.** Every write path maintains both together.

### Why no partial unique index for "one open membership"

Postgres could enforce "≤1 open membership per host" with a partial unique index
(`WHERE effective_to IS NULL`). The schema deliberately avoids partial indexes (see the
`hosts_tenant_serial_unique` comment / #123: partial indexes desync from Prisma and cause spurious
`migrate dev` drift). Consistent with that precedent and with the app-enforced
`source='vsphere' ⇒ observed_at NOT NULL` invariant, the single-open-membership invariant is
enforced in application code inside **Serializable** transactions. Tests pin it.

## 3. Trust boundaries & misuse cases

- **API boundary**: `POST /api/hosts/:id/move` body is validated by `hostMoveInputSchema`
  (`@lcm/shared`, Zod `strictObject`) _inside_ the handler before any DB access.
- **RBAC**: a mutating POST ⇒ `requiresAdmin` gates it by construction (method-based). VIEWER → 403.
  Asserted by test, not assumed.
- **Sync ownership**: a synced host's cluster membership is owned by vCenter (`reconcileHosts`).
  Manual move of a synced **host** → `ConflictError('SYNC_OWNED_FIELD')` (409). Moving any host
  **into** a synced destination cluster is likewise refused (reuses
  `assertHostCreatableUnderCluster`) — vCenter owns a synced cluster's host membership.
- **Tenant isolation**: host and destination cluster are both looked up with `tenantId` scoping; a
  cross-tenant id 404s.
- **Misuse — retroactive rewrite**: prevented by the interval model; a move never edits or deletes an
  existing interval's `effective_from`, only closes the open one and appends a new one.
- **Misuse — degenerate/overlapping intervals**: `moveDate` must be strictly after the current
  open membership's `effective_from` (→ `INVALID_MOVE_DATE`, 422); same-cluster move is refused
  (`HOST_ALREADY_IN_CLUSTER`, 422).
- **Misuse — sub-month move granularity**: `moveDate` is constrained by the contract
  (`hostMoveInputSchema`) to the **first of a month** (UTC). The forecast resolves membership at
  first-of-month granularity, so a mid-month date is silently coarse — and two moves in the _same
  calendar month_ (A→B→C) would strand the intermediate cluster at capacity 0 for **every** month.
  First-of-month + the `moveDate > effective_from` guard together force every interval to span at
  least one full month, so no cluster is ever stranded.

## 4. Invariants (enforced + tested)

1. A host has **exactly one** open membership (`effective_to IS NULL`) at any time.
2. Memberships for a host are **contiguous and non-overlapping**: a move sets the open row's
   `effective_to = moveDate` and inserts a new open row with `effective_from = moveDate` (the closed
   interval's end equals the next interval's start).
3. `Host.clusterId` == the open membership's `clusterId`.
4. Month **M** (first-of-month, UTC) attributes a host's capacity to the cluster whose interval
   contains M, using `[effective_from, effective_to)` half-open semantics (`from <= M < to`,
   or `to IS NULL`). This mirrors the existing `commissionedAt`/decommission month gating in
   `effectiveCapacityAt`.
5. Backfilled/pre-feature hosts get a single open membership from their `commissioned_at`, so current
   forecasts are byte-for-byte unchanged at migration time.

## 5. Forecast-engine change (the high-risk core)

- `forecast.ts`: `ForecastHost` gains an **optional** `membershipIntervals?: {from, to|null}[]`.
  `effectiveCapacityAt` returns 0 for a month not covered by any interval (in addition to the
  existing commissioned/decommissioned gating). **`undefined` = no time-scoping (always attributed)**
  — the pure function is unchanged for every existing caller/unit test that omits the field, so the
  characterization snapshot still means something.
- `forecast-loader.ts`: the projecting forecast now loads hosts via `HostClusterMembership` rows
  `WHERE clusterId = C` (not `cluster.hosts` by current `clusterId`), so a host that **moved away**
  still contributes to C for its pre-move months, and a host that **moved in** does not contribute to
  C for pre-move months. Each `ForecastHost` carries its C-intervals.
- `clusters.ts` (cluster panel/list current-month capacity) is **unchanged**: it computes only the
  current month from `cluster.hosts` (current `clusterId`), and by Invariant 3 the current cluster ==
  the open membership, so the present-month number is already correct. Only the multi-month
  _projecting_ forecast needs time-scoping.

## 6. Membership maintenance (all write paths)

- **Migration backfill**: one open membership per existing host at its `commissioned_at`. A count
  guard fails the migration (rolls back, server refuses to boot) if it did not produce exactly one row
  per host — the same fail-closed pattern the baseline-history backfill uses.
- **Reference-data seed** (`prisma/seed.ts` → `seedReferenceData`, the `pnpm seed` /
  `SEED_ON_BOOT=true` first-boot path): every seeded host gets one open membership at its
  `commissionedAt`. The loader builds its host list EXCLUSIVELY from the membership timeline, so a
  seeded host without one is **absent** from every forecast (`hosts: []`). These reference hosts carry
  no `HostMetricCapacity` rows, so the visible effect is forecast **visibility** — the host
  reappearing with its `projectedDecommissionAt` EOL-cliff marker — not capacity attribution.
  Find-or-create keeps the seed idempotent and heals hosts seeded before #289. Crucially, a reseed
  **preserves an operator's move**: it does not reset `Host.clusterId` when the open membership points
  at a different cluster (`entrypoint.ts` reseeds on every boot while `SEED_ON_BOOT=true`), so it can
  never desync the pointer from the open membership (Invariant 3). A regression test drives the real
  seed function through a seed → move → reseed sequence.
- **`HostsService.create`** (manual): host + open membership at `commissionedAt`, in one transaction.
- **`HostsService.move`** (new, manual): Serializable tx — reject synced host / synced destination /
  same cluster / bad date; close the open membership at `moveDate`; open a new one; update
  `Host.clusterId`.
- **`VsphereSyncService.reconcileHosts`** (synced): a single idempotent `reconcileMembership` helper,
  called for every reconciled host — creates the open membership on first import, no-ops when the
  cluster is unchanged, and closes+opens when vCenter moved the host between clusters. The synced move
  date is the current month start clamped to be ≥ the open interval's start (never retroactive, never
  a `to < from` interval). The close+open pair runs in a single `$transaction`, so a mid-pass crash
  cannot strand the host with **zero** open memberships — otherwise the next sync's `!open` branch
  would seed a fresh `[commissioned_at, null)` interval in the destination that OVERLAPS the closed
  source interval, retroactively re-attributing pre-move months to the destination.
- **`realignEarliestMembership`** (on a `commissionedAt` correction, `update`/`confirmCommissioning`):
  moves the earliest interval's `effective_from` to the corrected date, but **refuses** a correction
  that would land on/after that interval's `effective_to` when it is closed (the host later moved),
  which would invert it (`from >= to`). The capacity-row guard alone does not catch this because a
  first capacity row may legitimately postdate `commissionedAt`.
- **Test factory `makeHost`**: creates the open membership too (the test-time equivalent of the
  backfill), so every existing forecast test keeps identical attribution.

## 7. Failure / recovery & rollback

- The move is a single Serializable transaction — it either fully applies (close + open + pointer) or
  not at all. No partial state.
- A host with a missing/legacy membership (should not occur post-backfill) is handled defensively:
  `move` still opens a new interval; the loader simply attributes nothing for uncovered months
  (errs _low_ on capacity ⇒ higher utilization ⇒ buy earlier ⇒ safe direction).
- **Rollback**: revert the app image (`LCM_IMAGE_TAG`). The old code ignores
  `host_cluster_memberships` entirely and reads `Host.clusterId`, which the new code kept accurate, so
  forecasts are correct on the old code too. The table can be left in place (inert) or dropped by a
  later contract migration; nothing else references it. No data is destroyed by rollback.
- The migration is **additive** (new table + backfill); it drops/rewrites nothing.

## 8. Security & privacy impact

No new sensitive data: `host_cluster_memberships` holds ids and dates only — no secrets, no PII, no
credentials. No new external calls, no new network exposure. No logging of secrets. RBAC unchanged
(ADMIN-gated by method). ASVS L1 posture unchanged.

## 9. Verification

Integration tests (Testcontainers) in `apps/server/src/__tests__/host-move.test.ts`:

- a move splits attribution at the move date across the two clusters;
- months **before** the move are byte-identical for **both** clusters before vs. after the move;
- a synced-host move → `SYNC_OWNED_FIELD` (409); move into a synced destination → `SYNC_OWNED_FIELD`;
- VIEWER → 403 on the route; same-cluster → 422; bad move date → 422; unknown host/cluster → 404;
- the "exactly one open, contiguous, non-overlapping" invariant on the resulting rows.

Plus a synced host moved between clusters in vCenter closes/opens its membership
(`vsphere-sync.test.ts`). Existing forecast + sync forecast suites act as the characterization guard
(they must stay green, proving current forecasts are unchanged).
