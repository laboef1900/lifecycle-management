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
   * What the anchoring baseline MEANS — which decides whether a delta dated at or
   * before it is already contained in the measurement. See `absorbsDeltas`.
   *
   * Defaults to `'manual'` when omitted, preserving the semantics every existing
   * caller and test relies on.
   */
  baselineSource?: 'manual' | 'vsphere';
  /**
   * The PERIOD the vSphere measurement was ACTUALLY taken in — immutable, unlike
   * `baselineDate`, which is an operator-editable label. Absorption keys off this
   * so re-dating a row cannot move the boundary. See `absorbsDeltas`.
   *
   * Snapped to the first of the month by every caller: `capturedAt` is a period
   * anchor, so comparing a raw instant against month-aligned delta dates would
   * shift the boundary mid-month. `null`/omitted falls back to `baselineDate`.
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
 * @ai-warning The answer depends entirely on what the baseline MEANS, and the two
 * sources mean different things. Getting this wrong is silent and
 * purchasing-critical in both directions — filter too much and the forecast
 * under-reports consumption (hardware ordered too late); filter too little and it
 * double-counts (capacity that does not exist).
 *
 *   - `manual` — the admin enters the portion NOT modelled by tracked entities
 *     (docs/vision.md, Invariant 1). A tracked delta is therefore *never* inside
 *     it, whatever its date, so nothing is absorbed. This is long-standing,
 *     deliberately tested behaviour: see forecast-events.test.ts, "keeps a
 *     pre-window event active in every month of the window".
 *   - `vsphere` — the monthly snapshot measures TOTAL actual usage, so any delta
 *     dated at or before the capture is already inside the number and adding it
 *     double-counts. That is the absorption the epic #172 gate found (§D35).
 *
 * The boundary is `<=`: a delta effective on the capture date is treated as
 * already measured. A snapshot is taken at the first of the month, and an event
 * dated that same day describes a change during a month the snapshot has already
 * observed the start of — so the conservative reading (assume measured, do not
 * add) is the one that cannot invent capacity.
 *
 * Filtering lives HERE, at forecast time, and must never move to write time: a
 * create-time check on `startedAt > capturedAt` is true when written and made
 * false by the passage of time — and by the very snapshot job that #178
 * automates. It would be green at write and wrong a month later, with no warning.
 * At forecast time it is self-correcting as the anchor advances.
 *
 * Recorded decisions Q9b (2026-07-17) and its source-aware amendment, raised when
 * implementation showed the uniform rule contradicted Invariant 1.
 *
 * @ai-warning THE BOUNDARY IS `baselineMeasuredAt`, NOT `baselineDate`.
 * `baselineDate` is `ClusterBaselineHistory.capturedAt` — a period LABEL that
 * `PUT /api/clusters/:id` re-dates. Keying absorption on it made every date edit
 * a silent forecast edit, and this rule is all-or-nothing across BOTH deltas, so
 * neither direction is safe: narrowing the boundary counts more consumption
 * (safe) AND re-adds `capacityDelta`s the snapshot already measured — capacity
 * inflates, utilization falls, hardware is deferred, and nothing was measured.
 * `baselineMeasuredAt` derives from `observedAt`, written only by
 * `VsphereSnapshotService` and touched by no edit path, so the boundary is now
 * immutable for the row's lifetime.
 *
 * THEOREM (why this is not a behaviour change). `VsphereSnapshotService` writes
 * `capturedAt: startOfUtcMonth(measuredAt)` and `observedAt: measuredAt` from the
 * SAME instant, so for any row never re-dated
 * `startOfUtcMonth(observedAt) === capturedAt` exactly, and the two expressions
 * are indistinguishable. They diverge only for a row whose `capturedAt` was
 * moved — which is precisely the defect. Manual and backfilled rows carry
 * `observedAt = NULL` (the expand migration wrote it so) and fall back to
 * `baselineDate`, which the source gate above makes unreachable anyway. The
 * change is therefore strictly a NARROWING of when an editable field decides a
 * purchasing number.
 */
function absorbed(effectiveDate: Date, input: ForecastInput): boolean {
  if (input.baselineSource !== 'vsphere') return false;
  const boundary = input.baselineMeasuredAt ?? input.baselineDate;
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
