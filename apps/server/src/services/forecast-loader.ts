import type { EventCategory, Scenario } from '@lcm/shared';
import type { PrismaClient } from '@prisma/client';

import { NotFoundError, UnprocessableError } from './errors.js';
import {
  computeForecast,
  type ForecastApplication,
  type ForecastEvent,
  type ForecastHost,
  type ForecastInput,
  type ForecastResult,
} from './forecast.js';
import { projectedDecommissionDate } from './host-projection.js';
import { computeProcurementInfo } from './procurement.js';
import { applyScenario } from './scenario.js';
import { SettingsService } from './settings.js';

const DEFAULT_HORIZON_MONTHS = 24;

interface LoadOptions {
  fromMonth?: Date;
  toMonth?: Date;
}

interface PreparedForecastInput {
  input: ForecastInput;
  fromMonth: Date;
  toMonth: Date;
  effectiveThresholds: Awaited<ReturnType<SettingsService['effectiveFor']>>;
  procurementLeadTimeWeeks: number;
}

export class ForecastService {
  constructor(private readonly prisma: PrismaClient) {}

  async forCluster(
    tenantId: string,
    clusterId: string,
    metricKey: string,
    options: LoadOptions = {},
  ): Promise<ForecastResult> {
    const prepared = await this.prepare(tenantId, clusterId, metricKey, options);
    return this.finalize(prepared, prepared.input);
  }

  /**
   * Same as forCluster but applies a what-if transform between loading and
   * computing. The baseline DB state is never modified — the scenario forecast
   * lives only in this response.
   */
  async forClusterWithScenario(
    tenantId: string,
    clusterId: string,
    metricKey: string,
    scenario: Scenario,
    options: LoadOptions = {},
  ): Promise<ForecastResult> {
    const prepared = await this.prepare(tenantId, clusterId, metricKey, options);
    const scenarioInput = applyScenario(prepared.input, scenario);
    return this.finalize(prepared, scenarioInput);
  }

  private async prepare(
    tenantId: string,
    clusterId: string,
    metricKey: string,
    options: LoadOptions,
  ): Promise<PreparedForecastInput> {
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
            replacedByLinks: {
              include: { new: { select: { commissionedAt: true, state: true } } },
            },
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

    const settingsService = new SettingsService(this.prisma);
    const effectiveThresholds = await settingsService.effectiveFor(tenantId, clusterId);
    const tenantSettings = await settingsService.getTenant(tenantId);

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
      projectedDecommissionAt: projectedDecommissionDate(host),
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

    return {
      input: {
        baselineDate: cluster.baselineDate,
        baselineConsumption: baseline.baselineConsumption.toNumber(),
        baselineCapacity: baseline.baselineCapacity.toNumber(),
        hosts,
        applications,
        events,
      },
      fromMonth,
      toMonth,
      effectiveThresholds,
      procurementLeadTimeWeeks: tenantSettings.procurementLeadTimeWeeks,
    };
  }

  private finalize(prepared: PreparedForecastInput, input: ForecastInput): ForecastResult {
    const computed = computeForecast(input, prepared.fromMonth, prepared.toMonth);
    const procurement = computeProcurementInfo({
      months: computed.months,
      warnFraction: prepared.effectiveThresholds.warn,
      leadTimeWeeks: prepared.procurementLeadTimeWeeks,
    });
    return {
      ...computed,
      effectiveThresholds: prepared.effectiveThresholds,
      procurement,
    };
  }
}

function firstOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}
