import { entitySourceSchema, startOfUtcMonth, vsphereConnectionStatusSchema } from '@lcm/shared';
import type {
  ClusterCreateInput,
  ClusterResponse,
  ClusterUpdateInput,
  MetricStateResponse,
  Paginated,
} from '@lcm/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

import { formatDate } from '../lib/dates.js';

import { NotFoundError, UnprocessableError } from './errors.js';
import { computeForecast } from './forecast.js';
import { projectedDecommissionDate } from './host-projection.js';
import {
  translatePrismaError,
  uniqueConstraintModel,
  type UniqueConstraintMapping,
} from './prisma-errors.js';
import { assertClusterDeletable, assertSyncedBaselineCapacityZero } from './sync-ownership.js';

function clusterNameTaken(name: string): UniqueConstraintMapping {
  return {
    code: 'CLUSTER_NAME_TAKEN',
    message: `A cluster named "${name}" already exists in this tenant`,
  };
}

const clusterInclude = {
  hosts: {
    include: {
      capacities: true,
      replacedByLinks: { include: { new: { select: { commissionedAt: true, state: true } } } },
    },
  },
  items: { include: { allocations: true } },
  // Denormalized onto ClusterResponse so the fleet console can render a
  // per-cluster source badge and connection health without a round-trip per
  // tile (#193). `null` for manual clusters.
  connection: { select: { id: true, name: true, status: true, enabled: true } },
} satisfies Prisma.ClusterInclude;

type ClusterRow = Prisma.ClusterGetPayload<{ include: typeof clusterInclude }>;

/** The newest `cluster_baseline_history` row for one (cluster, metric) pair. */
type NewestBaselineRow = Prisma.ClusterBaselineHistoryGetPayload<{
  include: { metricType: true };
}>;

/**
 * MIN over the newest-per-metric anchors — the STALEST metric on the cluster.
 *
 * @ai-warning MIN, never MAX, and never a one-stage MIN over every history row.
 * `newest` is already one row per metricTypeId, so the minimum across it is the
 * metric that stopped being measured, which is what the >90-day staleness flag
 * has to react to. MAX would report a cluster as freshly baselined whenever ANY
 * one metric advanced — and the vSphere snapshot job writes `memory_gb` only, so
 * a multi-metric cluster with a year-old cpu anchor is the normal case. A
 * one-stage `_min` over the whole table is the other trap: it returns the oldest
 * row ever recorded and drifts further wrong every month history grows.
 *
 * A cluster with no history at all (a synced cluster before its first snapshot)
 * falls back to the caller-supplied date — `createdAt`, NEVER `new Date()`, which
 * would render a never-measured cluster as "baselined today": maximally fresh,
 * tripping no staleness check. Same fail-open class as the forbidden
 * `utilization ?? 0`.
 *
 * The fallback is SNAPPED because `createdAt` is a full timestamp while every
 * `capturedAt` is already a first-of-month period anchor. Unsnapped, the one
 * branch that emits a mid-month `ClusterResponse.baselineDate` would be the one
 * that contradicts the field's own contract, and a consumer slicing `YYYY-MM`
 * off it would read the wrong month. Snapping also errs OLD, never fresh — the
 * safe direction for a value a staleness check reads.
 */
function deriveBaselineDate(newest: readonly NewestBaselineRow[], fallback: Date): Date {
  let min: Date | null = null;
  for (const row of newest) {
    if (min === null || row.capturedAt < min) min = row.capturedAt;
  }
  return min ?? startOfUtcMonth(fallback);
}

export class ClustersService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(
    tenantId: string,
    options: { includeArchived?: boolean; limit: number; offset: number },
  ): Promise<Paginated<ClusterResponse>> {
    const where = options.includeArchived ? { tenantId } : { tenantId, archivedAt: null };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.cluster.count({ where }),
      this.prisma.cluster.findMany({
        where,
        include: clusterInclude,
        orderBy: { name: 'asc' },
        take: options.limit,
        skip: options.offset,
      }),
    ]);
    const newestByCluster = await this.loadNewestBaselines(
      tenantId,
      rows.map((r) => r.id),
    );
    return {
      items: rows.map((row) => this.toResponse(row, newestByCluster.get(row.id) ?? [])),
      total,
      limit: options.limit,
      offset: options.offset,
    };
  }

  async getById(tenantId: string, id: string): Promise<ClusterResponse> {
    const row = await this.prisma.cluster.findFirst({
      where: { id, tenantId },
      include: clusterInclude,
    });
    if (!row) {
      throw new NotFoundError('Cluster', id);
    }
    const newest = (await this.loadNewestBaselines(tenantId, [row.id])).get(row.id) ?? [];
    return this.toResponse(row, newest);
  }

  async create(tenantId: string, input: ClusterCreateInput): Promise<ClusterResponse> {
    const metricTypes = await this.resolveMetricTypes(input.baselines.map((b) => b.metricTypeKey));

    try {
      const created = await this.prisma.cluster.create({
        data: {
          tenantId,
          name: input.name,
          description: input.description ?? null,
          // `input.baselineDate` is no longer stored as a cluster-level scalar
          // (#195); it survives on the create contract purely as the PERIOD ANCHOR
          // for the first history row, snapped to the first of the month below.
          baselineHistory: {
            create: input.baselines.map((b) => {
              const metricType = metricTypes.get(b.metricTypeKey);
              if (!metricType) {
                throw new UnprocessableError('UNKNOWN_METRIC', `Unknown metric ${b.metricTypeKey}`);
              }
              return {
                tenantId,
                metricTypeId: metricType.id,
                capturedAt: startOfUtcMonth(input.baselineDate),
                source: 'manual',
                baselineConsumption: new Prisma.Decimal(b.baselineConsumption),
                baselineCapacity: new Prisma.Decimal(b.baselineCapacity),
              };
            }),
          },
        },
        include: clusterInclude,
      });
      const newest = (await this.loadNewestBaselines(tenantId, [created.id])).get(created.id) ?? [];
      return this.toResponse(created, newest);
    } catch (err) {
      translatePrismaError(err, { uniqueConstraint: clusterNameTaken(input.name) });
      throw err;
    }
  }

  async update(tenantId: string, id: string, input: ClusterUpdateInput): Promise<ClusterResponse> {
    const existing = await this.prisma.cluster.findFirst({
      where: { id, tenantId },
      select: { id: true, source: true },
    });
    if (!existing) {
      throw new NotFoundError('Cluster', id);
    }

    // Q9a write-time invariant (#196): name/description/baselineDate and
    // baselineConsumption corrections stay open on a synced cluster — only a
    // non-zero baselineCapacity is refused, since capacity comes from synced host
    // inventory and a non-zero baseline double-counts the fleet.
    if (input.baselines) {
      assertSyncedBaselineCapacityZero(existing.source, id, input.baselines);
    }

    const data: Prisma.ClusterUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description ?? null;

    try {
      const target =
        input.baselineDate === undefined ? undefined : startOfUtcMonth(input.baselineDate);

      // Resolved BEFORE the re-anchor is planned, because which rows may move
      // depends on which metrics the payload is about to record a value for.
      const rows = input.baselines === undefined ? [] : await this.resolveBaselineRows(input);

      // @ai-warning A submitted baselineDate is considered on EVERY path,
      // including alongside `baselines`. Branching on `baselines` first is the
      // trap, and it is the primary UI path: baseline-edit-form.tsx builds
      // `baselineDate` and `baselines` from two independent dirty checks, so
      // correcting the date and a number in one save sends both. Skipping the
      // re-anchor for those requests upserts a row at the target while the old row
      // survives carrying the old numbers — and when the target is EARLIER,
      // newest-per-metric still resolves to the old row, so the response echoes
      // neither edit, the form resets both away, and a point nobody measured is
      // left on the chart.
      //
      // Which metrics may move is not "all of them", though — see
      // `planBaselineReanchor`. `undefined` here means the request writes no
      // values at all, which is the only case where re-dating every metric is
      // right; a request that does carry values re-dates only what it names, and
      // only when appending cannot express the edit.
      //
      // Keyed on `rows`, not on `input.baselines !== undefined`, so an empty array
      // degrades to the date-only re-anchor rather than to silence. The schema's
      // `.min(1)` makes that unreachable today, and this is not the place to find
      // out if it is ever relaxed: the silent branch would revert the operator's
      // date edit with a 200, which is the exact failure this method exists to
      // prevent.
      const writingMetricIds =
        rows.length === 0 ? undefined : new Set(rows.map((row) => row.metricTypeId));
      const moves =
        target === undefined
          ? []
          : await this.planBaselineReanchor(tenantId, id, target, writingMetricIds);

      const writes: Prisma.PrismaPromise<unknown>[] = [
        // Runs even when `data` is empty, so a date-only edit still bumps
        // `updatedAt` exactly as it did when baselineDate was a column here.
        this.prisma.cluster.update({ where: { id }, data }),
        // Ordered before the value upserts below so those address a moved row at
        // its NEW period and correct it in place rather than duplicating it.
        ...moves.map((move) =>
          this.prisma.clusterBaselineHistory.update({
            where: { id: move.id },
            data: { capturedAt: move.capturedAt },
          }),
        ),
      ];

      if (rows.length > 0) {
        // The period a manual entry lands in: the supplied baselineDate when the
        // caller changed it, otherwise THAT METRIC's own newest recorded period.
        // Snapped to the first of the month so manual and vSphere baselines share
        // one period key (recorded decision Q6) — without which a manual row at
        // Aug-15 and a snapshot at Aug-01 would coexist and "the newest baseline"
        // would be decided by accident of date.
        //
        // That fallback read `clusters.baseline_date` until #195 dropped it, and a
        // cluster-wide MAX is the wrong replacement even though it is the obvious
        // one. baseline-edit-form.tsx submits EVERY metric it renders whenever any
        // one number is dirty, and omits `baselineDate` unless the date input
        // itself changed — so a one-number correction arrives here as a
        // multi-metric, DATELESS payload. Metrics drift apart routinely (the
        // vSphere snapshot job writes memory_gb only), and a cluster-wide MAX then
        // drags every lagging metric onto the freshest metric's period: it appends
        // a measurement nobody took, strands the real one behind it still carrying
        // the stale numbers, and silently clears the staleness that
        // `deriveBaselineDate`'s MIN exists to report. Per metric, each correction
        // lands on the period it is actually correcting and the upsert updates in
        // place.
        //
        // A metric with no history at all has no period to correct, so the current
        // month opens its first one.
        const newestPeriods =
          target === undefined
            ? await this.loadNewestPeriodsByMetric(
                tenantId,
                id,
                rows.map((row) => row.metricTypeId),
              )
            : new Map<string, Date>();
        const openingPeriod = firstOfCurrentMonth();

        // @ai-warning: upsert per (clusterId, metricTypeId) — never delete-then-recreate.
        // `baselines` is a partial array by contract (`.min(1)`, not "all of them"), so a
        // delete scoped to clusterId destroys the baselines of every metric the caller
        // simply didn't mention. Baselines drive hardware purchasing and this update path
        // is the only writer, so an omitted metric must be untouched, not re-created from
        // a payload that never described it. See #181.
        writes.push(
          // Append-only history. Re-entering a period the admin already recorded
          // is an explicit correction, so it upserts rather than erroring — and
          // flips `source` back to manual, since a human has overridden whatever
          // the sync captured.
          ...rows.map((row) => {
            const capturedAt = target ?? newestPeriods.get(row.metricTypeId) ?? openingPeriod;
            return this.prisma.clusterBaselineHistory.upsert({
              where: {
                clusterId_metricTypeId_capturedAt: {
                  clusterId: id,
                  metricTypeId: row.metricTypeId,
                  capturedAt,
                },
              },
              create: {
                clusterId: id,
                tenantId,
                metricTypeId: row.metricTypeId,
                capturedAt,
                source: 'manual',
                baselineConsumption: row.baselineConsumption,
                baselineCapacity: row.baselineCapacity,
              },
              update: {
                source: 'manual',
                baselineConsumption: row.baselineConsumption,
                baselineCapacity: row.baselineCapacity,
              },
            });
          }),
        );
      }

      await this.prisma.$transaction(writes);
    } catch (err) {
      // `planBaselineReanchor` reads occupancy OUTSIDE the transaction that
      // writes, so a concurrent edit can take the target period in between.
      // `cluster_baseline_history_period_unique` is the real guard and nothing
      // corrupts — this only maps the resulting P2002 onto the SAME typed refusal
      // the checked path returns, so the race degrades to a 422 naming the problem
      // rather than a sanitized 500.
      //
      // @ai-note Deliberately NOT closed with locking. Serializing every baseline
      // edit, or taking `SELECT ... FOR UPDATE` over a period range, buys nothing
      // the unique index does not already guarantee — the race's only consequence
      // is which error code the loser sees, and that is what this maps.
      if (uniqueConstraintModel(err) === Prisma.ModelName.ClusterBaselineHistory) {
        throw new UnprocessableError(
          'BASELINE_PERIOD_OCCUPIED',
          'A baseline was recorded for that period while this edit was in flight. ' +
            'Reload the cluster and retry.',
        );
      }
      // Only map P2002 to a name conflict when a rename was actually requested.
      // The unique indexes reachable from here also include the history period
      // key, and reporting that as `A cluster named "" already exists` sends the
      // operator after the wrong problem.
      translatePrismaError(
        err,
        input.name === undefined ? {} : { uniqueConstraint: clusterNameTaken(input.name) },
      );
      throw err;
    }

    return this.getById(tenantId, id);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const existing = await this.prisma.cluster.findFirst({
      where: { id, tenantId },
      select: { id: true, source: true },
    });
    if (!existing) {
      throw new NotFoundError('Cluster', id);
    }
    // A synced cluster's existence is sync-owned: deleting it cascades away the
    // baseline history and the next sync re-creates an empty twin (#196).
    assertClusterDeletable(existing.source, id);
    await this.prisma.cluster.deleteMany({ where: { id, tenantId } });
  }

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

  /** Validates a `baselines` payload into writable rows, resolving metric keys to ids. */
  private async resolveBaselineRows(input: ClusterUpdateInput): Promise<
    Array<{
      metricTypeId: string;
      baselineConsumption: Prisma.Decimal;
      baselineCapacity: Prisma.Decimal;
    }>
  > {
    const baselines = input.baselines ?? [];
    const metricTypes = await this.resolveMetricTypes(baselines.map((b) => b.metricTypeKey));
    return baselines.map((b) => {
      const metricType = metricTypes.get(b.metricTypeKey);
      if (!metricType) {
        throw new UnprocessableError('UNKNOWN_METRIC', `Unknown metric ${b.metricTypeKey}`);
      }
      return {
        metricTypeId: metricType.id,
        baselineConsumption: new Prisma.Decimal(b.baselineConsumption),
        baselineCapacity: new Prisma.Decimal(b.baselineCapacity),
      };
    });
  }

  /**
   * Plans a baseline re-date: which metrics' NEWEST history rows must move onto
   * `target`, refusing if a move would disturb what is already recorded.
   *
   * @ai-warning This is the one place the append-only history is MUTATED rather
   * than appended to, so both the exclusions and the refusal are load-bearing.
   *
   * A row is moved only when there is no honest alternative, so `writing` decides
   * far more than it looks:
   *
   * - `undefined` — the request carries NO values. There is nothing to append, so
   *   re-dating each metric's newest row is the only way to honour the date
   *   without fabricating a measurement nobody took.
   * - a set — the request carries values, and only the metrics it NAMES may move.
   *   An omitted metric must be untouched (#181, same rule the upsert follows):
   *   re-dating a row the payload never described is exactly the silent edit that
   *   principle exists to prevent. Of the named metrics, one whose target is LATER
   *   than its newest row is recording an ordinary new monthly measurement — the
   *   upsert appends it and the older rows stay, which is what epic #172 exists to
   *   accumulate, so moving instead would delete a measurement on every
   *   forward-dated save. That leaves the genuine case: a target EARLIER than the
   *   metric's newest row, where appending would leave the OLD row newest, so the
   *   response would echo neither the submitted date nor the submitted values and
   *   the form would reset both away.
   *
   * The refusal has to be phrased as "would this reorder?", not "is the target
   * period taken?". The narrow version reads plausible — the moving row is a
   * metric's newest, so nothing sits after it — and is wrong for every target
   * earlier than some OTHER recorded row: re-dating July's 300 onto a free April,
   * behind an existing May of 100, leaves history reading Apr=300, May=100 — the
   * July measurement plotted at April and a 300 -> 100 drop nobody measured, on a
   * chart that feeds hardware purchasing. Refusing on `capturedAt >= target`
   * subsumes the exact-period check (`==` is the occupied case, `>` the
   * reordering one), leaving one invariant: a moved row stays the newest row for
   * its metric.
   *
   * The scope is PER METRIC, because the unique key is (cluster, metric, period).
   * A cluster-wide check would refuse the legitimate edit where one metric
   * already sits on the target and another is moving onto it.
   */
  private async planBaselineReanchor(
    tenantId: string,
    clusterId: string,
    target: Date,
    writing: ReadonlySet<string> | undefined,
  ): Promise<Array<{ id: string; capturedAt: Date }>> {
    const newest = (await this.loadNewestBaselines(tenantId, [clusterId])).get(clusterId) ?? [];
    const moving = newest.filter((row) => {
      if (row.capturedAt.getTime() === target.getTime()) return false;
      if (writing === undefined) return true;
      return writing.has(row.metricTypeId) && row.capturedAt.getTime() > target.getTime();
    });
    // Nothing to move covers four cases, and all are no-ops rather than writes: a
    // synced cluster between import and its first snapshot has no row to re-date
    // (creating one would invent a measurement nobody took), a cluster already
    // anchored on the submitted period is simply unchanged, a metric the payload
    // omitted stays untouched, and a named metric recording a later period is
    // appended rather than re-dated.
    if (moving.length === 0) return [];

    // The moving rows themselves are excluded: a backwards move starts from a
    // period later than the target, so it would otherwise block itself.
    const blocking = await this.prisma.clusterBaselineHistory.findMany({
      where: {
        clusterId,
        tenantId,
        metricTypeId: { in: moving.map((row) => row.metricTypeId) },
        capturedAt: { gte: target },
        id: { notIn: moving.map((row) => row.id) },
      },
      select: { metricTypeId: true },
    });
    const blockedMetrics = new Set(blocking.map((row) => row.metricTypeId));

    for (const row of moving) {
      if (blockedMetrics.has(row.metricTypeId)) {
        throw new UnprocessableError(
          'BASELINE_PERIOD_OCCUPIED',
          `A ${row.metricType.key} baseline is already recorded at or after ` +
            `${formatDate(target).slice(0, 7)}; re-dating onto it would overwrite or reorder a ` +
            'recorded measurement. Edit that period directly instead.',
        );
      }
    }

    return moving.map((row) => ({ id: row.id, capturedAt: target }));
  }

  /**
   * MAX(captured_at) per metric on ONE cluster, for the metrics a write names.
   *
   * The period a dateless correction belongs in: the one it is correcting. A
   * metric absent from the result has no history at all and so has no period to
   * correct — the caller opens its first one at the current month.
   *
   * @ai-warning PER METRIC, never a cluster-wide `_max`. The unique key is
   * (cluster, metric, period), so "the cluster's newest period" is not a period
   * the lagging metrics were ever measured at; writing them there appends a
   * fabricated measurement and leaves the real one behind, stale. See the call
   * site for the full argument.
   *
   * Grouped in Postgres and bounded by the payload's metrics — never by months of
   * accumulated history, which this runs alongside on every baseline save.
   */
  private async loadNewestPeriodsByMetric(
    tenantId: string,
    clusterId: string,
    metricTypeIds: readonly string[],
  ): Promise<Map<string, Date>> {
    if (metricTypeIds.length === 0) return new Map();
    const groups = await this.prisma.clusterBaselineHistory.groupBy({
      by: ['metricTypeId'],
      where: { clusterId, tenantId, metricTypeId: { in: [...metricTypeIds] } },
      _max: { capturedAt: true },
    });
    return new Map(
      groups.flatMap((g): Array<[string, Date]> =>
        g._max.capturedAt === null ? [] : [[g.metricTypeId, startOfUtcMonth(g._max.capturedAt)]],
      ),
    );
  }

  /**
   * The newest `cluster_baseline_history` row per (clusterId, metricTypeId).
   *
   * Two DB-side queries, bounded by clusters x metrics — never by months of
   * accumulated history. That bound is the point: this runs on every fleet-console
   * page load, and a relation include would materialize every row ever captured
   * (N clusters x M metrics x every month) to keep one of them.
   *
   * @ai-warning Deliberately NOT Prisma `distinct`. Whether Prisma pushes it down
   * to Postgres `DISTINCT ON` or post-filters client-side is unverified here, and
   * the client-side branch silently degrades to loading the whole table.
   * `groupBy` + `_max` is unambiguously DB-side.
   */
  private async loadNewestBaselines(
    tenantId: string,
    clusterIds: readonly string[],
  ): Promise<Map<string, NewestBaselineRow[]>> {
    if (clusterIds.length === 0) return new Map();

    // Stage 1: MAX(captured_at) per (cluster, metric), grouped in Postgres.
    const groups = await this.prisma.clusterBaselineHistory.groupBy({
      by: ['clusterId', 'metricTypeId'],
      where: { tenantId, clusterId: { in: [...clusterIds] } },
      _max: { capturedAt: true },
    });

    const keys = groups.flatMap((g) =>
      g._max.capturedAt === null
        ? []
        : [{ clusterId: g.clusterId, metricTypeId: g.metricTypeId, capturedAt: g._max.capturedAt }],
    );
    if (keys.length === 0) return new Map();

    // Stage 2: fetch exactly those rows, addressed by the period unique key
    // (cluster_baseline_history_period_unique). Metric order is pinned so
    // `ClusterResponse.metrics[0]` stays stable — cluster-tile.tsx,
    // cluster-panel.tsx and fleet-console.tsx all read it positionally.
    const rows = await this.prisma.clusterBaselineHistory.findMany({
      where: { tenantId, OR: keys },
      include: { metricType: true },
      orderBy: { metricType: { key: 'asc' } },
    });

    const byCluster = new Map<string, NewestBaselineRow[]>();
    for (const row of rows) {
      const list = byCluster.get(row.clusterId);
      if (list) list.push(row);
      else byCluster.set(row.clusterId, [row]);
    }
    return byCluster;
  }

  private async resolveMetricTypes(
    keys: string[],
  ): Promise<Map<string, { id: string; key: string; displayName: string; unit: string }>> {
    const unique = Array.from(new Set(keys));
    const rows = await this.prisma.metricType.findMany({
      where: { key: { in: unique } },
    });
    const map = new Map(rows.map((r) => [r.key, r]));
    for (const key of unique) {
      if (!map.has(key)) {
        throw new UnprocessableError('UNKNOWN_METRIC', `Unknown metric ${key}`);
      }
    }
    return map;
  }

  private toResponse(row: ClusterRow, newest: readonly NewestBaselineRow[]): ClusterResponse {
    const today = firstOfCurrentMonth();
    const metrics: MetricStateResponse[] = newest.map((b) => {
      const baselineConsumption = b.baselineConsumption.toNumber();
      const baselineCapacity = b.baselineCapacity.toNumber();

      const forecast = computeForecast(
        {
          // This metric's OWN newest period — never the cluster-level MIN below.
          // Anchoring every metric on the MIN would silently backdate the fresher
          // ones and move their currentConsumption/currentCapacity.
          baselineDate: b.capturedAt,
          // What the anchor MEANS decides whether tracked deltas dated at or
          // before it are already inside its numbers (`absorbed` in forecast.ts,
          // recorded decision Q9b). forecast-loader has always passed this;
          // the cluster endpoints could not, because the legacy baseline table
          // had no `source` column. Reading both from the same history row is
          // what converges them.
          baselineSource: b.source === 'vsphere' ? 'vsphere' : 'manual',
          baselineConsumption,
          baselineCapacity,
          hosts: row.hosts.map((h) => ({
            id: h.id,
            name: h.name,
            commissionedAt: h.commissionedAt,
            decommissionedAt: h.decommissionedAt,
            projectedDecommissionAt: projectedDecommissionDate(h),
            capacities: h.capacities
              .filter((c) => c.metricTypeId === b.metricTypeId)
              .map((c) => ({ effectiveFrom: c.effectiveFrom, amount: c.amount.toNumber() })),
          })),
          applications: row.items
            .filter((it) => it.kind === 'application')
            .map((a) => ({
              id: a.id,
              name: a.name,
              startedAt: a.effectiveDate,
              endedAt: a.endedAt,
              allocations: a.allocations
                .filter((al) => al.metricTypeId === b.metricTypeId)
                .map((al) => ({ effectiveFrom: al.effectiveFrom, amount: al.amount.toNumber() })),
            })),
          events: row.items
            .filter((it) => it.kind === 'event' && it.metricTypeId === b.metricTypeId)
            .map((e) => ({
              id: e.id,
              effectiveDate: e.effectiveDate,
              category: e.category,
              title: e.name,
              description: e.description,
              consumptionDelta: e.consumptionDelta?.toNumber() ?? null,
              capacityDelta: e.capacityDelta?.toNumber() ?? null,
            })),
        },
        today,
        today,
      );
      const point = forecast.months[0];
      const currentConsumption = point?.consumption ?? baselineConsumption;
      const currentCapacity = point?.capacity ?? baselineCapacity;
      // Preserve the forecast's null (capacity 0 ⇒ unknowable). NEVER `?? 0`: that
      // laundered "unknown" into "0% used" — healthy, plenty of headroom — on the
      // surfaces that drive hardware purchasing. Recorded decision Q9d (#200).
      const utilization = point ? point.utilization : null;

      return {
        metricTypeKey: b.metricType.key,
        metricTypeDisplayName: b.metricType.displayName,
        unit: b.metricType.unit,
        baselineConsumption,
        baselineCapacity,
        currentConsumption,
        currentCapacity,
        utilization,
      };
    });

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      baselineDate: formatDate(deriveBaselineDate(newest, row.createdAt)),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      archivedAt: row.archivedAt?.toISOString() ?? null,
      metrics,
      // Sync provenance (#193). `source`/`status` are stored as untyped strings,
      // so parse them at this boundary rather than casting — a corrupt value
      // fails loudly instead of shipping garbage to the client.
      source: entitySourceSchema.parse(row.source),
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      externalName: row.externalName,
      connection: row.connection
        ? {
            id: row.connection.id,
            name: row.connection.name,
            status: vsphereConnectionStatusSchema.parse(row.connection.status),
            enabled: row.connection.enabled,
          }
        : null,
      provisionalHostCount: row.hosts.filter((h) => h.commissionedAtProvisional).length,
    };
  }
}

function firstOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
