# Server lifecycle tracking — v1 design

**Date:** 2026-05-25
**Status:** Draft for review
**Scope:** Track the lifecycle (purchase → in-service → degraded → decommissioned → disposed) and replacement of physical hardware servers ("hosts") so warranty/EOL becomes a first-class signal in the existing capacity forecast.

## 1. Goal

Surface upcoming hardware End-of-Life as a capacity-cliff in the cluster forecast that this app already produces. Today the forecast only knows that a host stops contributing capacity when `decommissionedAt` is set. After this change, an unreplaced EOL date projects forward into the forecast and becomes visible as a planned drop — turning hardware obsolescence into a budget signal months before it hits.

Non-goals for v1 are listed in §10.

## 2. Background

The app (`lifecycle-management`) is an internal capacity planner for a small vSphere infrastructure team. The data model already includes:

- `Cluster` — a vSphere cluster, with baselines and an event log.
- `Host` — a physical server providing capacity to a cluster, with `commissionedAt` and `decommissionedAt` dates and a per-host `HostMetricCapacity` time series.
- `Event(category=hardware_change)` — un-attributed capacity deltas at the cluster level.

What's missing: any record of the host as a piece of hardware (vendor, serial, warranty, EOL) and any lifecycle state beyond "decommissioned yes/no." The forecast can't warn about EOL because EOL doesn't exist in the model.

## 3. Approach

Three concerns kept separate:

1. **Asset attributes** — new optional columns on `Host` (serial, vendor, model, purchase date, warranty end, EOL, "run past EOL" override). Pure data.
2. **Lifecycle state machine** — a `state` column on `Host` plus an append-only `HostLifecycleEvent` audit log. A single `HostLifecycleService` is the only writer for both; nothing else mutates `state`.
3. **Forecast projector** — the existing forecast function gains one rule: a host with a future `eolAt`, no successor scheduled by that date, and `runPastEol = false` is projected to drop out of capacity at `eolAt`.

Replacements are tracked separately in a `HostReplacement` join table that allows many-to-many (consolidation: 2 old → 1 new; split: 1 old → 2 new).

### Why a snapshot column over event-sourced state

State could in principle be computed from `HostLifecycleEvent` rows ("latest event's `toState`"). Rejected because the forecast read path is hot and runs `WHERE state IN (in_service, degraded)` constantly; a single column with an index is cheap, and drift is bounded because the transition service owns both writes in one transaction. The event log gives full audit; the column gives fast reads.

## 4. Data model

Additions to `apps/api/prisma/schema.prisma`. Existing fields preserved.

```prisma
enum HostState {
  ordered
  racked
  in_service
  degraded
  decommissioned
  disposed

  @@map("host_state")
}

model Host {
  // ----- existing -----
  id               String    @id @default(cuid())
  tenantId         String    @default("default") @map("tenant_id")
  clusterId        String    @map("cluster_id")
  name             String
  description      String?
  commissionedAt   DateTime  @map("commissioned_at") @db.Date     // cached from lifecycle events
  decommissionedAt DateTime? @map("decommissioned_at") @db.Date   // cached from lifecycle events
  createdAt        DateTime  @default(now()) @map("created_at")
  updatedAt        DateTime  @updatedAt @map("updated_at")

  // ----- NEW: asset attributes -----
  serialNumber     String?   @map("serial_number")
  vendor           String?
  model            String?
  purchasedAt      DateTime? @map("purchased_at") @db.Date
  warrantyEndsAt   DateTime? @map("warranty_ends_at") @db.Date
  eolAt            DateTime? @map("eol_at") @db.Date
  runPastEol       Boolean   @default(false) @map("run_past_eol")

  // ----- NEW: state -----
  state            HostState @default(in_service)

  // ----- existing relations -----
  tenant     Tenant               @relation(fields: [tenantId], references: [id])
  cluster    Cluster              @relation(fields: [clusterId], references: [id], onDelete: Cascade)
  capacities HostMetricCapacity[]

  // ----- NEW relations -----
  lifecycleEvents HostLifecycleEvent[]
  replacedByLinks HostReplacement[]    @relation("old")
  replacesLinks   HostReplacement[]    @relation("new")

  @@unique([tenantId, serialNumber], map: "hosts_tenant_serial_unique")
  @@index([clusterId])
  @@index([state])
  @@index([eolAt])
  @@map("hosts")
}

model HostLifecycleEvent {
  id         String     @id @default(cuid())
  tenantId   String     @default("default") @map("tenant_id")
  hostId     String     @map("host_id")
  fromState  HostState? @map("from_state")   // null only for the initial backfill / seed event
  toState    HostState  @map("to_state")
  occurredAt DateTime   @map("occurred_at") @db.Date
  note       String?
  createdAt  DateTime   @default(now()) @map("created_at")

  host   Host   @relation(fields: [hostId], references: [id], onDelete: Cascade)
  tenant Tenant @relation(fields: [tenantId], references: [id])

  @@index([hostId, occurredAt])
  @@map("host_lifecycle_events")
}

model HostReplacement {
  id        String   @id @default(cuid())
  tenantId  String   @default("default") @map("tenant_id")
  oldHostId String   @map("old_host_id")
  newHostId String   @map("new_host_id")
  swappedAt DateTime @map("swapped_at") @db.Date
  reason    String?
  createdAt DateTime @default(now()) @map("created_at")

  old    Host   @relation("old", fields: [oldHostId], references: [id], onDelete: Cascade)
  new    Host   @relation("new", fields: [newHostId], references: [id], onDelete: Cascade)
  tenant Tenant @relation(fields: [tenantId], references: [id])

  @@unique([oldHostId, newHostId])
  @@index([swappedAt])
  @@map("host_replacements")
}
```

Notes:
- `serialNumber` unique per tenant; nullable so the migration doesn't force backfill.
- `state` indexed because the forecast filter is `state IN (in_service, degraded)`.
- `eolAt` indexed for the "expiring soon" query and forecast projection.
- M:N replacements via `HostReplacement`; consolidation and splits are expressed as multiple rows.

## 5. State machine

Allowed transitions:

```
ordered          ──▶ racked
racked           ──▶ in_service
in_service       ──▶ degraded
in_service       ──▶ decommissioned
degraded         ──▶ in_service
degraded         ──▶ decommissioned
decommissioned   ──▶ disposed
```

Deliberately disallowed:
- `ordered → in_service` (no shortcut; physical install must be recorded).
- `decommissioned → in_service` (re-entering service forces a new Host record so the audit trail stays honest).
- Any transition out of `disposed` (terminal).

### Transition service (single writer)

`apps/api/src/services/host-lifecycle.ts`:

```ts
const ALLOWED: Record<HostState, HostState[]> = {
  ordered:        ['racked'],
  racked:         ['in_service'],
  in_service:     ['degraded', 'decommissioned'],
  degraded:       ['in_service', 'decommissioned'],
  decommissioned: ['disposed'],
  disposed:       [],
};

async function transition({ hostId, toState, occurredAt, note }) {
  return prisma.$transaction(async (tx) => {
    const host = await tx.host.findUniqueOrThrow({ where: { id: hostId } });
    if (!ALLOWED[host.state].includes(toState)) {
      throw new BadTransition(host.state, toState);
    }
    await tx.hostLifecycleEvent.create({
      data: { hostId, fromState: host.state, toState, occurredAt, note },
    });
    const patch: Partial<Host> = { state: toState };
    if (toState === 'in_service' && host.commissionedAt > occurredAt) {
      patch.commissionedAt = occurredAt;
    }
    if (toState === 'decommissioned') {
      patch.decommissionedAt = occurredAt;
    }
    await tx.host.update({ where: { id: hostId }, data: patch });
  });
}
```

The cached `commissionedAt` / `decommissionedAt` columns on `Host` stay correct because the service is their only writer. Routes never set `state` directly.

## 6. Forecast projector

The forecast in `apps/api` is a pure function over baselines, hosts, applications, events. Today it considers a host as contributing capacity when `t >= commissionedAt && (decommissionedAt == null || t < decommissionedAt)`. We extend the host capacity timeline with one new rule.

A host has a **projected decommission date** `d*` when all of:
- `state IN (in_service, degraded)`
- `eolAt` is set and in the future
- `runPastEol = false`
- No `HostReplacement` row where this is the old host AND the new host's `commissionedAt <= eolAt`

```ts
function projectedDecommissionDate(host: Host, replacements: HostReplacement[]): Date | null {
  if (!host.eolAt || host.runPastEol) return null;
  if (!['in_service', 'degraded'].includes(host.state)) return null;
  const covered = replacements.some(r =>
    r.oldHostId === host.id &&
    r.new.commissionedAt <= host.eolAt!
  );
  return covered ? null : host.eolAt;
}

// In the forecast loop, when summing host capacity at date `t`:
const effectiveDecom = host.decommissionedAt ?? projectedDecommissionDate(host, replacements);
const isContributing = t >= host.commissionedAt && (!effectiveDecom || t < effectiveDecom);
```

The forecast response gains one optional field per host: `projectedDecommissionAt`. Real `decommissionedAt` always wins if both are set.

Edge cases:
- `warrantyEndsAt` does NOT affect the curve — only alerts/badges in the UI. Warranty expiry is a support concern, not a capacity event.
- `degraded` without `eolAt` produces no projection. `degraded` is a status flag, not a forecast.
- Replacement coverage uses the new host's `commissionedAt`, not its `state`. An `ordered` or `racked` replacement scheduled before `eolAt` is enough to call the old host "covered." This means a future-dated replacement suppresses the projected cliff as soon as the `HostReplacement` row is created — users get to see the forecast settle the moment they plan the swap, not after the box arrives.

## 7. API surface

Routes under `/api`, validated by Zod schemas in `packages/shared/src/schemas`. Implementations land in `apps/api/src/routes/hosts.ts` and a new `apps/api/src/routes/host-replacements.ts`.

```
GET    /api/clusters/:cid/hosts                       # existing — response gains new fields
POST   /api/clusters/:cid/hosts                       # existing — accepts new optional asset attrs
PATCH  /api/clusters/:cid/hosts/:hid                  # existing — can update asset attrs + runPastEol
                                                      # cannot update `state` directly

POST   /api/clusters/:cid/hosts/:hid/transitions      # body: { toState, occurredAt, note? }
GET    /api/clusters/:cid/hosts/:hid/lifecycle        # full event history for the side panel

POST   /api/host-replacements                         # body: { oldHostId, newHostId, swappedAt, reason? }
DELETE /api/host-replacements/:id                     # fix-ups only; hard-delete the row

GET    /api/clusters/:cid/forecast                    # existing — response per-host gains:
                                                      #   projectedDecommissionAt?: Date
```

Route-layer invariants:
- `state` is read-only on PATCH; any attempt returns 400 with `"use POST .../transitions"`.
- `HostReplacement` requires both hosts to share `tenantId` and `clusterId`, else 422.
- Transition with a disallowed edge returns 422 with both `fromState` and `toState` in the body.

## 8. UI placement

Three touch points in `apps/web`, no new top-level route.

### 8a. Cluster detail (`apps/web/src/routes/clusters.$id.tsx`)

The hosts table already exists on this page; add four columns and an actions menu:

```
┌──────────┬────────┬────────────┬────────────┬─────────┬────────────┬─────────┐
│ Host     │ State  │ Warranty   │ EOL        │ Comm.   │ Decomm.    │ Actions │
├──────────┼────────┼────────────┼────────────┼─────────┼────────────┼─────────┤
│ esx-01   │ ●in_svc│ 2027-04-12 │ 2028-10-01 │ 2024-01 │ —          │ ⋯       │
│ esx-02   │ ●degr  │ 2025-11-30 │ 2026-08-15⚠│ 2023-06 │ —          │ ⋯       │
│ esx-03   │ ◌decom │ —          │ —          │ 2021-04 │ 2025-12-15 │ ⋯       │
└──────────┴────────┴────────────┴────────────┴─────────┴────────────┴─────────┘
                                  ▲ "expires in 83 days" pill from current date
```

State badge colors (existing Tailwind tokens):
- `in_service` → emerald
- `degraded` → amber
- `decommissioned` → zinc
- `ordered` / `racked` → blue
- `disposed` → neutral

EOL within 180 days renders a `⚠` and a tooltip with days remaining.

Actions menu items: **Edit**, **Transition…**, **Replace…**, **View history**. Transition list is filtered to allowed edges from the current state.

### 8b. Host edit drawer

Reuse the existing host form pattern. Add an "Asset" section with: serial, vendor, model, purchased, warranty end, EOL, "run past EOL" toggle. Drawer instead of modal so the cluster page stays visible.

### 8c. Forecast chart cliff annotation

The forecast chart (Recharts) already renders the capacity line. When the API response includes any `projectedDecommissionAt`, render a dashed vertical reference line at the earliest such date with a label `EOL: <host-name>`. Hover reveals all contributing hosts at that date. This annotation is the primary user-visible payoff of the feature.

### 8d. Transition modal

Compact form: target state (constrained to allowed edges from current state), `occurredAt` date (defaults to today), optional note. Submits to `POST /api/clusters/:cid/hosts/:hid/transitions`.

### 8e. Replace flow

Two entry points to the same `HostReplacement` row:
- From a `decommissioned` host's actions menu: **Replace with…** — picks an existing host (same cluster, not already a target).
- Inside the Transition modal when transitioning to `decommissioned`: optional **Replaced by** picker that creates the replacement alongside the transition.

### 8f. History view

A side panel triggered from **View history**. Time-ordered list of `HostLifecycleEvent` rows: `from → to`, date, note. No fancy timeline graphic in v1.

## 9. Migration & backfill

One Prisma migration. Backfill is idempotent.

```sql
CREATE TYPE host_state AS ENUM
  ('ordered','racked','in_service','degraded','decommissioned','disposed');

ALTER TABLE hosts
  ADD COLUMN serial_number    text,
  ADD COLUMN vendor           text,
  ADD COLUMN model            text,
  ADD COLUMN purchased_at     date,
  ADD COLUMN warranty_ends_at date,
  ADD COLUMN eol_at           date,
  ADD COLUMN run_past_eol     boolean NOT NULL DEFAULT false,
  ADD COLUMN state            host_state NOT NULL DEFAULT 'in_service';

CREATE UNIQUE INDEX hosts_tenant_serial_unique
  ON hosts (tenant_id, serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX hosts_state_idx ON hosts (state);
CREATE INDEX hosts_eol_at_idx ON hosts (eol_at);

-- Backfill state from existing date columns
UPDATE hosts
SET state = CASE
  WHEN decommissioned_at IS NOT NULL AND decommissioned_at <= CURRENT_DATE
    THEN 'decommissioned'::host_state
  ELSE 'in_service'::host_state
END;

-- Tables host_lifecycle_events and host_replacements are created by
-- Prisma from the schema in §4; their DDL is omitted here for brevity.

-- Seed lifecycle history so audit log is non-empty for existing hosts
INSERT INTO host_lifecycle_events (id, tenant_id, host_id, from_state, to_state, occurred_at, note)
SELECT 'seed_'       || id, tenant_id, id, NULL, 'in_service'::host_state,
       commissioned_at, 'Backfilled from commissioned_at'
FROM hosts;

INSERT INTO host_lifecycle_events (id, tenant_id, host_id, from_state, to_state, occurred_at, note)
SELECT 'seed_decom_' || id, tenant_id, id, 'in_service'::host_state, 'decommissioned'::host_state,
       decommissioned_at, 'Backfilled from decommissioned_at'
FROM hosts WHERE decommissioned_at IS NOT NULL;
```

Asset attributes stay null on existing rows. The hosts table shows an unobtrusive "Asset info missing" hint when serial is null; nothing breaks and forecast behavior is unchanged until users start filling in `eolAt`.

`apps/api/prisma/seed.ts` is updated so the four reference clusters' hosts get plausible sample asset records + EOL dates — useful for dev and screenshots.

## 10. Out of scope (v1)

Pinned here to prevent scope creep:

- Vendor warranty / EOL API integrations (Dell TechDirect, HPE GreenLake, Lenovo XClarity). Future spec.
- DCIM / NetBox / Nautobot sync. Future spec.
- Redfish / IPMI discovery from BMCs.
- Physical attributes: rack, U-position, location, power, network ports.
- Bulk CSV import — manual entry only in v1; revisit if painful.
- Notifications (email/Slack) for upcoming EOL — UI badges + forecast cliff only.
- Photos, attachments, receipts on assets.
- Role-based permissions on transitions — anyone with tenant access can transition.

## 11. Testing

New test files under the existing vitest setup.

**`apps/api/src/__tests__/host-lifecycle.test.ts`** — unit, transition service:
- Each allowed edge succeeds.
- Each disallowed edge throws `BadTransition`.
- `decommissionedAt` is set on `* → decommissioned`.
- `commissionedAt` is reduced (never increased) on the first `* → in_service`.
- A `HostLifecycleEvent` is always written and rolls back if the host update fails.

**`apps/api/src/__tests__/forecast-projection.test.ts`** — unit, projector:
- Host with `eolAt` in future, no replacement → projected drop at `eolAt`.
- Host with `runPastEol = true` → no projection.
- Host with `state = decommissioned` → no projection.
- Host with a replacement whose `commissionedAt <= eolAt` → projection suppressed.
- Real `decommissionedAt` beats projection if earlier.
- `warrantyEndsAt` alone never affects the curve.

**`apps/api/src/__tests__/routes/hosts.test.ts`** — integration:
- `PATCH /hosts/:id { state: 'degraded' }` → 400.
- `POST /transitions { toState: 'in_service' }` from `ordered` state → 422.
- Replacement across clusters → 422.

**`apps/web/src/__tests__/cluster-hosts-table.test.tsx`** — component:
- State badge color matches state.
- EOL within 180 days renders the ⚠ pill.
- Actions menu shows only allowed transitions for the current state.

No new Playwright tests in v1. The existing cluster-detail e2e gets one extra assertion that the new columns render.

## 12. Rollout

Single deploy, no feature flag:

1. Apply migration; backfill runs in the same transaction.
2. Ship API and web together (monorepo deploy is already atomic).
3. First user-facing change visible: new columns on the hosts table and the Asset section in the edit drawer.
4. Forecast behavior unchanged until users start populating `eolAt`. The cliff annotation only appears when there's data to project.
