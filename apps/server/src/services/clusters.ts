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

/** Metric keys a `baselines` payload names more than once — normally none. */
function duplicateMetricKeys(baselines: readonly { metricTypeKey: string }[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const baseline of baselines) {
    if (seen.has(baseline.metricTypeKey)) duplicated.add(baseline.metricTypeKey);
    else seen.add(baseline.metricTypeKey);
  }
  return [...duplicated];
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

/**
 * Does a submitted baseline CORRECT the metric's stored newest values, or merely
 * repeat them back?
 *
 * @ai-note The discriminator between an edit the operator made and one
 * baseline-edit-form.tsx carried along: it submits every rendered metric whenever
 * any one number is dirty, pre-filled from `ClusterResponse.metrics` — which is
 * exactly this newest row. So "differs from stored" reconstructs the per-metric
 * dirty flag the wire format drops.
 *
 * Compared with `Decimal.equals`, not `===`/`toNumber()`: these are
 * `Decimal(18,3)` and the stored side comes back scale-padded, so 900 and 900.000
 * are the same measurement and must not read as a correction.
 *
 * A metric with no stored row has nothing to repeat, so anything submitted for it
 * is new information.
 */
function correctsStoredValues(
  submitted: { baselineConsumption: Prisma.Decimal; baselineCapacity: Prisma.Decimal },
  stored: NewestBaselineRow | undefined,
): boolean {
  if (stored === undefined) return true;
  return (
    !submitted.baselineConsumption.equals(stored.baselineConsumption) ||
    !submitted.baselineCapacity.equals(stored.baselineCapacity)
  );
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
    // Refused BEFORE the write rather than mapped from the P2002 it would raise.
    // `clusterCreateInputSchema` bounds `baselines` by length alone, so a payload
    // naming one metric twice is legal here and would write two nested rows at one
    // (clusterId, metricTypeId, capturedAt) — a
    // `cluster_baseline_history_period_unique` violation, not a name collision.
    //
    // @ai-warning Recovering that distinction from the error is NOT available on
    // this path: for a NESTED create, Prisma 7 reports `meta.modelName` as the
    // TOP-LEVEL model ("Cluster"), so `uniqueConstraintModel` cannot tell this
    // violation from a duplicate cluster name and the catch below would answer
    // CLUSTER_NAME_TAKEN — a conflict that does not exist, which no rename ever
    // resolves. That behaviour is pinned in `prisma-errors.test.ts`. Checking the
    // payload is exact, and it is the right layer anyway: the request contradicts
    // itself, and silently keeping one of the two values would discard a number
    // the operator supplied.
    const duplicated = duplicateMetricKeys(input.baselines);
    if (duplicated.length > 0) {
      throw new UnprocessableError(
        'BASELINE_PERIOD_OCCUPIED',
        `This request records ${duplicated.join(', ')} more than once. ` +
          'A cluster holds one baseline per metric per period.',
      );
    }

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
      // Unconditional, and only because the duplicate-metric guard above closed
      // the other unique index this statement can reach. `clusters_tenant_name_unique`
      // is what is left: `clusters_connection_external_unique` is (connectionId,
      // externalId), both null on every manually created cluster and therefore
      // distinct in Postgres. Re-open a path to a nested history row here and this
      // mapping starts lying again.
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

      // Same refusal as create(). Two entries for one metric resolve to the SAME
      // (cluster, metric, period) upsert key, so the second silently overwrites the
      // first and a number the operator supplied is dropped with a 200 OK. Postgres
      // cannot catch this one — sequential upserts inside a transaction never
      // breach the period index — so it has to be refused before the write.
      const duplicated = duplicateMetricKeys(input.baselines);
      if (duplicated.length > 0) {
        throw new UnprocessableError(
          'BASELINE_PERIOD_OCCUPIED',
          `This request records ${duplicated.join(', ')} more than once. ` +
            'A cluster holds one baseline per metric per period.',
        );
      }
    }

    const data: Prisma.ClusterUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description ?? null;

    try {
      const target =
        input.baselineDate === undefined ? undefined : startOfUtcMonth(input.baselineDate);

      // Resolved BEFORE the re-anchor is planned, because which rows may move
      // depends on what the payload is about to record for each metric.
      const rows = input.baselines === undefined ? [] : await this.resolveBaselineRows(input);

      // The stored newest row per metric, read once and used for THREE decisions
      // below, on BOTH the dated and the dateless path: which rows the re-anchor
      // may move (dated only), which submitted values actually correct their stored
      // newest, and — for a recorded row — the period it lands in (each row carries
      // its own `capturedAt`). A dateless payload must COMPARE too, precisely so an
      // unchanged metric the form dragged along is not rewritten (and a `vsphere`
      // row not flipped to `manual`) merely for being present: that asymmetry —
      // dated compared, dateless wrote everything — was the root of a run of
      // purchasing-critical edge cases, so the two paths are unified here. Loaded
      // whenever the request carries values (`rows`) or a date (`target`); a
      // name/description-only edit needs neither and skips the query.
      const stored =
        rows.length === 0 && target === undefined
          ? new Map<string, NewestBaselineRow>()
          : new Map(
              ((await this.loadNewestBaselines(tenantId, [id])).get(id) ?? []).map((row) => [
                row.metricTypeId,
                row,
              ]),
            );

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
      // right; a request that does carry values re-dates only what it CORRECTS,
      // and only when appending cannot express the edit.
      //
      // @ai-warning Corrects, never merely NAMES. baseline-edit-form.tsx submits
      // every metric it renders the moment any one number is dirty, so presence in
      // `baselines` is not evidence the operator touched that metric — and the
      // form pre-fills its date from `ClusterResponse.baselineDate`, MIN over the
      // newest row per metric, i.e. the STALEST one. Correcting the stale metric
      // and the date therefore arrives here naming a fresher metric whose newest
      // row sits after the target, and re-dating on presence alone drags that
      // fresher measurement backwards onto a date chosen for a different metric —
      // destroying it. Comparing against the stored values is what separates the
      // two: an unchanged metric is untouched, the same rule #181 applies to an
      // OMITTED one.
      //
      // `undefined` vs an EMPTY set is a real distinction, not an accident of
      // types. `undefined` means "no values at all" and takes the date-only
      // re-anchor (every metric may move back onto the target). An empty set means
      // "values were submitted but none changed" — moves nothing and writes
      // nothing, so the request is a no-op beyond the `updatedAt` bump. The form
      // cannot produce the empty-set case (it omits `baselines` entirely when no
      // number is dirty), and treating a contradictory hand-built "all unchanged
      // plus a new date" payload as a no-op is safer than re-dating rows the caller
      // did not actually edit.
      //
      // Keyed on `rows`, not on `input.baselines !== undefined`, so an empty array
      // still degrades to the date-only re-anchor rather than to silence. The
      // schema's `.min(1)` makes that unreachable today, and this is not the place
      // to find out if it is ever relaxed: the silent branch would revert the
      // operator's date edit with a 200, which is the exact failure this method
      // exists to prevent.
      const correcting =
        rows.length === 0
          ? undefined
          : new Set(
              rows
                .filter((row) => correctsStoredValues(row, stored.get(row.metricTypeId)))
                .map((row) => row.metricTypeId),
            );
      const moves =
        target === undefined
          ? []
          : await this.planBaselineReanchor(tenantId, id, [...stored.values()], target, correcting);

      const writes: Prisma.PrismaPromise<unknown>[] = [
        // Runs even when `data` is empty, so a date-only edit still bumps
        // `updatedAt` exactly as it did when baselineDate was a column here.
        this.prisma.cluster.update({ where: { id }, data }),
        // Ordered before the value upserts below so those address a moved row at
        // its NEW period and correct it in place rather than duplicating it.
        //
        // @ai-warning `capturedAt` ONLY. A move re-dates a measurement; it does
        // not re-measure it. The values are still whoever recorded them, so
        // `source` is left exactly as it was — period and provenance are separate
        // facts about one row. Provenance flips to manual when a human overwrites
        // the VALUES, which is what the upsert below does and what the schema's
        // rule ("an admin correcting a bad sync is an explicit overwrite that
        // flips `source` to manual") actually describes.
        //
        // Keeping `source` is safe on much stronger grounds than when this comment
        // was first written, and the grounds have now changed TWICE — recorded
        // rather than quietly rewritten, because both superseded arguments were
        // wrong in ways that shipped:
        //
        //   1. "A backward move only ever NARROWS the date-based boundary, which
        //      is safe." False: the same narrowing that counts more consumption
        //      also re-adds `capacityDelta`s the snapshot already measured.
        //      Narrowing is safe on consumption and unsafe on capacity, so
        //      all-or-nothing absorption has no safe direction to move in.
        //   2. "The flip is forbidden because the SOURCE GATE is the first thing
        //      `absorbed` checks." That WAS true and is now false: `absorbed` does
        //      not read `source` at all, precisely because a value edit flips it.
        //
        // What holds today is simpler and does not depend on either: absorption is
        // a function of `observedAt` alone, and NOTHING on this path writes
        // `observedAt`. So a move changes which deltas are absorbed by exactly
        // zero, in either direction and whatever `source` says.
        //
        // `source` is still left alone here, on its own merits rather than as a
        // forecast safeguard: a move re-dates a measurement, it does not re-measure
        // it, and provenance is what the row's VALUES came from. Pinned by
        // `clusters.test.ts` "a re-dated row keeps its provenance" and, for the
        // boundary itself, by "a re-date cannot move the absorption boundary".
        //
        // `VsphereSnapshotService`'s `skipDuplicates` is ON CONFLICT DO NOTHING on
        // the period unique index and never reads `source`, so no value of this
        // column changes which period it yields. It writes
        // `startOfUtcMonth(measuredAt)` — the current month — and a backward move
        // only ever VACATES the period it left.
        ...moves.map((move) =>
          this.prisma.clusterBaselineHistory.update({
            where: { id: move.id },
            data: { capturedAt: move.capturedAt },
          }),
        ),
      ];

      // THE UNIFORM INVARIANT, now identical on both paths: only a metric whose
      // submitted values differ from its stored newest is written — at the dated
      // target, or (dateless) at its own newest period — and only such a write
      // flips source to manual; a pure re-date moves a row's period without
      // touching its source or values.
      //
      // @ai-warning The write side of "presence is not a correction", load-bearing
      // rather than tidy, and SYMMETRIC across dated and dateless — the earlier
      // `target === undefined ? rows : filtered` split wrote every named metric on
      // the dateless path and was the root of a run of purchasing-critical edge
      // cases. baseline-edit-form.tsx submits every rendered metric the moment any
      // one number is dirty, so presence in `rows` is not evidence the operator
      // touched that metric. Writing an unchanged one anyway is destructive in two
      // directions, and BOTH are reachable dateless as well as dated:
      //   - a same-period write onto that metric's own `vsphere` row flips `source`
      //     to `manual` and rewrites its VALUES with numbers the operator never
      //     touched, overwriting a real vCenter measurement in place; and
      //   - a before-period write drops the metric's fresher numbers onto an older
      //     recorded period.
      //
      // The forecast consequence that used to head this list is GONE and is
      // recorded rather than deleted: "the flip stops `absorbed` absorbing a
      // pre-anchor `capacityDelta`, so capacity inflates and utilization falls."
      // That was true while `absorbed` was SOURCE-gated. It no longer is — the gate
      // is `observedAt`, which no edit path writes — so a `source` flip changes no
      // forecast number at all. The rule survives on the two data-loss consequences
      // above, which never involved absorption.
      // So an unchanged metric is treated EXACTLY like an omitted one (#181),
      // whether or not a date was submitted — not written at all. A corrected
      // metric still writes: at the target (landing the submitted date on the
      // response's MIN so the form does not reset it) or, dateless, in place on the
      // period it corrects. A metric with no stored row has nothing to repeat, so
      // its first baseline is new information and still writes (at the current
      // month, below). `correcting` is undefined only when `rows` is empty, where
      // this filter is over nothing.
      const recording = rows.filter((row) => correcting?.has(row.metricTypeId) ?? false);

      if (recording.length > 0) {
        // The period a manual entry lands in: the supplied baselineDate when the
        // caller changed it, otherwise THAT METRIC's own newest recorded period —
        // read straight off `stored`, the newest-per-metric map already loaded
        // above, whose row carries that period in `capturedAt`. Snapped to the
        // first of the month so manual and vSphere baselines share one period key
        // (recorded decision Q6) — without which a manual row at Aug-15 and a
        // snapshot at Aug-01 would coexist and "the newest baseline" would be
        // decided by accident of date; the snap is defensive, since every stored
        // `capturedAt` is already a first-of-month anchor.
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
        // `deriveBaselineDate`'s MIN exists to report. Per metric — off `stored` —
        // each correction lands on the period it is actually correcting and the
        // upsert updates in place. (`stored` subsumes the old per-metric-MAX query,
        // whose result was a strict subset of what it already carries.)
        //
        // A metric with no stored row has no period to correct, so the current
        // month opens its first one.
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
          ...recording.map((row) => {
            // dated -> the target; dateless -> this metric's own newest period, or
            // the opening month if it has no stored row (its first baseline).
            const storedRow = stored.get(row.metricTypeId);
            const capturedAt =
              target ?? (storedRow ? startOfUtcMonth(storedRow.capturedAt) : openingPeriod);
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
   * A row is moved only when there is no honest alternative, so `correcting`
   * decides far more than it looks:
   *
   * - `undefined` — the request carries NO values, so the direction decides. Only
   *   a target EARLIER than a metric's newest row is expressible: nothing can be
   *   appended, and the row is at a period later than the one the operator says it
   *   was captured in, so re-dating it is the honest reading. A LATER target is
   *   refused (BASELINE_PERIOD_NOT_MEASURED) rather than moved — see the refusal
   *   below. Dragging a row forward is exactly the "fabricating a measurement
   *   nobody took" this branch exists to avoid, not an alternative to it.
   * - a set — the request carries values, and only the metrics whose values it
   *   CORRECTS may move. Naming is not correcting: the form submits every rendered
   *   metric once any one number is dirty, so the set is built by comparing each
   *   submitted pair against that metric's stored newest row. An omitted metric
   *   must be untouched (#181, same rule the upsert follows) and an unchanged one
   *   is the same case wearing the form's clothes — re-dating a row the operator
   *   never touched is exactly the silent edit that principle exists to prevent,
   *   and it lands on the metric the form pre-filled the date FROM being the
   *   stalest, so the fresher measurement is the one destroyed. Of the corrected
   *   metrics, one whose target is LATER than its newest row is recording an
   *   ordinary new monthly measurement — the upsert appends it and the older rows
   *   stay, which is what epic #172 exists to accumulate, so moving instead would
   *   delete a measurement on every forward-dated save. That leaves the genuine
   *   case: a target EARLIER than the metric's newest row, where appending would
   *   leave the OLD row newest, so the response would echo neither the submitted
   *   date nor the submitted values and the form would reset both away.
   *
   * The refusal has to be phrased as "would this reorder?", not "is the target
   * period taken?". The narrow version reads plausible — the moving row is a
   * metric's newest, so nothing sits after it — and is wrong for every target
   * earlier than some OTHER recorded row: re-dating July's 300 onto a free April,
   * behind an existing May of 100, leaves history reading Apr=300, May=100 — the
   * July measurement plotted at April and a 300 -> 100 drop nobody measured, on a
   * chart that feeds hardware purchasing. Refusing on `capturedAt >= target`
   * covers both shapes (`==` the occupied case, `>` the reordering one), leaving
   * one invariant: a moved row stays the newest row for its metric.
   *
   * ONE EXCEPTION, added after the refusal was found to be unsatisfiable. When the
   * request carries VALUES and EVERY metric that would move is already holding the
   * target period with one of its own rows, nothing needs to move — the upsert
   * corrects those rows in place. Refusing there told the operator to "edit that
   * period directly", an operation the API does not offer, which made correcting an
   * already-recorded historical period impossible. See `occupyingTarget` below for
   * why the exception is confined to value-carrying requests, why it is ALL-OR-
   * NOTHING across the request rather than per metric, and why it leaves the
   * invariant intact.
   *
   * The occupancy CHECK is per metric, because the unique key is (cluster, metric,
   * period). A cluster-wide check would refuse the legitimate edit where one metric
   * already sits on the target and another is moving onto it. The exception built on
   * top of it is not per metric — a mixed request, where some metrics correct in
   * place and others must move, is refused whole.
   */
  private async planBaselineReanchor(
    tenantId: string,
    clusterId: string,
    /** The newest row per metric, read by the caller — see `stored` in `update`. */
    newest: readonly NewestBaselineRow[],
    target: Date,
    correcting: ReadonlySet<string> | undefined,
  ): Promise<Array<{ id: string; capturedAt: Date }>> {
    // A date-only request onto a period LATER than a metric's newest row has no
    // honest interpretation, so it is refused before anything is planned.
    //
    // @ai-warning Refused PER REQUEST, never per metric. A cluster whose metrics
    // sit at different periods (the normal case — the snapshot job writes
    // memory_gb only) can have one metric legally moving back onto the target
    // while another would have to move forward. Applying the legal half is worse
    // than refusing: `ClusterResponse.baselineDate` is MIN over newest-per-metric,
    // so the response still reports the un-moved metric's older period, the
    // operator's submitted date is echoed back changed, and baseline-edit-form.tsx
    // resets it away — a silent partial write with a 200 OK.
    //
    // Moving forward instead would be silent in two purchasing-visible ways, both
    // erring the same way (defer hardware that is needed): the moved row occupies
    // the current period, where VsphereSnapshotService's `skipDuplicates` drops
    // the month's real measurement in its favour; and a metric that lags by design
    // is dragged forward, clearing the staleness `deriveBaselineDate`'s MIN exists
    // to report without measuring anything.
    //
    // A THIRD consequence used to be listed first and is now GONE, deliberately
    // recorded rather than quietly deleted: "the move writes `capturedAt` only, so
    // a `vsphere` row stays labelled measured and `absorbed` swallows every delta
    // dated at or before the NEW anchor — consumption measured after the capture
    // simply disappears." That was true while the boundary was `capturedAt`. It no
    // longer is: `absorbed` keys off `observedAt`, which this move does not write,
    // so a forward move cannot make absorption swallow anything extra. The refusal
    // stands on the two surviving consequences, which never involved the forecast
    // boundary at all.
    if (correcting === undefined) {
      // NOTHING RECORDED AT ALL. `unmeasured` below is empty here — there is no row
      // to be earlier than the target — so this used to fall through to an empty
      // `moving`, an empty write list, and a 200 OK with the submitted date
      // silently discarded (the response still reporting `startOfUtcMonth(
      // createdAt)`). The identical intent on a cluster WITH history is a loud 422,
      // and two requests answering differently because of state the operator cannot
      // see is not a distinction worth keeping. Refuse both, in the same terms.
      //
      // @ai-warning Reachable ONLY with no values submitted. A dated payload that
      // CARRIES values on a history-less cluster is recording a first measurement
      // at that period — new information, not a re-date — and `correcting` is a
      // full set there, so it never enters this branch and still writes.
      if (newest.length === 0) {
        const period = formatDate(target).slice(0, 7);
        throw new UnprocessableError(
          'BASELINE_PERIOD_NOT_MEASURED',
          `No baseline is recorded for this cluster, so there is no measurement to re-date onto ` +
            `${period}. Changing the date alone moves an existing measurement; it cannot create ` +
            `one. To record a baseline for ${period}, submit the values for it.`,
        );
      }

      const unmeasured = newest.filter((row) => row.capturedAt < target);
      if (unmeasured.length > 0) {
        const period = formatDate(target).slice(0, 7);
        const keys = unmeasured.map((row) => row.metricType.key).join(', ');
        throw new UnprocessableError(
          'BASELINE_PERIOD_NOT_MEASURED',
          `No ${keys} baseline is recorded at or after ${period}, so there is no measurement ` +
            `to re-date onto that period. Changing the date alone moves an existing ` +
            `measurement; it cannot create one. To record a baseline for ${period}, submit the ` +
            `values for it — that appends a new measurement instead of moving one.`,
        );
      }
    }

    // Backwards only, in BOTH branches: a target later than a metric's newest row
    // is an ordinary new monthly measurement, which the upsert appends (epic #172
    // exists to accumulate those) — moving instead would delete a measurement on
    // every forward-dated save. `> target` subsumes the equality case, which is
    // the cluster already anchored where the operator says it is: unchanged.
    const moving = newest.filter(
      (row) =>
        row.capturedAt > target && (correcting === undefined || correcting.has(row.metricTypeId)),
    );
    // Nothing to move covers four cases, and all are no-ops rather than writes: a
    // cluster already anchored on the submitted period is simply unchanged, a
    // metric the payload omitted stays untouched, a metric the payload repeats
    // unchanged is untouched for the same reason, and a corrected metric recording
    // a later period is appended rather than re-dated.
    //
    // The fifth case this list used to carry — "a synced cluster between import and
    // its first snapshot has no row to re-date" — is GONE and recorded rather than
    // deleted. It is no longer a no-op: a DATE-ONLY request there is refused above,
    // because a 200 that discards the operator's date is not a no-op from the
    // caller's side. A dated request carrying VALUES still reaches here and still
    // writes, via `recording` rather than via a move.
    if (moving.length === 0) return [];

    // The moving rows themselves are excluded: a backwards move starts from a
    // period later than the target, so it would otherwise block itself.
    const conflicts = await this.prisma.clusterBaselineHistory.findMany({
      where: {
        clusterId,
        tenantId,
        metricTypeId: { in: moving.map((row) => row.metricTypeId) },
        capturedAt: { gte: target },
        id: { notIn: moving.map((row) => row.id) },
      },
      select: { metricTypeId: true, capturedAt: true },
    });

    /** Metrics one of whose OTHER rows sits exactly ON the target period. */
    const occupyingTarget = new Set(
      conflicts
        .filter((row) => row.capturedAt.getTime() === target.getTime())
        .map((row) => row.metricTypeId),
    );

    // THE IN-PLACE CORRECTION. When the request CORRECTS a metric and that
    // metric's target period is already held by one of its own rows, there is
    // nothing to move: the upsert in `update` addresses `target` directly and
    // updates that row in place, non-destructively. Refusing instead produced a
    // 422 telling the operator to "edit that period directly" — an operation this
    // API does not offer — so correcting an already-recorded historical period was
    // simply impossible.
    //
    // @ai-warning Scoped to `correcting !== undefined`, and that scope IS the
    // safety argument. A DATE-ONLY request has no values to land, so skipping the
    // move there would turn the refusal into a silent 200 that discards the
    // operator's date — the exact failure class this method exists to prevent.
    // Only a request that will actually WRITE at `target` may decline to move onto
    // it.
    //
    // It does not re-open the reordering defect the refusal exists for. That
    // defect needs a MOVE onto a FREE period behind an older row (re-dating July's
    // 300 onto a free April behind an existing May of 100, leaving Apr=300,
    // May=100 — a drop nobody measured). Here nothing moves at all, so the
    // invariant "a moved row stays the newest row for its metric" holds vacuously,
    // and a free target is still checked by the loop below exactly as before.
    //
    // @ai-warning ALL-OR-NOTHING across the request, never per metric — because the
    // refusal it defers to is itself per REQUEST (see the @ai-warning at the top of
    // this method). The exclusion was first written as a per-metric
    // `moving.filter(row => !occupyingTarget.has(row.metricTypeId))`, and that
    // filter runs BEFORE the block loop, so an excluded metric never reaches the
    // check while every OTHER metric proceeds: the request half-applies with a
    // 200 OK. Concretely, on a cluster holding memory at March=100 and July=900
    // (newest) plus cpu at July only, a March-dated correction of both re-dated cpu
    // and corrected memory's March row, while memory's July row stayed put AND
    // STAYED NEWEST — so the response served the old 900, the operator's 950 never
    // anchored the forecast, and `baselineDate` = MIN(March, March) echoed the
    // submitted date back and falsely confirmed the save. Applying the legal half
    // is worse than refusing, exactly as the per-request warning above says.
    //
    // Taking the exclusion only when it covers EVERY moving metric leaves the block
    // loop to refuse the whole mixed request, and keeps the case the exclusion was
    // added for — where there is no legal half left behind, because nothing moves at
    // all. Pinned from both sides by `clusters.test.ts`: "corrects an already-
    // recorded period IN PLACE", "corrects EVERY metric in place when they all
    // already occupy the target", and "refuses the WHOLE request when only SOME
    // corrected metrics occupy the target".
    //
    // The submitted date is NOT echoed back in this case: `ClusterResponse.
    // baselineDate` is MIN over newest-per-metric, and correcting an older period
    // does not make it the newest one. That is honest rather than a regression —
    // see the MIN caveat in docs/operations.md.
    const moves =
      correcting === undefined
        ? moving
        : moving.every((row) => occupyingTarget.has(row.metricTypeId))
          ? []
          : moving;

    const blockedMetrics = new Set(conflicts.map((row) => row.metricTypeId));

    for (const row of moves) {
      if (blockedMetrics.has(row.metricTypeId)) {
        throw new UnprocessableError(
          'BASELINE_PERIOD_OCCUPIED',
          `A ${row.metricType.key} baseline is already recorded at or after ` +
            `${formatDate(target).slice(0, 7)}; re-dating onto it would overwrite or reorder a ` +
            'recorded measurement. Submit the values for that period to correct it in place.',
        );
      }
    }

    return moves.map((row) => ({ id: row.id, capturedAt: target }));
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
    //
    // SCALE CEILING, since `keys` becomes one OR branch per (cluster, metric):
    // bounded by page `limit` x metrics-per-cluster — a few hundred branches on a
    // full fleet page, which Postgres serves from the unique key's btree. It is NOT
    // an N+1 (still two queries however large the page) and, crucially, it does not
    // grow with accumulated history, which is the bound this whole method exists to
    // hold. If the fleet ever outgrows it, replace this with a lateral join or a
    // tuple IN — do not reintroduce a per-cluster query.
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
          // The immutable period the measurement was taken in, and the ONLY input
          // to absorption (`absorbed` in forecast.ts, recorded decision Q9b).
          // forecast-loader has always passed an absorption input; the cluster
          // endpoints could not, because the legacy baseline table had no
          // provenance at all. Reading it off the same history row is what
          // converges them.
          //
          // `capturedAt` above is a label the re-anchor can move and `source` is a
          // flag any value correction flips, so neither may gate this. `observedAt`
          // is written once by VsphereSnapshotService and by nothing else, so
          // neither a date edit nor a value edit can shift which deltas the
          // measurement is deemed to contain. Snapped for the same reason
          // forecast-loader snaps it: both columns come from one `measuredAt`, so
          // this equals `capturedAt` on every row that was never re-dated.
          baselineMeasuredAt: b.observedAt ? startOfUtcMonth(b.observedAt) : null,
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
