import { createHash } from 'node:crypto';

import type {
  ItemAllocationResponseRow,
  ItemAllocationRowInput,
  ItemBulkShiftDatesInput,
  ItemBulkShiftDatesResponse,
  ItemCreateInput,
  ItemDateShift,
  ItemResponse,
  ItemUpdateInput,
  Paginated,
} from '@lcm/shared';
import { hasShiftCollision, isSupportedDate, shiftDateByUnit } from '@lcm/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

import { formatDate } from '../lib/dates.js';

import { CategoriesService } from './categories.js';
import { ConflictError, NotFoundError, UnprocessableError } from './errors.js';
import { IdempotencyService } from './idempotency.js';
import { translatePrismaError, type UniqueConstraintMapping } from './prisma-errors.js';

const ALLOCATION_DUPLICATE: UniqueConstraintMapping = {
  code: 'ALLOCATION_DUPLICATE_DATE',
  message: 'An allocation row already exists for this item/metric on that effective date',
};

const itemInclude = {
  allocations: {
    include: { metricType: true },
    orderBy: [{ metricType: { key: 'asc' as const } }, { effectiveFrom: 'asc' as const }],
  },
  metricType: true,
} satisfies Prisma.ItemInclude;

type ItemRow = Prisma.ItemGetPayload<{ include: typeof itemInclude }>;

/**
 * Ceiling on the total allocation rows one bulk shift may touch. Every row is
 * an individual UPDATE inside one serializable transaction (Prisma cannot
 * express `SET col = col + interval` in `updateMany`), so this bounds how long
 * that transaction can hold its locks.
 */
const MAX_SHIFT_ALLOCATION_ROWS = 1000;

/** How long the bulk-shift transaction may run before Prisma aborts it. */
const BULK_SHIFT_TIMEOUT_MS = 15_000;

/** Recorded on every idempotency-key row this endpoint writes (#263). */
const BULK_SHIFT_ROUTE = 'POST /items/bulk-shift-dates';

interface ShiftedAllocation {
  id: string;
  effectiveFrom: Date;
}

interface ShiftPlan {
  itemId: string;
  effectiveDate: Date;
  endedAt: Date | null;
  /** Ordered so no intermediate state violates the allocation unique index. */
  allocations: ShiftedAllocation[];
}

/**
 * Hashes the LOGICAL request — deduped and sorted `itemIds` paired with
 * `shift` — not the raw payload. `bulkShiftDates` already dedupes itemIds via
 * `Set`, which preserves first-occurrence order; without sorting here, the
 * same set of items submitted in a different order (e.g. a re-rendered
 * selection) would hash differently and a legitimate replay would be
 * misread as a conflict.
 */
function hashBulkShiftRequest(uniqueIds: string[], shift: ItemDateShift): string {
  const normalized = { itemIds: [...uniqueIds].sort(), shift };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Compute one entry's post-shift dates, rejecting anything the write would not
 * survive. Pure — it performs no I/O, so a whole batch can be validated before
 * the first UPDATE.
 */
function planItemShift(row: ItemRow, shift: ItemDateShift): ShiftPlan {
  const move = (date: Date): Date => {
    const shifted = shiftDateByUnit(date, shift.amount, shift.unit);
    if (!isSupportedDate(shifted)) {
      throw new UnprocessableError(
        'SHIFT_DATE_OUT_OF_RANGE',
        `Shifting "${row.name}" by ${shift.amount} ${shift.unit} moves a date outside the supported range`,
      );
    }
    return shifted;
  };

  // @ai-note `shiftDateByUnit` is monotone non-decreasing for a fixed
  // (amount, unit): day-clamping can pull two dates together but never past
  // each other. That is *why* the cascade cannot break an entry's timeline — if
  // effectiveDate was on or before its earliest allocation before the shift, it
  // still is after it, so that invariant needs no separate re-check here.
  const effectiveDate = move(row.effectiveDate);
  const endedAt = row.endedAt === null ? null : move(row.endedAt);

  const shifted = row.allocations.map((allocation) => ({
    id: allocation.id,
    metricTypeId: allocation.metricTypeId,
    effectiveFrom: move(allocation.effectiveFrom),
  }));

  // Monotone, but NOT injective: Jan 29 and Jan 31 both land on Feb 28. That
  // would violate `@@unique([itemId, metricTypeId, effectiveFrom])` *and*
  // silently destroy an allocation step, so refuse instead of writing. The web
  // preview calls this same shared helper, so it can warn before the operator
  // submits rather than after.
  if (
    hasShiftCollision(
      row.allocations.map((allocation) => ({
        metric: allocation.metricTypeId,
        effectiveFrom: allocation.effectiveFrom,
      })),
      shift.amount,
      shift.unit,
    )
  ) {
    throw new UnprocessableError(
      'SHIFT_ALLOCATION_COLLISION',
      `Shifting "${row.name}" by ${shift.amount} ${shift.unit} would collapse two allocation rows onto the same date`,
    );
  }

  // @ai-note The unique index is checked per statement, not deferred to commit,
  // so the *order* of the row updates matters even though the final state is
  // collision-free: shifting {Jan 1, Feb 1} forward by a month would hit the
  // still-unmoved Feb 1 row. A uniform shift is monotone, so moving the entries
  // that travel furthest into open space first — descending for a forward
  // shift, ascending for a backward one — keeps every intermediate state valid.
  const direction = shift.amount > 0 ? -1 : 1;
  shifted.sort((a, b) => direction * (a.effectiveFrom.getTime() - b.effectiveFrom.getTime()));

  return {
    itemId: row.id,
    effectiveDate,
    endedAt,
    allocations: shifted.map(({ id, effectiveFrom }) => ({ id, effectiveFrom })),
  };
}

export class ItemsService {
  private readonly categories: CategoriesService;
  private readonly idempotency: IdempotencyService;

  constructor(private readonly prisma: PrismaClient) {
    this.categories = new CategoriesService(this.prisma);
    this.idempotency = new IdempotencyService(this.prisma);
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
          translatePrismaError(err, { uniqueConstraint: ALLOCATION_DUPLICATE });
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

  /**
   * Move a set of entries by one signed relative offset, all-or-nothing.
   *
   * The shift **cascades** across an entry's whole timeline — `effectiveDate`,
   * every `allocations[*].effectiveFrom`, and `endedAt` when set — by the same
   * delta. That is what keeps the timeline internally consistent: moving only
   * `effectiveDate` could push an application's start past its own first
   * allocation, which `update()` already refuses to do one entry at a time.
   *
   * @ai-note Idempotent via `idempotencyKey` (#263): a replay with an
   * unchanged payload returns the original response and applies nothing; the
   * same key with a different payload is rejected as a 409 conflict and also
   * applies nothing. The idempotency record is written inside this SAME
   * transaction, so it commits or rolls back atomically with the shift.
   *
   * @ai-note A genuine serialization conflict (Postgres 40001) is deliberately
   * NOT retried — it aborts the transaction and surfaces as a sanitized 500,
   * leaving the data untouched. Accepted for a low-concurrency internal tool
   * where two admins bulk-shifting the same entries at once is not a real
   * workload; the failure is safe, just unfriendly. Revisit if that changes.
   */
  async bulkShiftDates(
    tenantId: string,
    input: ItemBulkShiftDatesInput,
    idempotencyKey: string,
  ): Promise<ItemBulkShiftDatesResponse> {
    const uniqueIds = Array.from(new Set(input.itemIds));
    const requestHash = hashBulkShiftRequest(uniqueIds, input.shift);

    return this.prisma.$transaction(
      async (tx) => {
        const cached = await this.idempotency.lookup(idempotencyKey, requestHash, tx);
        if (cached === 'conflict') {
          throw new ConflictError(
            'IDEMPOTENCY_KEY_CONFLICT',
            'This Idempotency-Key was already used for a different request',
          );
        }
        if (cached !== null) {
          // `cached.status` (always 200 today) is intentionally unused here —
          // Fastify defaults the reply to 200. A future second consumer of
          // IdempotencyService that records a non-200 status would need to
          // set the reply code from `cached.status` explicitly.
          return cached.body as ItemBulkShiftDatesResponse;
        }

        const existing = await tx.item.findMany({
          where: { id: { in: uniqueIds }, tenantId },
          include: itemInclude,
        });
        const byId = new Map(existing.map((row) => [row.id, row]));
        for (const id of uniqueIds) {
          if (!byId.has(id)) {
            throw new NotFoundError('Item', id);
          }
        }

        const allocationRows = existing.reduce((sum, row) => sum + row.allocations.length, 0);
        if (allocationRows > MAX_SHIFT_ALLOCATION_ROWS) {
          throw new UnprocessableError(
            'SHIFT_BATCH_TOO_LARGE',
            `A bulk shift may touch at most ${MAX_SHIFT_ALLOCATION_ROWS} allocation rows; this one touches ${allocationRows}`,
          );
        }

        // Plan and validate EVERY entry before writing ANY of them, so an
        // invalid entry costs no write at all rather than relying on rollback.
        const plans = existing.map((row) => planItemShift(row, input.shift));

        for (const plan of plans) {
          await tx.item.update({
            where: { id: plan.itemId },
            data: { effectiveDate: plan.effectiveDate, endedAt: plan.endedAt },
          });
          for (const allocation of plan.allocations) {
            await tx.itemAllocation.update({
              where: { id: allocation.id },
              data: { effectiveFrom: allocation.effectiveFrom },
            });
          }
        }

        const rows = await tx.item.findMany({
          where: { id: { in: uniqueIds }, tenantId },
          include: itemInclude,
          orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
        });
        const response: ItemBulkShiftDatesResponse = {
          shifted: rows.length,
          items: rows.map((row) => this.toResponse(row)),
        };

        await this.idempotency.record(
          {
            key: idempotencyKey,
            route: BULK_SHIFT_ROUTE,
            requestHash,
            status: 200,
            body: response,
            tenantId,
          },
          tx,
        );

        return response;
      },
      { isolationLevel: 'Serializable', timeout: BULK_SHIFT_TIMEOUT_MS },
    );
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
      translatePrismaError(err, { uniqueConstraint: ALLOCATION_DUPLICATE });
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
}
