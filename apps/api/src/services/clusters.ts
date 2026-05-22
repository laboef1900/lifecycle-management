import { Prisma, type PrismaClient } from '@prisma/client';

import { formatDate } from '../schemas/common.js';
import type {
  ClusterCreateInput,
  ClusterResponse,
  ClusterUpdateInput,
  MetricStateResponse,
} from '../schemas/cluster.js';

import { ConflictError, NotFoundError, UnprocessableError } from './errors.js';

const PRISMA_UNIQUE_CONSTRAINT = 'P2002';

const clusterInclude = {
  baselines: {
    include: { metricType: true },
    orderBy: { metricType: { key: 'asc' as const } },
  },
} satisfies Prisma.ClusterInclude;

type ClusterRow = Prisma.ClusterGetPayload<{ include: typeof clusterInclude }>;

export class ClustersService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(tenantId: string): Promise<ClusterResponse[]> {
    const rows = await this.prisma.cluster.findMany({
      where: { tenantId },
      include: clusterInclude,
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => this.toResponse(row));
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
        },
        include: clusterInclude,
      });
      return this.toResponse(created);
    } catch (err) {
      this.translatePrismaError(err, input.name);
      throw err;
    }
  }

  async update(tenantId: string, id: string, input: ClusterUpdateInput): Promise<ClusterResponse> {
    const existing = await this.prisma.cluster.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundError('Cluster', id);
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
        await this.prisma.$transaction([
          this.prisma.cluster.update({ where: { id }, data }),
          this.prisma.clusterMetricBaseline.deleteMany({ where: { clusterId: id } }),
          this.prisma.clusterMetricBaseline.createMany({
            data: input.baselines.map((b) => {
              const metricType = metricTypes.get(b.metricTypeKey);
              if (!metricType) {
                throw new UnprocessableError('UNKNOWN_METRIC', `Unknown metric ${b.metricTypeKey}`);
              }
              return {
                clusterId: id,
                tenantId,
                metricTypeId: metricType.id,
                baselineConsumption: new Prisma.Decimal(b.baselineConsumption),
                baselineCapacity: new Prisma.Decimal(b.baselineCapacity),
              };
            }),
          }),
        ]);
      } else if (Object.keys(data).length > 0) {
        await this.prisma.cluster.update({ where: { id }, data });
      }
    } catch (err) {
      this.translatePrismaError(err, input.name ?? '');
      throw err;
    }

    return this.getById(tenantId, id);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const result = await this.prisma.cluster.deleteMany({ where: { id, tenantId } });
    if (result.count === 0) {
      throw new NotFoundError('Cluster', id);
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

  private toResponse(row: ClusterRow): ClusterResponse {
    const metrics: MetricStateResponse[] = row.baselines.map((b) => {
      const baselineConsumption = b.baselineConsumption.toNumber();
      const baselineCapacity = b.baselineCapacity.toNumber();
      // TODO(#8): include host capacity, application allocation, and event deltas
      //           in effect at "today". For now the current state equals the baseline.
      const currentConsumption = baselineConsumption;
      const currentCapacity = baselineCapacity;
      const utilization = currentCapacity === 0 ? 0 : currentConsumption / currentCapacity;
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
      metrics,
    };
  }

  private translatePrismaError(err: unknown, name: string): void {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === PRISMA_UNIQUE_CONSTRAINT
    ) {
      throw new ConflictError(
        'CLUSTER_NAME_TAKEN',
        `A cluster named "${name}" already exists in this tenant`,
      );
    }
  }
}
