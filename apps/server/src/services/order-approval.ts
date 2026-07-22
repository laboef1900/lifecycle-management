import type { OrderApprovalCreateInput, OrderApprovalResponse } from '@lcm/shared';
import type { PrismaClient } from '@prisma/client';

import { ANONYMOUS_USER } from '../plugins/auth.js';
import { formatDate } from '../lib/dates.js';

import { NotFoundError, UnprocessableError } from './errors.js';
import { ForecastService } from './forecast-loader.js';
import type { SessionUser } from './sessions.js';

/** Audit label for an approval taken while auth is disabled (no `users` row). */
const ANONYMOUS_LABEL = 'anonymous (auth disabled)';

type OrderApprovalRow = {
  id: string;
  clusterId: string;
  breachMonth: Date;
  orderByDate: Date;
  leadTimeWeeks: number;
  warnThreshold: number;
  capacitySignature: number;
  metricTypeId: string | null;
  approvedByUserId: string | null;
  approvedByLabel: string;
  note: string | null;
  createdAt: Date;
};

/**
 * Order-approval writes (#292). Approving snapshots the CURRENT breach for the
 * cluster's primary metric; the snapshot is immutable and append-only (INV-4).
 * There is no update or delete path here — an approval is superseded by the
 * coverage rule (`order-approval-coverage.ts`), not mutated. INV-1: this service
 * never writes anything the forecast engine reads.
 */
export class OrderApprovalService {
  private readonly forecastService: ForecastService;

  constructor(private readonly prisma: PrismaClient) {
    this.forecastService = new ForecastService(prisma);
  }

  async create(
    tenantId: string,
    clusterId: string,
    input: OrderApprovalCreateInput,
    principal: SessionUser,
  ): Promise<OrderApprovalResponse> {
    const primaryMetric = await this.primaryMetric(tenantId, clusterId);
    const { procurement, warnThreshold, capacitySignature } =
      await this.forecastService.liveBreachContext(tenantId, clusterId, primaryMetric.key);

    // 422 when there is nothing to approve: the live forecast shows no warn
    // breach for the primary metric (DESIGN.md §5). breachMonth and orderByDate
    // are null together, but check both so a partial future change can't slip a
    // half-snapshot through.
    if (procurement.orderByDate === null || procurement.breachMonth === null) {
      throw new UnprocessableError(
        'NO_LIVE_BREACH',
        'There is no current order to approve for this cluster: the forecast projects no warn breach.',
      );
    }

    const isAnonymous = principal.id === ANONYMOUS_USER.id;
    const row = (await this.prisma.orderApproval.create({
      data: {
        tenantId,
        clusterId,
        breachMonth: toUtcDate(procurement.breachMonth),
        orderByDate: toUtcDate(procurement.orderByDate),
        leadTimeWeeks: procurement.leadTimeWeeks,
        warnThreshold,
        capacitySignature,
        // Snapshot WHICH metric this breach was for (#292). v1 coverage still
        // matches single-metric, but capturing it now avoids a second migration +
        // backfill on this purchasing-critical table when multi-metric lands.
        metricTypeId: primaryMetric.id,
        // Nullable + label pattern for disabled-auth mode (DESIGN.md §7): the
        // anonymous ADMIN has no `users` row, so persist the audit string only.
        approvedByUserId: isAnonymous ? null : principal.id,
        approvedByLabel: isAnonymous
          ? ANONYMOUS_LABEL
          : (principal.displayName ?? principal.email ?? principal.id),
        note: input.note ?? null,
      },
    })) as OrderApprovalRow;

    return toResponse(row);
  }

  /**
   * The cluster's PRIMARY metric (id + key) — the alphabetically-first tracked
   * metric key, matching `ClusterResponse.metrics[0]` (`clusters.ts` orders newest
   * baselines by `metricType.key: 'asc'`), which is exactly the metric the
   * recommendation chip renders. The id is snapshotted onto the approval so a
   * future multi-metric world can scope coverage per metric (#292). 404 when the
   * cluster is absent; 422 when it tracks no metric.
   */
  private async primaryMetric(
    tenantId: string,
    clusterId: string,
  ): Promise<{ id: string; key: string }> {
    const cluster = await this.prisma.cluster.findFirst({
      where: { id: clusterId, tenantId },
      select: { id: true },
    });
    if (!cluster) throw new NotFoundError('Cluster', clusterId);

    const rows = await this.prisma.clusterBaselineHistory.findMany({
      where: { tenantId, clusterId },
      select: { metricType: { select: { id: true, key: true } } },
    });
    const [first] = rows
      .map((row) => row.metricType)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (first === undefined) {
      throw new UnprocessableError(
        'NO_LIVE_BREACH',
        'This cluster tracks no metric yet, so there is no order to approve.',
      );
    }
    return first;
  }
}

/** `YYYY-MM-DD` wire date → UTC-midnight Date for a `@db.Date` column. */
function toUtcDate(wireDate: string): Date {
  return new Date(`${wireDate}T00:00:00.000Z`);
}

function toResponse(row: OrderApprovalRow): OrderApprovalResponse {
  return {
    id: row.id,
    clusterId: row.clusterId,
    breachMonth: formatDate(row.breachMonth),
    orderByDate: formatDate(row.orderByDate),
    leadTimeWeeks: row.leadTimeWeeks,
    warnThreshold: row.warnThreshold,
    capacitySignature: row.capacitySignature,
    metricTypeId: row.metricTypeId,
    approvedByUserId: row.approvedByUserId,
    approvedByLabel: row.approvedByLabel,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}
