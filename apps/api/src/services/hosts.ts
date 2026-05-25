import type {
  CapacityResponseRow,
  CapacityRowInput,
  HostCreateInput,
  HostResponse,
  HostUpdateInput,
} from '@lcm/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

import { formatDate } from '../lib/dates.js';

import { ConflictError, NotFoundError, UnprocessableError } from './errors.js';
import { projectedDecommissionDate } from './host-projection.js';

const PRISMA_UNIQUE_CONSTRAINT = 'P2002';

const hostInclude = {
  capacities: {
    include: { metricType: true },
    orderBy: [{ metricType: { key: 'asc' as const } }, { effectiveFrom: 'asc' as const }],
  },
  replacedByLinks: { include: { new: { select: { commissionedAt: true } } } },
} satisfies Prisma.HostInclude;

type HostRow = Prisma.HostGetPayload<{ include: typeof hostInclude }>;

export class HostsService {
  constructor(private readonly prisma: PrismaClient) {}

  async listByCluster(tenantId: string, clusterId: string): Promise<HostResponse[]> {
    await this.assertClusterExists(tenantId, clusterId);
    const rows = await this.prisma.host.findMany({
      where: { tenantId, clusterId },
      include: hostInclude,
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => this.toResponse(row));
  }

  async getById(tenantId: string, id: string): Promise<HostResponse> {
    const row = await this.prisma.host.findFirst({
      where: { id, tenantId },
      include: hostInclude,
    });
    if (!row) {
      throw new NotFoundError('Host', id);
    }
    return this.toResponse(row);
  }

  async create(tenantId: string, clusterId: string, input: HostCreateInput): Promise<HostResponse> {
    await this.assertClusterExists(tenantId, clusterId);
    this.validateInitialCapacities(input);

    const metricTypes = await this.resolveMetricTypes(input.capacities.map((c) => c.metricTypeKey));

    try {
      const created = await this.prisma.host.create({
        data: {
          tenantId,
          clusterId,
          name: input.name,
          description: input.description ?? null,
          commissionedAt: input.commissionedAt,
          decommissionedAt: input.decommissionedAt ?? null,
          serialNumber: input.serialNumber ?? null,
          vendor: input.vendor ?? null,
          model: input.model ?? null,
          purchasedAt: input.purchasedAt ?? null,
          warrantyEndsAt: input.warrantyEndsAt ?? null,
          eolAt: input.eolAt ?? null,
          runPastEol: input.runPastEol ?? false,
          capacities: {
            create: input.capacities.map((c) => {
              const metricType = metricTypes.get(c.metricTypeKey);
              if (!metricType) {
                throw new UnprocessableError('UNKNOWN_METRIC', `Unknown metric ${c.metricTypeKey}`);
              }
              return {
                tenantId,
                metricTypeId: metricType.id,
                effectiveFrom: c.effectiveFrom,
                amount: new Prisma.Decimal(c.amount),
              };
            }),
          },
        },
        include: hostInclude,
      });
      return this.toResponse(created);
    } catch (err) {
      this.translatePrismaError(err);
      throw err;
    }
  }

  async update(tenantId: string, id: string, input: HostUpdateInput): Promise<HostResponse> {
    const existing = await this.prisma.host.findFirst({
      where: { id, tenantId },
      include: { capacities: { select: { effectiveFrom: true } } },
    });
    if (!existing) {
      throw new NotFoundError('Host', id);
    }

    const data: Prisma.HostUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description ?? null;
    if (input.commissionedAt !== undefined) {
      const earliest = existing.capacities.reduce<Date | null>(
        (min, cap) => (min === null || cap.effectiveFrom < min ? cap.effectiveFrom : min),
        null,
      );
      if (earliest !== null && input.commissionedAt > earliest) {
        throw new UnprocessableError(
          'INVALID_COMMISSIONED_AT',
          'commissionedAt cannot be after the earliest capacity row',
        );
      }
      data.commissionedAt = input.commissionedAt;
    }
    if (input.decommissionedAt !== undefined) {
      data.decommissionedAt = input.decommissionedAt;
    }
    if (input.serialNumber !== undefined) data.serialNumber = input.serialNumber ?? null;
    if (input.vendor !== undefined) data.vendor = input.vendor ?? null;
    if (input.model !== undefined) data.model = input.model ?? null;
    if (input.purchasedAt !== undefined) data.purchasedAt = input.purchasedAt ?? null;
    if (input.warrantyEndsAt !== undefined) data.warrantyEndsAt = input.warrantyEndsAt ?? null;
    if (input.eolAt !== undefined) data.eolAt = input.eolAt ?? null;
    if (input.runPastEol !== undefined) data.runPastEol = input.runPastEol;

    await this.prisma.host.update({ where: { id }, data });
    return this.getById(tenantId, id);
  }

  async appendCapacity(
    tenantId: string,
    id: string,
    input: CapacityRowInput,
  ): Promise<HostResponse> {
    const host = await this.prisma.host.findFirst({
      where: { id, tenantId },
      include: { capacities: { include: { metricType: true } } },
    });
    if (!host) {
      throw new NotFoundError('Host', id);
    }

    if (input.effectiveFrom < host.commissionedAt) {
      throw new UnprocessableError(
        'EFFECTIVE_BEFORE_COMMISSION',
        'effectiveFrom must be on or after the host commissionedAt date',
      );
    }

    const metricType = (await this.resolveMetricTypes([input.metricTypeKey])).get(
      input.metricTypeKey,
    );
    if (!metricType) {
      throw new UnprocessableError('UNKNOWN_METRIC', `Unknown metric ${input.metricTypeKey}`);
    }

    const latestForMetric = host.capacities
      .filter((c) => c.metricType.key === input.metricTypeKey)
      .reduce<Date | null>(
        (max, cap) => (max === null || cap.effectiveFrom > max ? cap.effectiveFrom : max),
        null,
      );

    if (latestForMetric !== null && input.effectiveFrom <= latestForMetric) {
      throw new UnprocessableError(
        'EFFECTIVE_NOT_MONOTONIC',
        'effectiveFrom must be strictly after the latest existing capacity row for this metric',
      );
    }

    try {
      await this.prisma.hostMetricCapacity.create({
        data: {
          hostId: id,
          tenantId,
          metricTypeId: metricType.id,
          effectiveFrom: input.effectiveFrom,
          amount: new Prisma.Decimal(input.amount),
        },
      });
    } catch (err) {
      this.translatePrismaError(err);
      throw err;
    }

    return this.getById(tenantId, id);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const result = await this.prisma.host.deleteMany({ where: { id, tenantId } });
    if (result.count === 0) {
      throw new NotFoundError('Host', id);
    }
  }

  private async assertClusterExists(tenantId: string, clusterId: string): Promise<void> {
    const cluster = await this.prisma.cluster.findFirst({
      where: { id: clusterId, tenantId },
      select: { id: true },
    });
    if (!cluster) {
      throw new NotFoundError('Cluster', clusterId);
    }
  }

  private validateInitialCapacities(input: HostCreateInput): void {
    const byMetric = new Map<string, Date[]>();
    for (const cap of input.capacities) {
      if (cap.effectiveFrom < input.commissionedAt) {
        throw new UnprocessableError(
          'EFFECTIVE_BEFORE_COMMISSION',
          `Capacity for ${cap.metricTypeKey} has effectiveFrom before commissionedAt`,
        );
      }
      const dates = byMetric.get(cap.metricTypeKey) ?? [];
      dates.push(cap.effectiveFrom);
      byMetric.set(cap.metricTypeKey, dates);
    }
    for (const [metric, dates] of byMetric) {
      const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const current = sorted[i];
        if (prev && current && current <= prev) {
          throw new UnprocessableError(
            'EFFECTIVE_NOT_MONOTONIC',
            `Capacity rows for ${metric} must have strictly increasing effectiveFrom`,
          );
        }
      }
    }
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

  private toResponse(row: HostRow): HostResponse {
    const capacities: CapacityResponseRow[] = row.capacities.map((c) => ({
      id: c.id,
      metricTypeKey: c.metricType.key,
      metricTypeDisplayName: c.metricType.displayName,
      unit: c.metricType.unit,
      effectiveFrom: formatDate(c.effectiveFrom),
      amount: c.amount.toNumber(),
    }));

    const projDecom = projectedDecommissionDate(row);

    return {
      id: row.id,
      clusterId: row.clusterId,
      name: row.name,
      description: row.description,
      commissionedAt: formatDate(row.commissionedAt),
      decommissionedAt: row.decommissionedAt ? formatDate(row.decommissionedAt) : null,
      serialNumber: row.serialNumber,
      vendor: row.vendor,
      model: row.model,
      purchasedAt: row.purchasedAt ? formatDate(row.purchasedAt) : null,
      warrantyEndsAt: row.warrantyEndsAt ? formatDate(row.warrantyEndsAt) : null,
      eolAt: row.eolAt ? formatDate(row.eolAt) : null,
      runPastEol: row.runPastEol,
      state: row.state,
      projectedDecommissionAt: projDecom ? formatDate(projDecom) : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      capacities,
    };
  }

  private translatePrismaError(err: unknown): void {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === PRISMA_UNIQUE_CONSTRAINT
    ) {
      throw new ConflictError(
        'CAPACITY_DUPLICATE_DATE',
        'A capacity row already exists for this host/metric on that effective date',
      );
    }
  }
}
