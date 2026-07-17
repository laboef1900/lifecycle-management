import {
  formatDateIso,
  MAX_FORECAST_SPAN_MONTHS,
  monthsBetweenUtc,
  type BaselineHistoryPoint,
  type Scenario,
} from '@lcm/shared';
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
  baselineHistory: BaselineHistoryPoint[];
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
        baselineHistory: {
          where: { metricTypeId: metricType.id },
          orderBy: { capturedAt: 'asc' },
        },
        hosts: {
          include: {
            capacities: { where: { metricTypeId: metricType.id } },
            replacedByLinks: {
              include: { new: { select: { commissionedAt: true, state: true } } },
            },
          },
        },
        items: {
          where: { OR: [{ metricTypeId: metricType.id }, { metricTypeId: null }] },
          include: { allocations: { where: { metricTypeId: metricType.id } } },
        },
      },
    });

    if (!cluster) {
      throw new NotFoundError('Cluster', clusterId);
    }

    const settingsService = new SettingsService(this.prisma);
    const effectiveThresholds = await settingsService.effectiveFor(tenantId, clusterId);
    const tenantSettings = await settingsService.getTenant(tenantId);

    // @ai-warning Anchor on the NEWEST baseline, unconditionally — `history` is
    // ordered `capturedAt: 'asc'`, so the anchor is the last element.
    //
    // Note what is deliberately NOT done: filtering to `capturedAt <= today`. A
    // future-dated baseline is accepted today and simply pushes `fromMonth`
    // forward; adding an upper bound here would be a silent behaviour change
    // smuggled in under a migration. If that is ever wanted, it is its own
    // argued change.
    //
    // The advancing anchor is also the forecast's error-correction mechanism:
    // anchored permanently on the first baseline, every modelling error would
    // compound forever with nothing to correct it — which is what #172 exists to
    // end. See docs/vision.md "Forecast modelling semantics".
    const history = cluster.baselineHistory;
    const anchor = history[history.length - 1];
    if (!anchor) {
      throw new UnprocessableError(
        'METRIC_NOT_TRACKED',
        `Cluster does not track metric ${metricKey}`,
      );
    }

    const fromMonth = options.fromMonth ?? firstOfMonth(anchor.capturedAt);
    const toMonth = options.toMonth ?? addMonths(fromMonth, DEFAULT_HORIZON_MONTHS);

    if (toMonth < fromMonth) {
      throw new UnprocessableError('INVALID_RANGE', 'to must be on or after from');
    }
    if (monthsBetweenUtc(fromMonth, toMonth) > MAX_FORECAST_SPAN_MONTHS) {
      throw new UnprocessableError(
        'RANGE_TOO_LARGE',
        `Forecast window must not exceed ${MAX_FORECAST_SPAN_MONTHS} months`,
      );
    }

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

    const applications: ForecastApplication[] = cluster.items
      .filter((it) => it.kind === 'application')
      .map((app) => ({
        id: app.id,
        name: app.name,
        startedAt: app.effectiveDate,
        endedAt: app.endedAt,
        allocations: app.allocations.map((a) => ({
          effectiveFrom: a.effectiveFrom,
          amount: a.amount.toNumber(),
        })),
      }));

    const events: ForecastEvent[] = cluster.items
      .filter((it) => it.kind === 'event' && it.metricTypeId === metricType.id)
      .map((e) => ({
        id: e.id,
        effectiveDate: e.effectiveDate,
        category: e.category,
        title: e.name,
        description: e.description,
        consumptionDelta: e.consumptionDelta?.toNumber() ?? null,
        capacityDelta: e.capacityDelta?.toNumber() ?? null,
      }));

    // The pure `computeForecast` never learns that history exists — it still
    // takes one anchor date and one pair of baseline scalars. Keeping it ignorant
    // is what makes the characterization snapshot meaningful: if this migration
    // had reshaped the pure function's contract, "the output is unchanged" would
    // no longer be a claim anyone could check.
    return {
      input: {
        baselineDate: anchor.capturedAt,
        // What the anchor MEANS decides whether tracked deltas dated at or before
        // it are already inside its numbers. See `absorbed` in forecast.ts.
        baselineSource: anchor.source === 'vsphere' ? 'vsphere' : 'manual',
        baselineConsumption: anchor.baselineConsumption.toNumber(),
        baselineCapacity: anchor.baselineCapacity.toNumber(),
        hosts,
        applications,
        events,
      },
      baselineHistory: history.map((row) => {
        const capacity = row.baselineCapacity.toNumber();
        const consumption = row.baselineConsumption.toNumber();
        return {
          capturedAt: formatDateIso(row.capturedAt),
          source: row.source === 'vsphere' ? ('vsphere' as const) : ('manual' as const),
          consumption,
          capacity,
          utilization: capacity === 0 ? null : consumption / capacity,
        };
      }),
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
      baselineHistory: prepared.baselineHistory,
    };
  }
}

function firstOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}
