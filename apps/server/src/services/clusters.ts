import { startOfUtcMonth } from '@lcm/shared';
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
import { translatePrismaError, type UniqueConstraintMapping } from './prisma-errors.js';
import { assertClusterDeletable, assertSyncedBaselineCapacityZero } from './sync-ownership.js';

function clusterNameTaken(name: string): UniqueConstraintMapping {
  return {
    code: 'CLUSTER_NAME_TAKEN',
    message: `A cluster named "${name}" already exists in this tenant`,
  };
}

const clusterInclude = {
  baselines: {
    include: { metricType: true },
    orderBy: { metricType: { key: 'asc' as const } },
  },
  hosts: {
    include: {
      capacities: true,
      replacedByLinks: { include: { new: { select: { commissionedAt: true, state: true } } } },
    },
  },
  items: { include: { allocations: true } },
} satisfies Prisma.ClusterInclude;

type ClusterRow = Prisma.ClusterGetPayload<{ include: typeof clusterInclude }>;

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
    return {
      items: rows.map((row) => this.toResponse(row)),
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
    return this.toResponse(row);
  }

  async create(tenantId: string, input: ClusterCreateInput): Promise<ClusterResponse> {
    const metricTypes = await this.resolveMetricTypes(input.baselines.map((b) => b.metricTypeKey));

    try {
      const created = await this.prisma.cluster.create({
        data: {
          tenantId,
          name: input.name,
          description: input.description ?? null,
          baselineDate: input.baselineDate,
          baselines: {
            create: input.baselines.map((b) => {
              const metricType = metricTypes.get(b.metricTypeKey);
              if (!metricType) {
                throw new UnprocessableError('UNKNOWN_METRIC', `Unknown metric ${b.metricTypeKey}`);
              }
              return {
                tenantId,
                metricTypeId: metricType.id,
                baselineConsumption: new Prisma.Decimal(b.baselineConsumption),
                baselineCapacity: new Prisma.Decimal(b.baselineCapacity),
              };
            }),
          },
          // DUAL-WRITE (#177). `cluster_baseline_history` is the read side; the
          // `baselines` relation above is the legacy table, retained and written
          // for one release purely so an image rollback stays safe. See the
          // @ai-warning on `writeBaselineHistory`.
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
      return this.toResponse(created);
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
    if (input.baselineDate !== undefined) data.baselineDate = input.baselineDate;

    try {
      if (input.baselines) {
        const metricTypes = await this.resolveMetricTypes(
          input.baselines.map((b) => b.metricTypeKey),
        );
        const rows = input.baselines.map((b) => {
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
        // @ai-warning: upsert per (clusterId, metricTypeId) — never delete-then-recreate.
        // `baselines` is a partial array by contract (`.min(1)`, not "all of them"), so a
        // delete scoped to clusterId destroys the baselines of every metric the caller
        // simply didn't mention. Baselines drive hardware purchasing and this update path
        // is the only writer, so an omitted metric must be untouched, not re-created from
        // a payload that never described it. See #181.
        // The period a manual entry lands in: the supplied baselineDate when the
        // caller changed it, otherwise the cluster's existing one. Snapped to the
        // first of the month so manual and vSphere baselines share one period key
        // (recorded decision Q6) — without which a manual row at Aug-15 and a
        // snapshot at Aug-01 would coexist and "the newest baseline" would be
        // decided by accident of date.
        const current = await this.prisma.cluster.findUniqueOrThrow({
          where: { id },
          select: { baselineDate: true },
        });
        const capturedAt = startOfUtcMonth(input.baselineDate ?? current.baselineDate);

        await this.prisma.$transaction([
          this.prisma.cluster.update({ where: { id }, data }),
          // @ai-warning DUAL-WRITE, deliberate and temporary (#177, decision Q4).
          // `cluster_baseline_history` is the ONLY read side; `cluster_metric_baselines`
          // is written and never read by this code. It exists so that rolling
          // LCM_IMAGE_TAG back to the previous image still finds the data it
          // expects — the rollback window never closes. Do NOT "simplify" by
          // deleting this write until the CONTRACT migration drops the table;
          // doing so silently strands any rollback on stale data.
          //
          // The legacy table mirrors the NEWEST baseline only. A manual edit that
          // backfills an OLDER period must append to history WITHOUT touching it,
          // or the rollback target would show an old value as current.
          ...rows.map((row) =>
            this.prisma.clusterMetricBaseline.upsert({
              where: {
                clusterId_metricTypeId: { clusterId: id, metricTypeId: row.metricTypeId },
              },
              create: { clusterId: id, tenantId, ...row },
              update: {
                baselineConsumption: row.baselineConsumption,
                baselineCapacity: row.baselineCapacity,
              },
            }),
          ),
          // Append-only history. Re-entering a period the admin already recorded
          // is an explicit correction, so it upserts rather than erroring — and
          // flips `source` back to manual, since a human has overridden whatever
          // the sync captured.
          ...rows.map((row) =>
            this.prisma.clusterBaselineHistory.upsert({
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
            }),
          ),
        ]);
      } else if (Object.keys(data).length > 0) {
        await this.prisma.cluster.update({ where: { id }, data });
      }
    } catch (err) {
      translatePrismaError(err, { uniqueConstraint: clusterNameTaken(input.name ?? '') });
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

  private toResponse(row: ClusterRow): ClusterResponse {
    const today = firstOfCurrentMonth();
    const metrics: MetricStateResponse[] = row.baselines.map((b) => {
      const baselineConsumption = b.baselineConsumption.toNumber();
      const baselineCapacity = b.baselineCapacity.toNumber();

      const forecast = computeForecast(
        {
          baselineDate: row.baselineDate,
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
      const utilization = point?.utilization ?? 0;

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
      baselineDate: formatDate(row.baselineDate),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      archivedAt: row.archivedAt?.toISOString() ?? null,
      metrics,
    };
  }
}

function firstOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
