import type {
  CapacityResponseRow,
  CapacityRowInput,
  HostCommissioningConfirmInput,
  HostCreateInput,
  HostMoveInput,
  HostResponse,
  HostUpdateInput,
  Paginated,
} from '@lcm/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

import { formatDate } from '../lib/dates.js';

import { NotFoundError, UnprocessableError } from './errors.js';
import { projectedDecommissionDate } from './host-projection.js';
import { translatePrismaError, type UniqueConstraintMapping } from './prisma-errors.js';
import {
  assertHostCapacityAppendable,
  assertHostCreatableUnderCluster,
  assertHostDeletable,
  assertHostMovable,
} from './sync-ownership.js';

const CAPACITY_DUPLICATE: UniqueConstraintMapping = {
  code: 'CAPACITY_DUPLICATE_DATE',
  message: 'A capacity row already exists for this host/metric on that effective date',
};

const hostInclude = {
  capacities: {
    include: { metricType: true },
    orderBy: [{ metricType: { key: 'asc' as const } }, { effectiveFrom: 'asc' as const }],
  },
  replacedByLinks: { include: { new: { select: { commissionedAt: true, state: true } } } },
} satisfies Prisma.HostInclude;

type HostRow = Prisma.HostGetPayload<{ include: typeof hostInclude }>;

interface CommissioningCapacityRow {
  id: string;
  metricTypeId: string;
  effectiveFrom: Date;
}

/**
 * Capacity rows seeded with a provisional commissioning date must move with that
 * date when the operator confirms an earlier one. Only the earliest row for each
 * metric is eligible, and only when it is aligned exactly with the old provisional
 * date; later capacity changes remain immutable history.
 */
function provisionalCapacityRowsToMove(host: {
  commissionedAt: Date;
  commissionedAtProvisional: boolean;
  capacities: CommissioningCapacityRow[];
}): string[] {
  if (!host.commissionedAtProvisional) return [];

  const earliestByMetric = new Map<string, CommissioningCapacityRow>();
  for (const capacity of host.capacities) {
    const earliest = earliestByMetric.get(capacity.metricTypeId);
    if (!earliest || capacity.effectiveFrom < earliest.effectiveFrom) {
      earliestByMetric.set(capacity.metricTypeId, capacity);
    }
  }

  return [...earliestByMetric.values()]
    .filter((capacity) => capacity.effectiveFrom.getTime() === host.commissionedAt.getTime())
    .map((capacity) => capacity.id);
}

export class HostsService {
  constructor(private readonly prisma: PrismaClient) {}

  async listByCluster(
    tenantId: string,
    clusterId: string,
    options: { limit: number; offset: number },
  ): Promise<Paginated<HostResponse>> {
    await this.assertClusterExists(tenantId, clusterId);
    const where = { tenantId, clusterId };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.host.count({ where }),
      this.prisma.host.findMany({
        where,
        include: hostInclude,
        orderBy: { name: 'asc' },
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
    const cluster = await this.prisma.cluster.findFirst({
      where: { id: clusterId, tenantId },
      select: { id: true, source: true },
    });
    if (!cluster) {
      throw new NotFoundError('Cluster', clusterId);
    }
    // Host membership of a synced cluster is sync-owned (#196).
    assertHostCreatableUnderCluster(cluster.source, clusterId);
    this.validateInitialCapacities(input);

    const metricTypes = await this.resolveMetricTypes(input.capacities.map((c) => c.metricTypeKey));

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const host = await tx.host.create({
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
                  throw new UnprocessableError(
                    'UNKNOWN_METRIC',
                    `Unknown metric ${c.metricTypeKey}`,
                  );
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
        // #289 open the host's membership timeline in its creating cluster,
        // effective from its commissioning date. The forecast attributes host
        // capacity through this timeline, so every host-creating path MUST seed
        // one open membership (parity with the migration backfill and sync).
        await tx.hostClusterMembership.create({
          data: {
            tenantId,
            hostId: host.id,
            clusterId,
            effectiveFrom: host.commissionedAt,
            effectiveTo: null,
          },
        });
        return host;
      });
      return this.toResponse(created);
    } catch (err) {
      translatePrismaError(err, { uniqueConstraint: CAPACITY_DUPLICATE });
      throw err;
    }
  }

  /**
   * Move a manual host to a different cluster with a TIME-SCOPED membership (#289,
   * owner decision 2026-07-22). The move closes the current open membership at
   * `moveDate` and opens a new one in the destination — the forecast then credits
   * the OLD cluster before `moveDate` and the NEW cluster on/after it, so history
   * is never retroactively rewritten (the landmine of a naive `clusterId` flip).
   *
   * Refused for synced hosts and synced destinations (`SYNC_OWNED_FIELD`, 409):
   * vCenter owns a synced host's cluster and a synced cluster's host membership.
   *
   * @ai-note Invariants held inside this Serializable transaction: exactly one
   * open membership per host; intervals contiguous (closed `effectiveTo` equals
   * the new `effectiveFrom`) and non-overlapping; `hosts.clusterId` equals the
   * open membership's `clusterId`.
   */
  async move(tenantId: string, id: string, input: HostMoveInput): Promise<HostResponse> {
    await this.prisma.$transaction(
      async (tx) => {
        const host = await tx.host.findFirst({
          where: { id, tenantId },
          select: { id: true, source: true, clusterId: true },
        });
        if (!host) {
          throw new NotFoundError('Host', id);
        }
        assertHostMovable(host.source, id);

        const destination = await tx.cluster.findFirst({
          where: { id: input.clusterId, tenantId },
          select: { id: true, source: true },
        });
        if (!destination) {
          throw new NotFoundError('Cluster', input.clusterId);
        }
        assertHostCreatableUnderCluster(destination.source, input.clusterId);

        if (host.clusterId === input.clusterId) {
          throw new UnprocessableError(
            'HOST_ALREADY_IN_CLUSTER',
            'Host already belongs to this cluster',
          );
        }

        const open = await tx.hostClusterMembership.findFirst({
          where: { hostId: id, effectiveTo: null },
        });
        if (open) {
          if (input.moveDate <= open.effectiveFrom) {
            throw new UnprocessableError(
              'INVALID_MOVE_DATE',
              'moveDate must be after the start of the current cluster membership',
            );
          }
          await tx.hostClusterMembership.update({
            where: { id: open.id },
            data: { effectiveTo: input.moveDate },
          });
        }

        await tx.hostClusterMembership.create({
          data: {
            tenantId,
            hostId: id,
            clusterId: input.clusterId,
            effectiveFrom: input.moveDate,
            effectiveTo: null,
          },
        });
        await tx.host.update({ where: { id }, data: { clusterId: input.clusterId } });
      },
      { isolationLevel: 'Serializable' },
    );
    return this.getById(tenantId, id);
  }

  async update(tenantId: string, id: string, input: HostUpdateInput): Promise<HostResponse> {
    const existing = await this.prisma.host.findFirst({
      where: { id, tenantId },
      include: {
        capacities: { select: { id: true, metricTypeId: true, effectiveFrom: true } },
      },
    });
    if (!existing) {
      throw new NotFoundError('Host', id);
    }

    const data: Prisma.HostUpdateInput = {};
    if (input.name !== undefined) {
      data.name = input.name;
      // An operator rename pins the label so inventory sync stops clobbering it
      // (parity with Cluster.nameIsCustom, #196). Harmless on manual hosts.
      data.nameIsCustom = true;
    }
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
      // @ai-note commissionedAt and commissionedAtProvisional are OPERATOR-OWNED
      // on synced hosts (owner decision Q9c, #194). vCenter cannot tell us when a
      // host was commissioned, so sync imports a provisional date and flags it;
      // the admin confirms the real date here, which clears the flag — even when
      // the date is unchanged ("confirm as-is"). Both fields MUST remain writable:
      // #196's sync-owned-field guard has to carve them out, and the re-sync
      // regression test in host-commissioning.test.ts is the contract it must not
      // break. The flag is one-way: nothing but a fresh sync re-sets it to true.
      data.commissionedAtProvisional = false;
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

    const capacityRowsToMove =
      input.commissionedAt !== undefined && input.commissionedAt < existing.commissionedAt
        ? provisionalCapacityRowsToMove(existing)
        : [];

    await this.prisma.$transaction(async (tx) => {
      if (input.commissionedAt !== undefined && capacityRowsToMove.length > 0) {
        await tx.hostMetricCapacity.updateMany({
          where: { id: { in: capacityRowsToMove } },
          data: { effectiveFrom: input.commissionedAt },
        });
      }
      if (input.commissionedAt !== undefined) {
        await this.realignEarliestMembership(tx, id, input.commissionedAt);
      }
      await tx.host.update({ where: { id }, data });
    });
    return this.getById(tenantId, id);
  }

  /**
   * Keep the host's EARLIEST membership aligned with its commissioning date
   * (#289). The first membership is seeded at `commissionedAt`
   * (create/sync/backfill), and the forecast attributes a host to a cluster only
   * within its membership interval — so when an operator confirms an earlier real
   * commissioning date (Q9c, #194), the earliest interval's start must move with
   * it, or capacity is stranded (attributed to no cluster) for the months between
   * the real and the provisional date. Parity with how the earliest capacity row
   * is re-dated on the same confirm. Only the earliest interval moves; later
   * intervals (a subsequent move) are immutable history.
   */
  private async realignEarliestMembership(
    tx: Prisma.TransactionClient,
    hostId: string,
    commissionedAt: Date,
  ): Promise<void> {
    const earliest = await tx.hostClusterMembership.findFirst({
      where: { hostId },
      orderBy: { effectiveFrom: 'asc' },
    });
    if (!earliest || earliest.effectiveFrom.getTime() === commissionedAt.getTime()) return;
    // Guard the timeline invariant (#289). If the earliest interval is CLOSED (the
    // host was later moved), the correction must not push its start on/after its
    // own end, or we write an inverted / zero-length `[from, to)` row (from >= to)
    // — a silent break of the "contiguous, non-overlapping" invariant. The
    // capacity-row guard in `update`/`confirmCommissioning` does NOT catch this: a
    // host's first capacity row may legitimately postdate `commissionedAt`, so a
    // correction can satisfy that check yet still land after a prior move's date.
    // Reject with the same code as the capacity guard — both mean "this
    // commissionedAt is inconsistent with the host's history".
    if (earliest.effectiveTo !== null && commissionedAt >= earliest.effectiveTo) {
      throw new UnprocessableError(
        'INVALID_COMMISSIONED_AT',
        'commissionedAt cannot be on or after the first cluster move date',
      );
    }
    await tx.hostClusterMembership.update({
      where: { id: earliest.id },
      data: { effectiveFrom: commissionedAt },
    });
  }

  /**
   * Bulk-confirm provisional commissioning dates on synced hosts (Q9c, #194).
   *
   * @ai-note All-or-nothing. A fleet import stamps a provisional
   * `commissionedAt` on many hosts at once; the admin reviews them and confirms
   * the real dates in one request. Every entry is applied inside a single
   * transaction, so one bad date — rejected by the same `INVALID_COMMISSIONED_AT`
   * guard as `update` — aborts the whole batch rather than committing a partial,
   * confusing result. commissionedAt/commissionedAtProvisional are operator-owned
   * (see the note in `update`); confirming sets the real date and clears the flag,
   * and is valid even when the date is unchanged.
   */
  async confirmCommissioning(
    tenantId: string,
    input: HostCommissioningConfirmInput,
  ): Promise<HostResponse[]> {
    const ids = input.hosts.map((h) => h.hostId);
    const rows = await this.prisma.$transaction(
      async (tx) => {
        // Validate the WHOLE batch before writing anything, so a single bad date
        // (or unknown host) aborts before the first mutation — the transaction is
        // the backstop, but validating up front keeps the failure obvious. Host
        // ids are unique per the schema refine, so one lookup covers every entry.
        const existing = await tx.host.findMany({
          where: { id: { in: ids }, tenantId },
          include: {
            capacities: { select: { id: true, metricTypeId: true, effectiveFrom: true } },
          },
        });
        const byId = new Map(existing.map((h) => [h.id, h]));
        for (const entry of input.hosts) {
          const host = byId.get(entry.hostId);
          if (!host) {
            throw new NotFoundError('Host', entry.hostId);
          }
          const earliest = host.capacities.reduce<Date | null>(
            (min, cap) => (min === null || cap.effectiveFrom < min ? cap.effectiveFrom : min),
            null,
          );
          if (earliest !== null && entry.commissionedAt > earliest) {
            throw new UnprocessableError(
              'INVALID_COMMISSIONED_AT',
              'commissionedAt cannot be after the earliest capacity row',
            );
          }
        }
        for (const entry of input.hosts) {
          const host = byId.get(entry.hostId)!;
          const capacityRowsToMove =
            entry.commissionedAt < host.commissionedAt ? provisionalCapacityRowsToMove(host) : [];
          if (capacityRowsToMove.length > 0) {
            await tx.hostMetricCapacity.updateMany({
              where: { id: { in: capacityRowsToMove } },
              data: { effectiveFrom: entry.commissionedAt },
            });
          }
          await this.realignEarliestMembership(tx, entry.hostId, entry.commissionedAt);
          await tx.host.update({
            where: { id: entry.hostId },
            data: { commissionedAt: entry.commissionedAt, commissionedAtProvisional: false },
          });
        }
        return tx.host.findMany({
          where: { id: { in: ids }, tenantId },
          include: hostInclude,
          orderBy: { name: 'asc' },
        });
      },
      { isolationLevel: 'Serializable', timeout: 15_000 },
    );
    return rows.map((row) => this.toResponse(row));
  }

  async appendCapacity(
    tenantId: string,
    id: string,
    input: CapacityRowInput,
  ): Promise<HostResponse> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const host = await tx.host.findFirst({
            where: { id, tenantId },
            include: { capacities: { include: { metricType: true } } },
          });
          if (!host) {
            throw new NotFoundError('Host', id);
          }

          // A synced host's capacity is owned by vCenter (#198); refuse the operator
          // path so it cannot fight the sync writer. Manual hosts stay open.
          assertHostCapacityAppendable(host.source, id);

          if (input.effectiveFrom < host.commissionedAt) {
            throw new UnprocessableError(
              'EFFECTIVE_BEFORE_COMMISSION',
              'effectiveFrom must be on or after the host commissionedAt date',
            );
          }

          const metricType = (await this.resolveMetricTypes([input.metricTypeKey], tx)).get(
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

          await tx.hostMetricCapacity.create({
            data: {
              hostId: id,
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
      translatePrismaError(err, { uniqueConstraint: CAPACITY_DUPLICATE });
      throw err;
    }

    return this.getById(tenantId, id);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const existing = await this.prisma.host.findFirst({
      where: { id, tenantId },
      select: { id: true, source: true },
    });
    if (!existing) {
      throw new NotFoundError('Host', id);
    }
    // A synced host is reconciled from vCenter; deleting it is sync-owned (#196).
    assertHostDeletable(existing.source, id);
    await this.prisma.host.deleteMany({ where: { id, tenantId } });
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
      // A synced host whose commissioning date vCenter could not supply carries a
      // provisional date flagged here (Q9c, #194); false for manual hosts and for
      // confirmed synced ones. The client keys the "confirm commissioning date"
      // affordance off this — it must never present a guess as a measurement.
      commissionedAtProvisional: row.commissionedAtProvisional,
    };
  }
}
