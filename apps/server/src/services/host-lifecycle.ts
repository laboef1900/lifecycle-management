import type { HostLifecycleEventResponse } from '@lcm/shared';
import { Prisma, type HostState, type PrismaClient } from '@prisma/client';

import { formatDate } from '../lib/dates.js';

import { ConflictError, NotFoundError, UnprocessableError } from './errors.js';

const ALLOWED: Record<HostState, HostState[]> = {
  ordered: ['racked'],
  racked: ['in_service'],
  in_service: ['degraded', 'decommissioned'],
  degraded: ['in_service', 'decommissioned'],
  decommissioned: ['disposed'],
  disposed: [],
};

export interface TransitionInput {
  tenantId: string;
  hostId: string;
  toState: HostState;
  occurredAt: Date;
  note?: string;
}

export class HostLifecycleService {
  constructor(private readonly prisma: PrismaClient) {}

  async transition(input: TransitionInput): Promise<void> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const host = await tx.host.findFirst({
            where: { id: input.hostId, tenantId: input.tenantId },
          });
          if (!host) throw new NotFoundError('Host', input.hostId);

          if (!ALLOWED[host.state].includes(input.toState)) {
            throw new UnprocessableError(
              'INVALID_TRANSITION',
              `Cannot transition host from ${host.state} to ${input.toState}`,
            );
          }

          await tx.hostLifecycleEvent.create({
            data: {
              tenantId: input.tenantId,
              hostId: input.hostId,
              fromState: host.state,
              toState: input.toState,
              occurredAt: input.occurredAt,
              note: input.note ?? null,
            },
          });

          const patch: Prisma.HostUpdateInput = { state: input.toState };
          if (
            input.toState === 'in_service' &&
            host.state === 'racked' &&
            host.commissionedAt > input.occurredAt
          ) {
            patch.commissionedAt = input.occurredAt;
          }
          if (input.toState === 'decommissioned') {
            patch.decommissionedAt = input.occurredAt;
          }
          await tx.host.update({ where: { id: input.hostId }, data: patch });
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (err) {
      this.translatePrismaError(err);
      throw err;
    }
  }

  async listEvents(tenantId: string, hostId: string): Promise<HostLifecycleEventResponse[]> {
    const host = await this.prisma.host.findFirst({
      where: { id: hostId, tenantId },
      select: { id: true },
    });
    if (!host) throw new NotFoundError('Host', hostId);
    const rows = await this.prisma.hostLifecycleEvent.findMany({
      where: { hostId, tenantId },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      hostId: r.hostId,
      fromState: r.fromState,
      toState: r.toState,
      occurredAt: formatDate(r.occurredAt),
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  private translatePrismaError(err: unknown): void {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      throw new ConflictError('WRITE_CONFLICT', 'Concurrent write detected; retry the request');
    }
  }
}
