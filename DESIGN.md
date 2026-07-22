# DESIGN.md — #292 Order approval / acknowledgment (with note)

_Owner decision: per-breach-event approval (recorded 2026-07-22). This doc resolves the review's open questions and specifies the model before coding. HIGH-risk (Prisma migration + `@lcm/shared` contract + forecast/purchasing surface)._

## 1. Problem & intent

The fleet console surfaces a per-cluster procurement recommendation ("ORDER NOW" / "Order by …") derived from the forecast. Today it is purely computed and stateless — there is no way for an admin to say "seen it, here's our plan" and have that stick. Owner's requirement, verbatim:

> "When I approve it for now, then we increase system capacity in 12 weeks, then in 40 weeks we are again over the limit — the second event should show again. I want an approval for **each event where it goes over the limit**."

So an approval acknowledges **one specific over-limit episode**. Approving suppresses the current recommendation's "unacknowledged" state; after the operator adds capacity and a **new** episode emerges, that new episode must surface un-acknowledged and need its own approval.

## 2. The load-bearing constraint: breaches have no durable identity

`apps/server/src/services/procurement.ts` `computeProcurementInfo()` finds the breach as _the first forecast month with `capacity > 0 && utilization !== null && utilization >= warnFraction`_ and derives `orderByDate = firstOfMonth(breachMonth) − leadTimeWeeks·7d`. Facts that constrain the design:

- **Recomputed every request, persisted nowhere.** There is no breach row, no `breachId`. `breachMonth` is just a month string.
- **`breachMonth` drifts by design.** `forecast-loader.ts` re-anchors on the newest baseline _unconditionally_ every recompute ("advancing anchor is the error-correction mechanism"). So the same underlying problem's `breachMonth` moves month-to-month even with no operator action.
- **WARN-only.** The breach uses `warnFraction` only; `critThreshold` is not consumed by the order-by path. The WARN/CRIT "ORDER NOW vs PLANNED" urgency split is computed **live on the frontend** in `apps/web/src/lib/procurement-kpi.ts` from `orderByDate` vs `today` (`days < 0` ⇒ overdue/crit, `days ≤ 28` ⇒ urgent/warn).

**Consequence:** keying an approval on `breachMonth` equality is fragile — natural drift would spuriously un-acknowledge. We must snapshot the breach context at approval time and define episode identity by **what the operator controls**, not by the drifting month.

## 3. Core model — approval per "capacity generation"

An approval is an **immutable, append-only snapshot** taken at approval time. A cluster's _current_ breach counts as **acknowledged** iff the latest approval's operator-controlled inputs still match the live forecast; it is **superseded** (re-surfaces, needs a fresh approval) when those inputs change.

**Supersede trigger = a change to operator-controlled procurement inputs since the latest approval, specifically (amended by §11 below):**

- the cluster's **capacity configuration** changed (host added / commissioned / decommissioned / replaced with different capacity, or a capacity-changing event), OR
- the cluster's **warn threshold** changed, OR
- **the breach has materially worsened on its own:** the live `orderByDate` is **earlier than the approved `orderByDate` by ≥ tolerance `T`**.

Natural baseline/consumption drift that only shifts `breachMonth` by < `T` does **not** supersede — so no false re-acknowledgment churn. This maps the owner's example exactly: approve Sep breach → add hosts (capacity changes) → the week-40 breach is a new generation → surfaces un-acknowledged.

### Capacity signature

Snapshot a scalar **`capacitySignature`** = sum of nameplate capacity across the cluster's active (non-decommissioned) hosts at approval time. The forecast loader already loads these; exposing a cluster nameplate total is trivial. Any capacity change moves the number; a true like-for-like host swap (identical capacity) leaves it unchanged — which is correct, because the breach doesn't move either.

### Window divergence (write path vs. read path) — fails safe, deliberately not aligned

The forecast is evaluated over a `[from, to]` window. The **write path** (`ForecastService.liveBreachContext`, invoked by `OrderApprovalService.create`) uses the **server default, baseline-anchored** window (`from = firstOfMonth(newest baseline)`). The **read path** the chip renders uses whatever window the web client requests, which for the 12/24-mo views is **today-anchored** (`resolveWindow` in `window-controls.tsx`: `from = firstOfMonth(today)`). Under a **stale baseline anchor** (anchor several months in the past) these windows diverge.

This divergence is **left in place on purpose because it fails safe**, and the reviewer's flagged 422 is the price:

- The baseline-anchored write window starts **no later than** any chip window, so the snapshotted `orderByDate` is **never later** than the live one. The `≥ T` worsening rule (INV-5) supersedes only when the live `orderByDate` is _earlier_ than the approved one — so with a write window that starts earliest, a genuine worsening reads as "improving/unchanged" and the approval can only **linger**, never **falsely vanish**, on _any_ view. Live chip urgency (`orderByDate` vs `today`) still escalates independently, so a lingering acknowledgment can never hide a now-urgent order.
- **Rejected alternative — align the write window to `today`:** it would remove the 422 on the default 24-mo view, but the **`all` view** (whose `from` is the baseline, i.e. earlier than `today`) would then compute a live `orderByDate` _earlier_ than a today-anchored snapshot, tripping the `≥ T` rule and making the acknowledgment **disappear when the operator merely switches to the `all` window** — a worse, view-dependent regression on the purchasing surface. Anchoring the write window earliest is the more robust choice.
- **One visible-but-safe symptom:** a `422 NO_LIVE_BREACH` on Approve for a breach that sits past the write window's `to` (`anchor + horizon`) yet within the chip's `to` (`today + horizon`) — only reachable when the anchor is stale by more than one month _and_ the breach is >24 months out. The chip shows the breach; Approve reports "no live breach". Confusing, but it can never mis-record or mask an order.

The `liveBreachContext` doc comment states this accurately (it previously, wrongly, claimed "exactly what the chip shows"). A future change MAY align the windows by passing the displayed `from`/`to` into the approve request, but that widens the contract (client-controlled snapshot window) and must preserve the "never falsely supersede" property above.

## 4. Data model

New Prisma model (mirrors the `HostReplacement` entity pattern):

```prisma
model OrderApproval {
  id                String   @id @default(cuid())
  tenantId          String   @default("default") @map("tenant_id")
  clusterId         String   @map("cluster_id")
  // Snapshot of the acknowledged episode (immutable):
  breachMonth       DateTime @map("breach_month") @db.Date
  orderByDate       DateTime @map("order_by_date") @db.Date
  leadTimeWeeks     Int      @map("lead_time_weeks")
  warnThreshold     Float    @map("warn_threshold")
  capacitySignature Float    @map("capacity_signature")
  metricTypeId      String?  @map("metric_type_id")        // which metric this breach was for (snapshot id, no FK) — see addendum item 3
  // Audit:
  approvedByUserId  String?  @map("approved_by_user_id")   // nullable — see §7 disabled-mode
  approvedByLabel   String   @map("approved_by_label")      // username or "anonymous (auth disabled)"
  note              String?
  createdAt         DateTime @default(now()) @map("created_at")

  cluster Cluster @relation(fields: [clusterId], references: [id], onDelete: Cascade)
  tenant  Tenant  @relation(fields: [tenantId], references: [id])

  @@index([clusterId, createdAt])
  @@map("order_approvals")
}
```

Append-only: one row per approval action; the **latest** row per cluster is authoritative for coverage; older rows are the audit trail (satisfies "an approval for each event"). Migration `add_order_approvals` via `prisma migrate dev`.

## 5. API & contract (`@lcm/shared`)

- **`POST /api/clusters/:id/order-approvals`** `{ note?: string (≤2000) }` — ADMIN-gated automatically (`requiresAdmin` gates every mutating `/api` route by construction). Server computes the live breach for the cluster; **422 if there is no current breach** (nothing to approve). Otherwise inserts a snapshot row and returns it (201).
- **Read path — embed, don't add a fetch.** Extend the forecast response with an optional, additive:
  ```ts
  acknowledgment: { note: string | null; approvedByLabel: string; approvedAt: string } | null
  ```
  computed server-side by the §3 coverage rule (latest approval vs live breach). `null` when unacknowledged or no breach. The `RecommendationChip` reads it directly — no new client query, no extra round-trip. New Zod input schema `orderApprovalCreateInputSchema` + inferred type; response shapes stay plain interfaces per repo convention. This is an **additive** contract change (backward-compatible).

## 6. UI

`RecommendationChip` / detail: when `acknowledgment !== null`, render an "Acknowledged" affordance next to the chip showing the note + `approvedByLabel` + relative date; the chip's live urgency (ORDER NOW / overdue) still updates from `orderByDate` (acknowledgment annotates, it does not mute urgency). When `null` and a breach exists, show an admin-only "Approve / add note" action. Follow Mission Bento tokens; color is never the only signal (icon + text). VIEWERs see the acknowledgment read-only, no approve action.

## 7. Invariants

- **INV-1 (annotation-only):** approvals never feed back into the forecast computation — no effect on capacity, consumption, or `breachMonth`. Forecast correctness (the purchasing driver) is untouched. _This is the primary high-risk guardrail._
- **INV-2 (coverage):** a live breach is acknowledged iff the latest approval's `capacitySignature` **and** `warnThreshold` equal the live values and a live breach exists; any change supersedes.
- **INV-3 (no-breach ⇒ no UI):** if the live forecast has no breach (`orderByDate === null`), no acknowledgment shows regardless of history.
- **INV-4 (immutable snapshot):** approval rows are append-only; never updated. History is the audit trail.
- **INV-5 (drift-stable, amended §11):** anchor-advance / baseline drift that moves the breach **later, or earlier by < `T`,** does not supersede. Drift that moves it **earlier by ≥ `T`** supersedes (a genuine worsening).

## 8. Threat model / misuse

- **Stale approval masking a real new order (the reviewer's flagged risk):** prevented on two fronts — supersede-on-capacity/threshold-change (INV-2) means a post-expansion breach is never auto-acknowledged, and live urgency escalation (a passing `orderByDate` flips the chip to "overdue" even while acknowledged) means an acknowledgment can never hide a now-urgent order.
- **Privilege:** VIEWER cannot approve (auto ADMIN-gated); assert VIEWER→403 in tests.
- **XSS via note:** free text, `≤2000`, React-escaped, never `dangerouslySetInnerHTML`. Validate in the handler.
- **Disabled-auth mode:** the anonymous principal is ADMIN but has no `users` row, so `approvedByUserId` is **nullable** and `approvedByLabel` carries the audit string; no hard FK dependency that would break disabled deployments.

## 9. Failure / recovery

Append-only table; deleting an approval row simply drops an acknowledgment (the breach re-surfaces) — non-destructive, no data-safety migration concern. No backup gate required beyond the standard migration review.

## 10. Verification

Server integration (Testcontainers): approve a breach → forecast response `acknowledgment` populated; add a host (capacity changes) → recompute → `acknowledgment` back to `null` (superseded, INV-2); introduce baseline drift that shifts `breachMonth` **without** capacity change and < `T` → still acknowledged (INV-5); breach moves earlier by **≥ T** → superseded; breach moves **later** → still acknowledged; change warn threshold → superseded; no current breach → POST 422; VIEWER POST → 403; disabled-mode approval stores label with null user id. Web unit: `RecommendationChip` acknowledged vs unacknowledged rendering, note + who/when, urgency still escalates when acknowledged.

## 11. Residual decision — RESOLVED (2026-07-22): "force re-approval when worse"

Owner chose the stronger option: a live breach's latest approval is **superseded** when **any** of (1) capacity signature changed, (2) warn threshold changed, or (3) **the breach worsened on its own** — the live `orderByDate` is **earlier than the approved `orderByDate` by ≥ a tolerance `T`**. (The boundary is `≥ T`, matching §3, INV-5, and the code + tests, which use `daysEarlier >= T`; the exact `T`-day boundary supersedes.)

- **Default `T = 31 days`** (≈ one month), a named constant — the live `orderByDate` must move **≥ ~1 month earlier** than the approved date to force re-approval.
- Only the **earlier** direction supersedes. A breach moving **later** (improving) never supersedes.
- `T` absorbs single-step month-granular anchor wobble while still catching real acceleration. Candidate for a `TenantSettings` field later; not required for v1.

---

## Implementation notes (addendum — decisions the design left implicit)

These clarify points the spec above did not pin down. None change the model; they record the concrete choices made so the PR is auditable.

1. **Primary metric selection (write path).** The `POST` body carries only `note`, so the server must pick which metric's breach to snapshot. It uses the cluster's **primary metric = the alphabetically-first tracked metric key**, which is exactly `ClusterResponse.metrics[0]` (`clusters.ts` orders newest baselines by `metricType.key: 'asc'`) — i.e. the metric the `RecommendationChip` already renders. v1 clusters track a single memory metric, so this is unambiguous in practice. 404 if the cluster is absent; 422 (`NO_LIVE_BREACH`) if it tracks no metric or projects no warn breach.

2. **`capacitySignature` exact formula** (`services/order-approval-coverage.ts` `computeCapacitySignature`). Σ over hosts where `decommissionedAt IS NULL` of each host's **latest** capacity row (max `effectiveFrom`) for the metric. Setting a decommission date (even a future one) excludes the host — a deliberate change-detector, not a point-in-time capacity. A like-for-like swap (old decommissioned + new of identical capacity) leaves the sum unchanged, matching §3.

3. **Coverage evaluated per requested metric (read path); `metricTypeId` snapshotted, not yet matched on.** The `acknowledgment` embedded in a forecast response is computed against the live `capacitySignature`/`warnThreshold`/`orderByDate` **for the metric being requested**. `OrderApproval` now **stores** a nullable `metricTypeId` — the cluster's primary metric at approval time (`OrderApprovalService.primaryMetric`) — captured **now, while the migration is unmerged**, so a later multi-metric world does not need a second migration + backfill on this purchasing-critical table (owner decision, 2026-07-22). **v1 coverage does NOT filter on it:** `resolveAcknowledgmentFor` still selects the latest approval per cluster regardless of metric, matching today's single-metric reality (the seed tracks only `memory_gb`, and every forecast consumer reads `metrics[0]`). So an approval taken for one metric would still only ever "cover" a different metric if their capacity sums coincided exactly — harmless (annotation-only, INV-1) and, with a single metric, unreachable. **Future follow-up (multi-metric coverage matching):** when a cluster tracks more than one metric, scope the coverage read by `metricTypeId` (store the requested metric's id on the read path and add `where: { metricTypeId }` to the latest-approval query) so each metric's breach carries its own acknowledgment. Tracked for when multi-metric lands; not implemented in v1.

4. **Float comparisons.** `capacitySignature` (double) compared with epsilon `1e-6`; `warnThreshold` (double, from `Decimal(4,3)`) with `1e-9`. Prevents float-noise false-supersede.

5. **Scenarios never carry an acknowledgment.** `forClusterWithScenario` returns `acknowledgment: null` — a what-if is not an approved order (INV-1), and coverage must never be evaluated against scenario-mutated capacity/order-by values. The UI also suppresses the approve action while a scenario is active.

6. **Rollback / containment.** Fully additive and reversible. To disable at the API level, drop the route registration in `server.ts`; the additive `acknowledgment` field then always reports `null` and the chip reverts to today's behavior. The `order_approvals` table is annotation-only (INV-1), so dropping rows or the table never affects the forecast, and the migration is a pure `CREATE TABLE` with no data backfill.
