import { Prisma, type PrismaClient } from '@prisma/client';

import { formatDate } from '../schemas/common.js';
import {
  hasPayloadOrIsNote,
  type EventCategory,
  type EventCreateInput,
  type EventResponse,
  type EventUpdateInput,
} from '../schemas/event.js';

import { NotFoundError, UnprocessableError } from './errors.js';

const eventInclude = {
  metricType: true,
} satisfies Prisma.EventInclude;

type EventRow = Prisma.EventGetPayload<{ include: typeof eventInclude }>;

export class EventsService {
  constructor(private readonly prisma: PrismaClient) {}

  async listByCluster(tenantId: string, clusterId: string): Promise<EventResponse[]> {
    await this.assertClusterExists(tenantId, clusterId);
    const rows = await this.prisma.event.findMany({
      where: { tenantId, clusterId },
      include: eventInclude,
      orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((row) => this.toResponse(row));
  }

  async getById(tenantId: string, id: string): Promise<EventResponse> {
    const row = await this.prisma.event.findFirst({
      where: { id, tenantId },
      include: eventInclude,
    });
    if (!row) {
      throw new NotFoundError('Event', id);
    }
    return this.toResponse(row);
  }

  async create(
    tenantId: string,
    clusterId: string,
    input: EventCreateInput,
  ): Promise<EventResponse> {
    await this.assertClusterExists(tenantId, clusterId);
    const metricType = await this.resolveMetricType(input.metricTypeKey);

    const created = await this.prisma.event.create({
      data: {
        tenantId,
        clusterId,
        metricTypeId: metricType.id,
        effectiveDate: input.effectiveDate,
        category: input.category,
        title: input.title,
        description: input.description ?? null,
        consumptionDelta:
          input.consumptionDelta !== null && input.consumptionDelta !== undefined
            ? new Prisma.Decimal(input.consumptionDelta)
            : null,
        capacityDelta:
          input.capacityDelta !== null && input.capacityDelta !== undefined
            ? new Prisma.Decimal(input.capacityDelta)
            : null,
      },
      include: eventInclude,
    });
    return this.toResponse(created);
  }

  async update(tenantId: string, id: string, input: EventUpdateInput): Promise<EventResponse> {
    const existing = await this.prisma.event.findFirst({
      where: { id, tenantId },
    });
    if (!existing) {
      throw new NotFoundError('Event', id);
    }

    const data: Prisma.EventUpdateInput = {};
    if (input.effectiveDate !== undefined) data.effectiveDate = input.effectiveDate;
    if (input.category !== undefined) data.category = input.category;
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description ?? null;
    if (input.consumptionDelta !== undefined) {
      data.consumptionDelta =
        input.consumptionDelta === null ? null : new Prisma.Decimal(input.consumptionDelta);
    }
    if (input.capacityDelta !== undefined) {
      data.capacityDelta =
        input.capacityDelta === null ? null : new Prisma.Decimal(input.capacityDelta);
    }
    if (input.metricTypeKey !== undefined) {
      const metricType = await this.resolveMetricType(input.metricTypeKey);
      data.metricType = { connect: { id: metricType.id } };
    }

    const merged = {
      category: (input.category ?? existing.category) as EventCategory,
      consumptionDelta:
        input.consumptionDelta !== undefined
          ? input.consumptionDelta
          : existing.consumptionDelta === null
            ? null
            : existing.consumptionDelta.toNumber(),
      capacityDelta:
        input.capacityDelta !== undefined
          ? input.capacityDelta
          : existing.capacityDelta === null
            ? null
            : existing.capacityDelta.toNumber(),
    };

    if (!hasPayloadOrIsNote(merged)) {
      throw new UnprocessableError(
        'EVENT_REQUIRES_PAYLOAD',
        "At least one delta must be non-null unless category is 'note'",
      );
    }

    await this.prisma.event.update({ where: { id }, data });
    return this.getById(tenantId, id);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const result = await this.prisma.event.deleteMany({ where: { id, tenantId } });
    if (result.count === 0) {
      throw new NotFoundError('Event', id);
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

  private async resolveMetricType(
    key: string,
  ): Promise<{ id: string; key: string; displayName: string; unit: string }> {
    const row = await this.prisma.metricType.findUnique({ where: { key } });
    if (!row) {
      throw new UnprocessableError('UNKNOWN_METRIC', `Unknown metric ${key}`);
    }
    return row;
  }

  private toResponse(row: EventRow): EventResponse {
    return {
      id: row.id,
      clusterId: row.clusterId,
      metricTypeKey: row.metricType.key,
      metricTypeDisplayName: row.metricType.displayName,
      unit: row.metricType.unit,
      effectiveDate: formatDate(row.effectiveDate),
      category: row.category as EventCategory,
      title: row.title,
      description: row.description,
      consumptionDelta: row.consumptionDelta?.toNumber() ?? null,
      capacityDelta: row.capacityDelta?.toNumber() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
