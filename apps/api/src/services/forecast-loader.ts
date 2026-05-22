import type { EventCategory } from '@lcm/shared';
import type { PrismaClient } from '@prisma/client';

import { NotFoundError, UnprocessableError } from './errors.js';
import {
  computeForecast,
  type ForecastApplication,
  type ForecastEvent,
  type ForecastHost,
  type ForecastResult,
} from './forecast.js';

const DEFAULT_HORIZON_MONTHS = 24;

interface LoadOptions {
  fromMonth?: Date;
  toMonth?: Date;
}

export class ForecastService {
  constructor(private readonly prisma: PrismaClient) {}

  async forCluster(
    tenantId: string,
    clusterId: string,
    metricKey: string,
    options: LoadOptions = {},
  ): Promise<ForecastResult> {
    const metricType = await this.prisma.metricType.findUnique({ where: { key: metricKey } });
    if (!metricType) {
      throw new UnprocessableError('UNKNOWN_METRIC', `Unknown metric ${metricKey}`);
    }

    const cluster = await this.prisma.cluster.findFirst({
      where: { id: clusterId, tenantId },
      include: {
        baselines: { where: { metricTypeId: metricType.id } },
        hosts: {
          include: {
            capacities: { where: { metricTypeId: metricType.id } },
          },
        },
        applications: {
          include: {
            allocations: { where: { metricTypeId: metricType.id } },
          },
        },
        events: { where: { metricTypeId: metricType.id } },
      },
    });

    if (!cluster) {
      throw new NotFoundError('Cluster', clusterId);
    }

    const baseline = cluster.baselines[0];
    if (!baseline) {
      throw new UnprocessableError(
        'METRIC_NOT_TRACKED',
        `Cluster does not track metric ${metricKey}`,
      );
    }

    const fromMonth = options.fromMonth ?? firstOfMonth(cluster.baselineDate);
    const toMonth = options.toMonth ?? addMonths(fromMonth, DEFAULT_HORIZON_MONTHS);

    const hosts: ForecastHost[] = cluster.hosts.map((host) => ({
      id: host.id,
      name: host.name,
      commissionedAt: host.commissionedAt,
      decommissionedAt: host.decommissionedAt,
      capacities: host.capacities.map((c) => ({
        effectiveFrom: c.effectiveFrom,
        amount: c.amount.toNumber(),
      })),
    }));

    const applications: ForecastApplication[] = cluster.applications.map((app) => ({
      id: app.id,
      name: app.name,
      startedAt: app.startedAt,
      endedAt: app.endedAt,
      allocations: app.allocations.map((a) => ({
        effectiveFrom: a.effectiveFrom,
        amount: a.amount.toNumber(),
      })),
    }));

    const events: ForecastEvent[] = cluster.events.map((e) => ({
      id: e.id,
      effectiveDate: e.effectiveDate,
      category: e.category as EventCategory,
      title: e.title,
      description: e.description,
      consumptionDelta: e.consumptionDelta?.toNumber() ?? null,
      capacityDelta: e.capacityDelta?.toNumber() ?? null,
    }));

    return computeForecast(
      {
        baselineDate: cluster.baselineDate,
        baselineConsumption: baseline.baselineConsumption.toNumber(),
        baselineCapacity: baseline.baselineCapacity.toNumber(),
        hosts,
        applications,
        events,
      },
      fromMonth,
      toMonth,
    );
  }
}

function firstOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}
