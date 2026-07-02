import type {
  ItemAllocationResponseRow,
  ItemAllocationRowInput,
  ItemCreateInput,
  ItemResponse,
  ItemUpdateInput,
  Paginated,
} from '@lcm/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

import { formatDate } from '../lib/dates.js';

import { CategoriesService } from './categories.js';
import { ConflictError, NotFoundError, UnprocessableError } from './errors.js';

const PRISMA_UNIQUE_CONSTRAINT = 'P2002';

const itemInclude = {
  allocations: {
    include: { metricType: true },
    orderBy: [{ metricType: { key: 'asc' as const } }, { effectiveFrom: 'asc' as const }],
  },
  metricType: true,
} satisfies Prisma.ItemInclude;

type ItemRow = Prisma.ItemGetPayload<{ include: typeof itemInclude }>;

export class ItemsService {
  private readonly categories: CategoriesService;

  constructor(private readonly prisma: PrismaClient) {
    this.categories = new CategoriesService(this.prisma);
  }

  async listByCluster(
    tenantId: string,
    clusterId: string,
    options: { limit: number; offset: number },
  ): Promise<Paginated<ItemResponse>> {
    await this.assertClusterExists(tenantId, clusterId);
    const where = { tenantId, clusterId };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.item.count({ where }),
      this.prisma.item.findMany({
        where,
        include: itemInclude,
        orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
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

  async getById(tenantId: string, id: string): Promise<ItemResponse> {
    const row = await this.prisma.item.findFirst({
      where: { id, tenantId },
      include: itemInclude,
    });
    if (!row) {
      throw new NotFoundError('Item', id);
    }
    return this.toResponse(row);
  }

  async create(tenantId: string, clusterId: string, input: ItemCreateInput): Promise<ItemResponse> {
    await this.assertClusterExists(tenantId, clusterId);

    // Validation + metric-type reads happen before the transaction; only the
    // item write and the category upsert must commit atomically together.
    let metricTypes: Map<
      string,
      { id: string; key: string; displayName: string; unit: string }
    > | null = null;
    let eventMetricType: { id: string; key: string; displayName: string; unit: string } | null =
      null;
    if (input.kind === 'application') {
      this.validateInitialAllocations(input);
      metricTypes = await this.resolveMetricTypes(input.allocations.map((a) => a.metricTypeKey));
    } else {
      eventMetricType = await this.resolveMetricType(input.metricTypeKey);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      let item: ItemRow;
      if (input.kind === 'application') {
        const resolved = metricTypes!;
        try {
          item = await tx.item.create({
            data: {
              tenantId,
              clusterId,
              kind: 'application',
              name: input.name,
              category: input.category,
              description: input.description ?? null,
              effectiveDate: input.effectiveDate,
              endedAt: input.endedAt ?? null,
              metricTypeId: null,
              allocations: {
                create: input.allocations.map((a) => {
                  const metricType = resolved.get(a.metricTypeKey);
                  if (!metricType) {
                    throw new UnprocessableError(
                      'UNKNOWN_METRIC',
                      `Unknown metric ${a.metricTypeKey}`,
                    );
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
            include: itemInclude,
          });
        } catch (err) {
          this.translatePrismaError(err);
          throw err;
        }
      } else {
        const metricType = eventMetricType!;
        item = await tx.item.create({
          data: {
            tenantId,
            clusterId,
            kind: 'event',
            name: input.name,
            category: input.category,
            description: input.description ?? null,
            effectiveDate: input.effectiveDate,
            metricTypeId: metricType.id,
            consumptionDelta:
              input.consumptionDelta !== null && input.consumptionDelta !== undefined
                ? new Prisma.Decimal(input.consumptionDelta)
                : null,
            capacityDelta:
              input.capacityDelta !== null && input.capacityDelta !== undefined
                ? new Prisma.Decimal(input.capacityDelta)
                : null,
          },
          include: itemInclude,
        });
      }

      await this.categories.ensure(tenantId, input.category, tx);
      return item;
    });

    return this.toResponse(created);
  }

  async update(tenantId: string, id: string, input: ItemUpdateInput): Promise<ItemResponse> {
    const existing = await this.prisma.item.findFirst({
      where: { id, tenantId },
      include: { allocations: { select: { effectiveFrom: true } } },
    });
    if (!existing) {
      throw new NotFoundError('Item', id);
    }

    const data: Prisma.ItemUpdateInput = {};

    // Common fields.
    if (input.name !== undefined) data.name = input.name;
    if (input.category !== undefined) data.category = input.category;
    if (input.description !== undefined) data.description = input.description ?? null;
    if (input.effectiveDate !== undefined) {
      if (existing.kind === 'application') {
        const earliest = existing.allocations.reduce<Date | null>(
          (min, row) => (min === null || row.effectiveFrom < min ? row.effectiveFrom : min),
          null,
        );
        if (earliest !== null && input.effectiveDate > earliest) {
          throw new UnprocessableError(
            'INVALID_EFFECTIVE_DATE',
            'effectiveDate cannot be after the earliest allocation row',
          );
        }
      }
      data.effectiveDate = input.effectiveDate;
    }

    // Application-only fields.
    if (input.endedAt !== undefined) {
      if (existing.kind !== 'application') {
        throw new UnprocessableError(
          'WRONG_KIND_FIELD',
          'endedAt can only be set on application items',
        );
      }
      data.endedAt = input.endedAt;
    }

    // Event-only fields.
    if (input.metricTypeKey !== undefined) {
      if (existing.kind !== 'event') {
        throw new UnprocessableError(
          'WRONG_KIND_FIELD',
          'metricTypeKey can only be set on event items',
        );
      }
      const metricType = await this.resolveMetricType(input.metricTypeKey);
      data.metricType = { connect: { id: metricType.id } };
    }
    if (input.consumptionDelta !== undefined) {
      if (existing.kind !== 'event') {
        throw new UnprocessableError(
          'WRONG_KIND_FIELD',
          'consumptionDelta can only be set on event items',
        );
      }
      data.consumptionDelta =
        input.consumptionDelta === null ? null : new Prisma.Decimal(input.consumptionDelta);
    }
    if (input.capacityDelta !== undefined) {
      if (existing.kind !== 'event') {
        throw new UnprocessableError(
          'WRONG_KIND_FIELD',
          'capacityDelta can only be set on event items',
        );
      }
      data.capacityDelta =
        input.capacityDelta === null ? null : new Prisma.Decimal(input.capacityDelta);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.item.update({ where: { id }, data });
      if (input.category !== undefined) {
        await this.categories.ensure(tenantId, input.category, tx);
      }
    });

    return this.getById(tenantId, id);
  }

  async appendAllocation(
    tenantId: string,
    id: string,
    input: ItemAllocationRowInput,
  ): Promise<ItemResponse> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const item = await tx.item.findFirst({
            where: { id, tenantId },
            include: { allocations: { include: { metricType: true } } },
          });
          if (!item) {
            throw new NotFoundError('Item', id);
          }
          if (item.kind !== 'application') {
            throw new UnprocessableError(
              'NOT_AN_APPLICATION',
              'Allocations can only be appended to application items',
            );
          }

          if (input.effectiveFrom < item.effectiveDate) {
            throw new UnprocessableError(
              'EFFECTIVE_BEFORE_START',
              'effectiveFrom must be on or after the item effectiveDate',
            );
          }

          const metricType = (await this.resolveMetricTypes([input.metricTypeKey], tx)).get(
            input.metricTypeKey,
          );
          if (!metricType) {
            throw new UnprocessableError('UNKNOWN_METRIC', `Unknown metric ${input.metricTypeKey}`);
          }

          const latestForMetric = item.allocations
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

          await tx.itemAllocation.create({
            data: {
              itemId: id,
              tenantId,
              metricTypeId: metricType.id,
              effectiveFrom: input.effectiveFrom,
              amount: new Prisma.Decimal(input.amount),
            },
          });
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (err) {
      this.translatePrismaError(err);
      throw err;
    }

    return this.getById(tenantId, id);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const result = await this.prisma.item.deleteMany({ where: { id, tenantId } });
    if (result.count === 0) {
      throw new NotFoundError('Item', id);
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

  private validateInitialAllocations(input: {
    effectiveDate: Date;
    allocations: ItemAllocationRowInput[];
  }): void {
    const byMetric = new Map<string, Date[]>();
    for (const row of input.allocations) {
      if (row.effectiveFrom < input.effectiveDate) {
        throw new UnprocessableError(
          'EFFECTIVE_BEFORE_START',
          `Allocation for ${row.metricTypeKey} has effectiveFrom before effectiveDate`,
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

  private async resolveMetricType(
    key: string,
  ): Promise<{ id: string; key: string; displayName: string; unit: string }> {
    const row = await this.prisma.metricType.findUnique({ where: { key } });
    if (!row) {
      throw new UnprocessableError('UNKNOWN_METRIC', `Unknown metric ${key}`);
    }
    return row;
  }

  private async resolveMetricTypes(
    keys: string[],
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<Map<string, { id: string; key: string; displayName: string; unit: string }>> {
    const unique = Array.from(new Set(keys));
    const rows = await tx.metricType.findMany({
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

  private toResponse(row: ItemRow): ItemResponse {
    const allocations: ItemAllocationResponseRow[] = row.allocations.map((a) => ({
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
      kind: row.kind,
      name: row.name,
      category: row.category,
      description: row.description,
      effectiveDate: formatDate(row.effectiveDate),
      endedAt: row.endedAt ? formatDate(row.endedAt) : null,
      metricTypeKey: row.metricType?.key ?? null,
      consumptionDelta: row.consumptionDelta?.toNumber() ?? null,
      capacityDelta: row.capacityDelta?.toNumber() ?? null,
      allocations,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private translatePrismaError(err: unknown): void {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      throw new ConflictError('WRITE_CONFLICT', 'Concurrent write detected; retry the request');
    }
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === PRISMA_UNIQUE_CONSTRAINT
    ) {
      throw new ConflictError(
        'ALLOCATION_DUPLICATE_DATE',
        'An allocation row already exists for this item/metric on that effective date',
      );
    }
  }
}
