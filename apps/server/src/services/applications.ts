import type {
  AllocationResponseRow,
  AllocationRowInput,
  ApplicationCreateInput,
  ApplicationResponse,
  ApplicationUpdateInput,
} from '@lcm/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

import { formatDate } from '../lib/dates.js';

import { ConflictError, NotFoundError, UnprocessableError } from './errors.js';

const PRISMA_UNIQUE_CONSTRAINT = 'P2002';

const applicationInclude = {
  allocations: {
    include: { metricType: true },
    orderBy: [{ metricType: { key: 'asc' as const } }, { effectiveFrom: 'asc' as const }],
  },
} satisfies Prisma.ApplicationInclude;

type ApplicationRow = Prisma.ApplicationGetPayload<{ include: typeof applicationInclude }>;

export class ApplicationsService {
  constructor(private readonly prisma: PrismaClient) {}

  async listByCluster(tenantId: string, clusterId: string): Promise<ApplicationResponse[]> {
    await this.assertClusterExists(tenantId, clusterId);
    const rows = await this.prisma.application.findMany({
      where: { tenantId, clusterId },
      include: applicationInclude,
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => this.toResponse(row));
  }

  async getById(tenantId: string, id: string): Promise<ApplicationResponse> {
    const row = await this.prisma.application.findFirst({
      where: { id, tenantId },
      include: applicationInclude,
    });
    if (!row) {
      throw new NotFoundError('Application', id);
    }
    return this.toResponse(row);
  }

  async create(
    tenantId: string,
    clusterId: string,
    input: ApplicationCreateInput,
  ): Promise<ApplicationResponse> {
    await this.assertClusterExists(tenantId, clusterId);
    this.validateInitialAllocations(input);

    const metricTypes = await this.resolveMetricTypes(
      input.allocations.map((a) => a.metricTypeKey),
    );

    try {
      const created = await this.prisma.application.create({
        data: {
          tenantId,
          clusterId,
          name: input.name,
          category: input.category,
          description: input.description ?? null,
          startedAt: input.startedAt,
          endedAt: input.endedAt ?? null,
          allocations: {
            create: input.allocations.map((a) => {
              const metricType = metricTypes.get(a.metricTypeKey);
              if (!metricType) {
                throw new UnprocessableError('UNKNOWN_METRIC', `Unknown metric ${a.metricTypeKey}`);
              }
              return {
                tenantId,
                metricTypeId: metricType.id,
                effectiveFrom: a.effectiveFrom,
                amount: new Prisma.Decimal(a.amount),
              };
            }),
          },
        },
        include: applicationInclude,
      });
      return this.toResponse(created);
    } catch (err) {
      this.translatePrismaError(err);
      throw err;
    }
  }

  async update(
    tenantId: string,
    id: string,
    input: ApplicationUpdateInput,
  ): Promise<ApplicationResponse> {
    const existing = await this.prisma.application.findFirst({
      where: { id, tenantId },
      include: { allocations: { select: { effectiveFrom: true } } },
    });
    if (!existing) {
      throw new NotFoundError('Application', id);
    }

    const data: Prisma.ApplicationUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.category !== undefined) data.category = input.category;
    if (input.description !== undefined) data.description = input.description ?? null;
    if (input.startedAt !== undefined) {
      const earliest = existing.allocations.reduce<Date | null>(
        (min, row) => (min === null || row.effectiveFrom < min ? row.effectiveFrom : min),
        null,
      );
      if (earliest !== null && input.startedAt > earliest) {
        throw new UnprocessableError(
          'INVALID_STARTED_AT',
          'startedAt cannot be after the earliest allocation row',
        );
      }
      data.startedAt = input.startedAt;
    }
    if (input.endedAt !== undefined) {
      data.endedAt = input.endedAt;
    }

    await this.prisma.application.update({ where: { id }, data });
    return this.getById(tenantId, id);
  }

  async appendAllocation(
    tenantId: string,
    id: string,
    input: AllocationRowInput,
  ): Promise<ApplicationResponse> {
    const application = await this.prisma.application.findFirst({
      where: { id, tenantId },
      include: { allocations: { include: { metricType: true } } },
    });
    if (!application) {
      throw new NotFoundError('Application', id);
    }

    if (input.effectiveFrom < application.startedAt) {
      throw new UnprocessableError(
        'EFFECTIVE_BEFORE_START',
        'effectiveFrom must be on or after the application startedAt date',
      );
    }

    const metricType = (await this.resolveMetricTypes([input.metricTypeKey])).get(
      input.metricTypeKey,
    );
    if (!metricType) {
      throw new UnprocessableError('UNKNOWN_METRIC', `Unknown metric ${input.metricTypeKey}`);
    }

    const latestForMetric = application.allocations
      .filter((a) => a.metricType.key === input.metricTypeKey)
      .reduce<Date | null>(
        (max, row) => (max === null || row.effectiveFrom > max ? row.effectiveFrom : max),
        null,
      );

    if (latestForMetric !== null && input.effectiveFrom <= latestForMetric) {
      throw new UnprocessableError(
        'EFFECTIVE_NOT_MONOTONIC',
        'effectiveFrom must be strictly after the latest existing allocation row for this metric',
      );
    }

    try {
      await this.prisma.applicationMetricAllocation.create({
        data: {
          applicationId: id,
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
    const result = await this.prisma.application.deleteMany({ where: { id, tenantId } });
    if (result.count === 0) {
      throw new NotFoundError('Application', id);
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

  private validateInitialAllocations(input: ApplicationCreateInput): void {
    const byMetric = new Map<string, Date[]>();
    for (const row of input.allocations) {
      if (row.effectiveFrom < input.startedAt) {
        throw new UnprocessableError(
          'EFFECTIVE_BEFORE_START',
          `Allocation for ${row.metricTypeKey} has effectiveFrom before startedAt`,
        );
      }
      const dates = byMetric.get(row.metricTypeKey) ?? [];
      dates.push(row.effectiveFrom);
      byMetric.set(row.metricTypeKey, dates);
    }
    for (const [metric, dates] of byMetric) {
      const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const current = sorted[i];
        if (prev && current && current <= prev) {
          throw new UnprocessableError(
            'EFFECTIVE_NOT_MONOTONIC',
            `Allocation rows for ${metric} must have strictly increasing effectiveFrom`,
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

  private toResponse(row: ApplicationRow): ApplicationResponse {
    const allocations: AllocationResponseRow[] = row.allocations.map((a) => ({
      id: a.id,
      metricTypeKey: a.metricType.key,
      metricTypeDisplayName: a.metricType.displayName,
      unit: a.metricType.unit,
      effectiveFrom: formatDate(a.effectiveFrom),
      amount: a.amount.toNumber(),
    }));

    return {
      id: row.id,
      clusterId: row.clusterId,
      name: row.name,
      category: row.category,
      description: row.description,
      startedAt: formatDate(row.startedAt),
      endedAt: row.endedAt ? formatDate(row.endedAt) : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      allocations,
    };
  }

  private translatePrismaError(err: unknown): void {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === PRISMA_UNIQUE_CONSTRAINT
    ) {
      throw new ConflictError(
        'ALLOCATION_DUPLICATE_DATE',
        'An allocation row already exists for this application/metric on that effective date',
      );
    }
  }
}
