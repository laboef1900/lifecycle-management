import type { BaselineHistoryPoint } from '@lcm/shared';
import type { EffectiveThresholds, ProcurementInfo } from '@lcm/shared';

import { formatDate } from '../lib/dates.js';

export interface ForecastCapacityRow {
  effectiveFrom: Date;
  amount: number;
}

export interface ForecastHost {
  id: string;
  name: string;
  commissionedAt: Date;
  decommissionedAt: Date | null;
  projectedDecommissionAt: Date | null;
  capacities: ForecastCapacityRow[];
}

export interface ForecastApplication {
  id: string;
  name: string;
  startedAt: Date;
  endedAt: Date | null;
  allocations: ForecastCapacityRow[];
}

export interface ForecastEvent {
  id: string;
  effectiveDate: Date;
  category: string;
  title: string;
  description: string | null;
  consumptionDelta: number | null;
  capacityDelta: number | null;
}

export interface ForecastInput {
  baselineDate: Date;
  /**
   * The PERIOD the baseline was ACTUALLY MEASURED in, or `null`/omitted when it
   * was never measured at all. This is the ONE input to absorption — see
   * `absorbed`, and note in particular that the baseline's `source` is NOT an
   * input to it and deliberately no longer appears on this interface.
   *
   * Immutable, unlike `baselineDate`, which is an operator-editable label.
   * Derives from `ClusterBaselineHistory.observedAt`, written only by
   * `VsphereSnapshotService` and touched by no edit path.
   *
   * Snapped to the first of the month by every caller: `capturedAt` is a period
   * anchor, so comparing a raw instant against month-aligned delta dates would
   * shift the boundary mid-month.
   */
  baselineMeasuredAt?: Date | null;
  baselineConsumption: number;
  baselineCapacity: number;
  hosts: ForecastHost[];
  applications: ForecastApplication[];
  events: ForecastEvent[];
}

export interface MonthlyPoint {
  month: string;
  consumption: number;
  capacity: number;
  /** null when capacity is 0 — unknowable, not zero. See the shared contract. */
  utilization: number | null;
}

export interface ForecastEventOutput {
  id: string;
  effectiveDate: string;
  category: string;
  title: string;
  description: string | null;
  consumptionDelta: number | null;
  capacityDelta: number | null;
}

export interface ForecastEntityContribution {
  id: string;
  name: string;
  projectedDecommissionAt?: string | null;
  contributions: Array<{ month: string; amount: number }>;
}

export interface ForecastResult {
  /** The measured actuals behind the modelled line, oldest first (#177). */
  baselineHistory: BaselineHistoryPoint[];
  fromMonth: string;
  toMonth: string;
  months: MonthlyPoint[];
  events: ForecastEventOutput[];
  hosts: ForecastEntityContribution[];
  applications: ForecastEntityContribution[];
  effectiveThresholds: EffectiveThresholds;
  procurement: ProcurementInfo;
}

/**
 * What the pure `computeForecast` produces. `baselineHistory` is omitted with the
 * same intent as `effectiveThresholds`/`procurement`: it is assembled by the
 * loader from the database, and the pure function must never learn that history
 * exists. Keeping it ignorant is what lets the characterization snapshot mean
 * something — the forecast maths is then unchanged by #177 by construction rather
 * than by assertion.
 */
export type ComputedForecast = Omit<
  ForecastResult,
  'effectiveThresholds' | 'procurement' | 'baselineHistory'
>;

export function computeForecast(
  input: ForecastInput,
  fromMonth: Date,
  toMonth: Date,
): ComputedForecast {
  if (toMonth < fromMonth) {
    throw new Error('toMonth must be on or after fromMonth');
  }

  const hosts = input.hosts.map((host) => ({
    ...host,
    capacities: [...host.capacities].sort(
      (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
    ),
  }));
  const applications = input.applications.map((app) => ({
    ...app,
    allocations: [...app.allocations].sort(
      (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
    ),
  }));
  const events = [...input.events].sort(
    (a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime(),
  );

  const months: MonthlyPoint[] = [];
  const hostContributions = new Map<string, Array<{ month: string; amount: number }>>();
  const applicationContributions = new Map<string, Array<{ month: string; amount: number }>>();

  for (const host of hosts) hostContributions.set(host.id, []);
  for (const app of applications) applicationContributions.set(app.id, []);

  for (const date of monthRange(fromMonth, toMonth)) {
    const monthLabel = formatDate(date);
    let capacity = input.baselineCapacity;
    let consumption = input.baselineConsumption;

    for (const host of hosts) {
      const amount = effectiveCapacityAt(host, date);
      capacity += amount;
      hostContributions.get(host.id)?.push({ month: monthLabel, amount });
    }

    for (const app of applications) {
      const amount = absorbed(app.startedAt, input) ? 0 : effectiveAllocationAt(app, date);
      consumption += amount;
      applicationContributions.get(app.id)?.push({ month: monthLabel, amount });
    }

    for (const event of events) {
      if (event.effectiveDate > date) break;
      if (absorbed(event.effectiveDate, input)) continue;
      if (event.capacityDelta !== null) capacity += event.capacityDelta;
      if (event.consumptionDelta !== null) consumption += event.consumptionDelta;
    }

    // @ai-warning `null`, never 0. Zero capacity means utilization is UNKNOWABLE,
    // and rendering it as 0% reads as "maximum headroom, healthy" — the state in
    // which nobody orders hardware. Recorded decision Q9d, 2026-07-17.
    const utilization = capacity === 0 ? null : consumption / capacity;

    months.push({ month: monthLabel, consumption, capacity, utilization });
  }

  const eventOutputs: ForecastEventOutput[] = events
    .filter((e) => e.effectiveDate >= fromMonth && e.effectiveDate <= toMonth)
    .map((e) => ({
      id: e.id,
      effectiveDate: formatDate(e.effectiveDate),
      category: e.category,
      title: e.title,
      description: e.description,
      consumptionDelta: e.consumptionDelta,
      capacityDelta: e.capacityDelta,
    }));

  return {
    fromMonth: formatDate(fromMonth),
    toMonth: formatDate(toMonth),
    months,
    events: eventOutputs,
    hosts: hosts.map((host) => ({
      id: host.id,
      name: host.name,
      projectedDecommissionAt: host.projectedDecommissionAt
        ? formatDate(host.projectedDecommissionAt)
        : null,
      contributions: hostContributions.get(host.id) ?? [],
    })),
    applications: applications.map((app) => ({
      id: app.id,
      name: app.name,
      contributions: applicationContributions.get(app.id) ?? [],
    })),
  };
}

/**
 * Is a delta already contained in the anchoring baseline, and therefore not to be
 * added again?
 *
 * ONE question decides it: WAS THE BASELINE MEASURED, AND WHEN? A measurement
 * records TOTAL actual usage at an instant, so any delta dated at or before it is
 * already inside the number and adding it double-counts (the absorption the epic
 * #172 gate found, §D35). A baseline that was never measured contains nothing but
 * what an admin typed, and Invariant 1 (docs/vision.md) says what an admin types
 * is the portion NOT modelled by tracked entities — so a tracked delta is never
 * inside it, whatever its date. `baselineMeasuredAt === null` expresses exactly
 * that second case, which is why it needs no separate branch.
 *
 * The boundary is `<=`: a delta effective on the capture date is treated as
 * already measured. A snapshot's period anchor is the first of the month, and an
 * event dated that same day describes a change during a month the snapshot has
 * already observed the start of — so the conservative reading (assume measured,
 * do not add) is the one that cannot invent capacity.
 *
 * Filtering lives HERE, at forecast time, and must never move to write time: a
 * create-time check on `startedAt > capturedAt` is true when written and made
 * false by the passage of time — and by the very snapshot job that #178
 * automates. It would be green at write and wrong a month later, with no warning.
 * At forecast time it is self-correcting as the anchor advances.
 *
 * Recorded decisions Q9b (2026-07-17) and its source-aware amendment; the source
 * half of that amendment is superseded below, the Invariant-1 half is preserved.
 *
 * @ai-warning THE GATE IS THE MEASURED PERIOD, NOT `source`. Both of the obvious
 * alternatives are defects that shipped here and were reverted:
 *
 *   - `baselineDate` (`ClusterBaselineHistory.capturedAt`) is a period LABEL that
 *     `PUT /api/clusters/:id` re-dates, so keying the boundary on it made every
 *     date edit a silent forecast edit.
 *   - `source` is MUTABLE TOO, and worse, mutable by an edit that says nothing
 *     about dates: `ClustersService.update()`'s upsert writes `source: 'manual'`
 *     unconditionally on any value correction. Gating on it meant a dateless 1%
 *     consumption fix — the exact payload baseline-edit-form.tsx sends — turned
 *     absorption off wholesale, re-adding every `capacityDelta` the measurement
 *     already contained. Irreversibly: nothing ever writes `source` back to
 *     `'vsphere'` (the snapshot job is createMany + skipDuplicates, which never
 *     updates an existing row).
 *
 * `observedAt` is the only fact here that no edit path writes, which is what
 * makes it the only safe gate. Whether a pre-capture delta is already inside the
 * measurement is a fact about WHEN THE MEASUREMENT WAS TAKEN, not about who last
 * typed a number into it.
 *
 * SEMANTIC CONSEQUENCE, stated explicitly because it is a deliberate behaviour
 * change: a human correcting a synced cluster's consumption KEEPS absorption. The
 * measurement still happened at that instant; the human corrected its VALUE.
 * Invariant 1 is untouched by this — a genuinely manual baseline is one that was
 * never measured, so it carries `observedAt = null` (no manual write path sets
 * that column) and still absorbs nothing.
 *
 * THEOREM (why the boundary move was not a behaviour change).
 * `VsphereSnapshotService` writes `capturedAt: startOfUtcMonth(measuredAt)` and
 * `observedAt: measuredAt` from the SAME instant, so for any row never re-dated
 * `startOfUtcMonth(observedAt) === capturedAt` exactly.
 *
 * @ai-warning A `vsphere` row with NO measured period absorbs NOTHING, and does
 * NOT fall back to `baselineDate` — that is the operator-editable label this
 * function was taken off, so a fallback reinstates the defect the moment the
 * `source='vsphere' => observed_at NOT NULL` invariant breaks.
 *
 * Nothing ENFORCES that invariant: there is no CHECK constraint, and no
 * application writer can restore it either — `VsphereSnapshotService` is
 * createMany + skipDuplicates, so it never updates an existing row. The
 * application cannot BREAK it either: every writer that sets `source='vsphere'`
 * writes `observedAt` from the same instant. So the hazard is out-of-band SQL —
 * an incident-recovery `INSERT`/`UPDATE` typed by hand, or a restore mixing
 * schema versions — landing a `vsphere` row that omits `observed_at`. If such a
 * row is the metric's NEWEST, it becomes the anchor and switches the whole
 * cluster into the absorb-nothing branch below, inflating capacity.
 *
 * NOT the Guard-1 runbook in `docs/operations.md`, which an earlier revision of
 * this warning named: re-running the expand migration's `INSERT ... SELECT`
 * writes the literals `'manual', NULL` (see
 * `20260717120000_add_cluster_baseline_history/migration.sql`), so it produces
 * manual rows with a null measured period — the correct, intended state for a
 * manual baseline — and cannot emit a `vsphere` row at all. The hazard is real;
 * that mechanism is not one of its paths.
 *
 * THE DIRECTION OF THAT FALL-BACK, checked per field rather than asserted. This
 * used to claim absorbing nothing is "safe on both deltas at once" because
 * `VsphereSnapshotService` writes `baselineCapacity: 0`. THAT WAS A NON-SEQUITUR
 * and is deliberately recorded rather than quietly deleted: `baselineCapacity` (a
 * scalar) and `capacityDelta` (events) are SEPARATE TERMS of
 * `capacity = baselineCapacity + Σ hostCapacity + Σ non-absorbed capacityDelta`,
 * and zeroing the first says nothing whatever about the third. The true behaviour
 * is mixed and must be read one field at a time:
 *
 *   - an unabsorbed `consumptionDelta` is counted, so consumption errs HIGH —
 *     utilization rises, buy EARLIER, safe;
 *   - an unabsorbed `capacityDelta` is counted, so capacity errs HIGH —
 *     utilization FALLS, buy LATER, UNSAFE.
 *
 * So this is not a uniformly safe direction, and no claim that it is may be
 * restored. It is the RIGHT direction anyway, on different grounds: the row's
 * measured period is unknown, the only other candidate is a field an operator can
 * edit, and trusting that field lets a hand-written row silently change a
 * purchasing number. `clusters.test.ts` pins the real consequence — capacity 2500
 * and utilization 0.4 against the absorbed row's 2000 and 0.5 — so the unsafe
 * half is asserted rather than argued away. It stays acceptable only because the
 * branch is unreachable while the invariant holds: every `VsphereSnapshotService`
 * row carries `observedAt`, and a row that was never measured is a manual
 * baseline, where absorbing nothing is not a fail-safe but the correct answer.
 */
function absorbed(effectiveDate: Date, input: ForecastInput): boolean {
  const boundary = input.baselineMeasuredAt;
  // Never measured => nothing is inside a measurement. Covers manual baselines
  // (Invariant 1) and the broken-invariant guard above with one expression.
  if (!boundary) return false;
  return effectiveDate <= boundary;
}

function effectiveCapacityAt(host: ForecastHost, date: Date): number {
  if (date < host.commissionedAt) return 0;
  const realDecom = host.decommissionedAt;
  const projDecom = host.projectedDecommissionAt;
  const effective =
    realDecom && projDecom
      ? realDecom < projDecom
        ? realDecom
        : projDecom
      : (realDecom ?? projDecom);
  if (effective !== null && date >= effective) return 0;
  let amount = 0;
  for (const row of host.capacities) {
    if (row.effectiveFrom <= date) amount = row.amount;
    else break;
  }
  return amount;
}

function effectiveAllocationAt(app: ForecastApplication, date: Date): number {
  if (date < app.startedAt) return 0;
  if (app.endedAt !== null && date >= app.endedAt) return 0;
  let amount = 0;
  for (const row of app.allocations) {
    if (row.effectiveFrom <= date) amount = row.amount;
    else break;
  }
  return amount;
}

function* monthRange(from: Date, to: Date): Iterable<Date> {
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1, 0, 0, 0, 0));
  while (cursor <= end) {
    yield new Date(cursor);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
}
