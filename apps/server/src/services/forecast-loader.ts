import {
  formatDateIso,
  MAX_FORECAST_SPAN_MONTHS,
  monthsBetweenUtc,
  startOfUtcMonth,
  type BaselineHistoryPoint,
  type ForecastAcknowledgment,
  type ProcurementInfo,
  type Scenario,
} from '@lcm/shared';
import type { PrismaClient } from '@prisma/client';

import { NotFoundError, UnprocessableError } from './errors.js';
import {
  computeForecast,
  type ForecastApplication,
  type ForecastEvent,
  type ForecastHost,
  type ForecastInput,
  type ForecastResult,
  type HostMembershipInterval,
} from './forecast.js';
import { projectedDecommissionDate } from './host-projection.js';
import {
  computeCapacitySignature,
  resolveAcknowledgment,
  type StoredApprovalSnapshot,
} from './order-approval-coverage.js';
import { computeProcurementInfo } from './procurement.js';
import { applyScenario } from './scenario.js';
import { SettingsService } from './settings.js';

const DEFAULT_HORIZON_MONTHS = 24;

interface LoadOptions {
  fromMonth?: Date;
  toMonth?: Date;
}

/**
 * Write-path-only superset of {@link LoadOptions}. `clampAnchorToToday` lives
 * here — deliberately NOT on the public `LoadOptions` — so the read-path
 * entry points (`forCluster`/`forClusterWithScenario`), whose signatures expose
 * only `LoadOptions`, cannot thread the clamp through even by mistake (#303
 * mechanical-review hardening). `liveBreachContext` is the sole constructor of
 * this type; only `prepare` consumes it.
 *
 * `clampAnchorToToday` (WRITE-PATH ONLY, #303): when no explicit `fromMonth` is
 * given, clamp the default baseline anchor to `min(capturedAt, today)` before
 * deriving the window. A no-op for the normal past/present-dated baseline
 * (`min` returns `capturedAt`); for a FUTURE-dated baseline it pulls the window
 * start back to today so the snapshotted `orderByDate` matches the
 * today-anchored chip read instead of landing months later and falsely tripping
 * the ≥ T supersede rule. The read path never sees this option, so its
 * baseline-anchored window — and the `all` view that depends on it — is
 * unchanged (see the #300 window-alignment rejection in DESIGN.md §3).
 */
interface InternalLoadOptions extends LoadOptions {
  clampAnchorToToday?: boolean;
}

interface PreparedForecastInput {
  input: ForecastInput;
  baselineHistory: BaselineHistoryPoint[];
  fromMonth: Date;
  toMonth: Date;
  effectiveThresholds: Awaited<ReturnType<SettingsService['effectiveFor']>>;
  procurementLeadTimeWeeks: number;
  /**
   * Σ nameplate capacity across the cluster's active hosts for this metric (#292).
   * Snapshotted at approval time and compared against the live value to decide
   * whether an approval still covers the breach (DESIGN.md §3). Computed from the
   * REAL loaded hosts, so it never reflects a scenario transform.
   */
  capacitySignature: number;
}

/** Live procurement context for the order-approval write path (#292). */
export interface LiveBreachContext {
  procurement: ProcurementInfo;
  warnThreshold: number;
  capacitySignature: number;
}

export class ForecastService {
  constructor(private readonly prisma: PrismaClient) {}

  async forCluster(
    tenantId: string,
    clusterId: string,
    metricKey: string,
    options: LoadOptions = {},
  ): Promise<ForecastResult> {
    const prepared = await this.prepare(tenantId, clusterId, metricKey, options);
    const result = this.finalize(prepared, prepared.input);
    const acknowledgment = await this.resolveAcknowledgmentFor(tenantId, clusterId, {
      orderByDate: result.procurement.orderByDate,
      warnThreshold: result.effectiveThresholds.warn,
      capacitySignature: prepared.capacitySignature,
    });
    return { ...result, acknowledgment };
  }

  /**
   * Same as forCluster but applies a what-if transform between loading and
   * computing. The baseline DB state is never modified — the scenario forecast
   * lives only in this response. `acknowledgment` stays `null`: a hypothetical is
   * never an approved order (INV-1), and coverage would otherwise be evaluated
   * against scenario-mutated capacity/order-by values.
   */
  async forClusterWithScenario(
    tenantId: string,
    clusterId: string,
    metricKey: string,
    scenario: Scenario,
    options: LoadOptions = {},
  ): Promise<ForecastResult> {
    const prepared = await this.prepare(tenantId, clusterId, metricKey, options);
    const scenarioInput = applyScenario(prepared.input, scenario);
    return this.finalize(prepared, scenarioInput);
  }

  /**
   * The live procurement facts the order-approval write path snapshots (#292):
   * the current breach, the warn threshold, and the capacity signature — all from
   * the REAL (non-scenario) forecast.
   *
   * @ai-warning This evaluates the SERVER DEFAULT window with its anchor CLAMPED
   * to `min(capturedAt, today)` (`clampAnchorToToday`, #303), NOT the raw
   * baseline-anchored window and NOT the exact window the chip reads. The web
   * chip requests a TODAY-anchored window (`resolveWindow` in
   * `apps/web/src/components/clusters/window-controls.tsx` — `from =
   * firstOfMonth(today)` for the 12/24-mo views).
   *
   *   - PAST/PRESENT-dated baseline (`capturedAt ≤ today`, the normal case): the
   *     clamp is a no-op, so this stays baseline-anchored and starts no later than
   *     any chip window. The snapshotted `orderByDate` is never later than the
   *     live one, so the ≥ T supersede rule (INV-5) can never *falsely* supersede
   *     on any view (a genuine worsening reads as improving/unchanged, so an
   *     acknowledgment can only linger, never vanish), and live chip urgency
   *     escalates independently regardless. The one visible-but-safe symptom is a
   *     422 on Approve for a breach past this window's `to` (anchor + horizon) yet
   *     within the chip's (today + horizon).
   *   - FUTURE-dated baseline (`capturedAt > today`): the clamp pulls the window
   *     start back to `firstOfMonth(today)`, matching the chip's 12/24-mo anchor.
   *     Without it (the pre-#303 defect) the raw baseline anchor started the write
   *     window LATER than the chip's, so the snapshotted `orderByDate` landed later
   *     than the live one and the ≥ T rule FALSELY superseded the approval the
   *     instant it was created (the acknowledgment never appeared). Future-dated
   *     baselines are accepted with no upper bound (see the anchor @ai-warning in
   *     `prepare` — `capturedAt <= today` is deliberately NOT enforced), which is
   *     why the write path, not the accept path, is where this is corrected.
   *
   * The clamp is deliberately write-path only and does NOT align the full window
   * with the chip: the read path keeps its baseline-anchored `all` view, whose
   * `from` is the baseline. Aligning the whole write window to `today` was
   * rejected because it regresses that `all` view into false supersedes — see
   * DESIGN.md §3 "Window divergence" for both edges.
   */
  async liveBreachContext(
    tenantId: string,
    clusterId: string,
    metricKey: string,
  ): Promise<LiveBreachContext> {
    // #303: clamp the default anchor to min(capturedAt, today) for the snapshot.
    const prepared = await this.prepare(tenantId, clusterId, metricKey, {
      clampAnchorToToday: true,
    });
    const result = this.finalize(prepared, prepared.input);
    return {
      procurement: result.procurement,
      warnThreshold: result.effectiveThresholds.warn,
      capacitySignature: prepared.capacitySignature,
    };
  }

  /**
   * Latest approval for the cluster vs the live breach → the coverage rule
   * (DESIGN.md §3). Reads `order_approvals` only; never touches the forecast math
   * (INV-1).
   */
  private async resolveAcknowledgmentFor(
    tenantId: string,
    clusterId: string,
    live: { orderByDate: string | null; warnThreshold: number; capacitySignature: number },
  ): Promise<ForecastAcknowledgment | null> {
    // Cheap short-circuit: no breach ⇒ no acknowledgment (INV-3), skip the query.
    if (live.orderByDate === null) return null;
    const latest = await this.prisma.orderApproval.findFirst({
      where: { tenantId, clusterId },
      orderBy: { createdAt: 'desc' },
    });
    const snapshot: StoredApprovalSnapshot | null = latest
      ? {
          orderByDate: latest.orderByDate,
          warnThreshold: latest.warnThreshold,
          capacitySignature: latest.capacitySignature,
          note: latest.note,
          approvedByLabel: latest.approvedByLabel,
          createdAt: latest.createdAt,
        }
      : null;
    return resolveAcknowledgment(snapshot, live);
  }

  private async prepare(
    tenantId: string,
    clusterId: string,
    metricKey: string,
    options: InternalLoadOptions,
  ): Promise<PreparedForecastInput> {
    const metricType = await this.prisma.metricType.findUnique({ where: { key: metricKey } });
    if (!metricType) {
      throw new UnprocessableError('UNKNOWN_METRIC', `Unknown metric ${metricKey}`);
    }

    const cluster = await this.prisma.cluster.findFirst({
      where: { id: clusterId, tenantId },
      include: {
        // `tenantId` is redundant with the parent cluster's own tenant filter, and
        // is included anyway so this reader and `ClustersService.loadNewestBaselines`
        // — which filters on it — cannot disagree about which rows exist. They must
        // agree: both compute "the newest row", one for /forecast and one for
        // ClusterResponse.metrics, and a divergence would show as the cluster panel
        // and its own forecast chart quoting different numbers.
        baselineHistory: {
          where: { tenantId, metricTypeId: metricType.id },
          orderBy: { capturedAt: 'asc' },
        },
        items: {
          where: { OR: [{ metricTypeId: metricType.id }, { metricTypeId: null }] },
          include: { allocations: { where: { metricTypeId: metricType.id } } },
        },
      },
    });

    if (!cluster) {
      throw new NotFoundError('Cluster', clusterId);
    }

    const settingsService = new SettingsService(this.prisma);
    const effectiveThresholds = await settingsService.effectiveFor(tenantId, clusterId);
    const tenantSettings = await settingsService.getTenant(tenantId);

    // @ai-warning Anchor on the NEWEST baseline, unconditionally — `history` is
    // ordered `capturedAt: 'asc'`, so the anchor is the last element.
    //
    // Note what is deliberately NOT done: filtering to `capturedAt <= today`. A
    // future-dated baseline is accepted today and simply pushes `fromMonth`
    // forward; adding an upper bound here would be a silent behaviour change
    // smuggled in under a migration. If that is ever wanted, it is its own
    // argued change.
    //
    // The advancing anchor is also the forecast's error-correction mechanism:
    // anchored permanently on the first baseline, every modelling error would
    // compound forever with nothing to correct it — which is what #172 exists to
    // end. See docs/vision.md "Forecast modelling semantics".
    const history = cluster.baselineHistory;
    const anchor = history[history.length - 1];
    if (!anchor) {
      throw new UnprocessableError(
        'METRIC_NOT_TRACKED',
        `Cluster does not track metric ${metricKey}`,
      );
    }

    // @ai-context #303 write-path anchor clamp. The DEFAULT anchor is the newest
    // baseline's `capturedAt`; the write path (`liveBreachContext`) additionally
    // clamps it to `min(capturedAt, today)` so a FUTURE-dated baseline does not
    // start the snapshot window later than the today-anchored chip window and
    // falsely supersede a fresh approval. `min` makes it a no-op for any
    // past/present baseline, so the read path (no `clampAnchorToToday`) is
    // untouched. `firstOfMonth` is monotonic, so clamping the instant then
    // snapping equals snapping both then taking the earlier month.
    const defaultAnchor =
      options.clampAnchorToToday && anchor.capturedAt.getTime() > Date.now()
        ? new Date()
        : anchor.capturedAt;
    const fromMonth = options.fromMonth ?? firstOfMonth(defaultAnchor);
    const toMonth = options.toMonth ?? addMonths(fromMonth, DEFAULT_HORIZON_MONTHS);

    if (toMonth < fromMonth) {
      throw new UnprocessableError('INVALID_RANGE', 'to must be on or after from');
    }
    if (monthsBetweenUtc(fromMonth, toMonth) > MAX_FORECAST_SPAN_MONTHS) {
      throw new UnprocessableError(
        'RANGE_TOO_LARGE',
        `Forecast window must not exceed ${MAX_FORECAST_SPAN_MONTHS} months`,
      );
    }

    // @ai-context #289 — time-scoped attribution. Hosts are loaded through the
    // membership timeline (`HostClusterMembership WHERE clusterId`), NOT through
    // `cluster.hosts` by the host's CURRENT `clusterId`. That is the whole point:
    // a host that moved AWAY from this cluster still contributes to its pre-move
    // months, and one that moved IN contributes only from its move date. Each
    // month's attribution is resolved in `effectiveCapacityAt` from
    // `membershipIntervals`. Ordered by host creation (then id) so the result's
    // host list is deterministic — the characterization snapshot depends on it.
    const memberships = await this.prisma.hostClusterMembership.findMany({
      where: { tenantId, clusterId },
      orderBy: [{ host: { createdAt: 'asc' } }, { hostId: 'asc' }],
      include: {
        host: {
          include: {
            capacities: { where: { metricTypeId: metricType.id } },
            replacedByLinks: {
              include: { new: { select: { commissionedAt: true, state: true } } },
            },
          },
        },
      },
    });

    // A host can hold more than one interval in this cluster (moved A->B->A), so
    // group all of a host's intervals under one ForecastHost.
    type MembershipHost = (typeof memberships)[number]['host'];
    const byHostId = new Map<
      string,
      { host: MembershipHost; intervals: HostMembershipInterval[] }
    >();
    for (const m of memberships) {
      const entry = byHostId.get(m.hostId);
      if (entry) entry.intervals.push({ from: m.effectiveFrom, to: m.effectiveTo });
      else
        byHostId.set(m.hostId, {
          host: m.host,
          intervals: [{ from: m.effectiveFrom, to: m.effectiveTo }],
        });
    }

    const hosts: ForecastHost[] = [...byHostId.values()].map(({ host, intervals }) => ({
      id: host.id,
      name: host.name,
      commissionedAt: host.commissionedAt,
      decommissionedAt: host.decommissionedAt,
      projectedDecommissionAt: projectedDecommissionDate(host),
      capacities: host.capacities.map((c) => ({
        effectiveFrom: c.effectiveFrom,
        amount: c.amount.toNumber(),
      })),
      membershipIntervals: intervals,
    }));

    const applications: ForecastApplication[] = cluster.items
      .filter((it) => it.kind === 'application')
      .map((app) => ({
        id: app.id,
        name: app.name,
        startedAt: app.effectiveDate,
        endedAt: app.endedAt,
        allocations: app.allocations.map((a) => ({
          effectiveFrom: a.effectiveFrom,
          amount: a.amount.toNumber(),
        })),
      }));

    const events: ForecastEvent[] = cluster.items
      .filter((it) => it.kind === 'event' && it.metricTypeId === metricType.id)
      .map((e) => ({
        id: e.id,
        effectiveDate: e.effectiveDate,
        category: e.category,
        title: e.name,
        description: e.description,
        consumptionDelta: e.consumptionDelta?.toNumber() ?? null,
        capacityDelta: e.capacityDelta?.toNumber() ?? null,
      }));

    // The pure `computeForecast` never learns that history exists — it still
    // takes one anchor date and one pair of baseline scalars. Keeping it ignorant
    // is what makes the characterization snapshot meaningful: if this migration
    // had reshaped the pure function's contract, "the output is unchanged" would
    // no longer be a claim anyone could check.
    return {
      input: {
        baselineDate: anchor.capturedAt,
        // Whether tracked deltas dated at or before the anchor are already inside
        // its numbers is decided by ONE fact: was this baseline measured, and
        // when. See `absorbed` in forecast.ts — and note that `source` is
        // deliberately NOT passed, because it is mutable by a value edit that says
        // nothing about when the measurement was taken. `capturedAt` above is a
        // period label a baseline edit can re-date; `observedAt` is the instant
        // vCenter was polled and no edit path writes it, so the absorption
        // boundary stops moving when an operator corrects a date or a value. A row
        // that was never measured has `observedAt = null` and absorbs nothing,
        // which is exactly Invariant 1 for a manual baseline. SNAPPED, never the
        // raw instant:
        // `VsphereSnapshotService` derives both columns from one `measuredAt`, so
        // `startOfUtcMonth(observedAt) === capturedAt` for every row never
        // re-dated — which is what makes this a provable no-op there.
        baselineMeasuredAt: anchor.observedAt ? startOfUtcMonth(anchor.observedAt) : null,
        baselineConsumption: anchor.baselineConsumption.toNumber(),
        baselineCapacity: anchor.baselineCapacity.toNumber(),
        hosts,
        applications,
        events,
      },
      baselineHistory: history.map((row) => {
        const capacity = row.baselineCapacity.toNumber();
        const consumption = row.baselineConsumption.toNumber();
        return {
          capturedAt: formatDateIso(row.capturedAt),
          source: row.source === 'vsphere' ? ('vsphere' as const) : ('manual' as const),
          consumption,
          capacity,
          utilization: capacity === 0 ? null : consumption / capacity,
        };
      }),
      fromMonth,
      toMonth,
      effectiveThresholds,
      procurementLeadTimeWeeks: tenantSettings.procurementLeadTimeWeeks,
      // From the REAL loaded hosts (metric-filtered by the include above) — the
      // change-detector an approval snapshots (#292). Never a scenario value.
      capacitySignature: computeCapacitySignature(hosts),
    };
  }

  private finalize(prepared: PreparedForecastInput, input: ForecastInput): ForecastResult {
    const computed = computeForecast(input, prepared.fromMonth, prepared.toMonth);
    const procurement = computeProcurementInfo({
      months: computed.months,
      warnFraction: prepared.effectiveThresholds.warn,
      leadTimeWeeks: prepared.procurementLeadTimeWeeks,
    });
    return {
      ...computed,
      effectiveThresholds: prepared.effectiveThresholds,
      procurement,
      baselineHistory: prepared.baselineHistory,
      // Default; forCluster overrides with the resolved acknowledgment. Scenarios
      // keep this null (INV-1).
      acknowledgment: null,
    };
  }
}

function firstOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}
