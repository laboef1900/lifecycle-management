import type { PrismaClient } from '@prisma/client';
import type { HostReplacementCreateInput, HostReplacementResponse } from '@lcm/shared';

import { formatDate } from '../lib/dates.js';

import { NotFoundError, UnprocessableError } from './errors.js';
import { translatePrismaError, type UniqueConstraintMapping } from './prisma-errors.js';

const REPLACEMENT_DUPLICATE: UniqueConstraintMapping = {
  code: 'REPLACEMENT_DUPLICATE',
  message: 'This replacement already exists',
};

export class HostReplacementsService {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    tenantId: string,
    input: HostReplacementCreateInput,
  ): Promise<HostReplacementResponse> {
    const hosts = await this.prisma.host.findMany({
      where: { tenantId, id: { in: [input.oldHostId, input.newHostId] } },
      select: { id: true, clusterId: true },
    });
    if (hosts.length !== 2) {
      throw new UnprocessableError('HOST_NOT_FOUND', 'Both hosts must exist in this tenant');
    }
    const [a, b] = hosts;
    if (a!.clusterId !== b!.clusterId) {
      throw new UnprocessableError(
        'CROSS_CLUSTER_REPLACEMENT',
        'Replacement must be between hosts in the same cluster',
      );
    }
    try {
      const row = await this.prisma.hostReplacement.create({
        data: {
          tenantId,
          oldHostId: input.oldHostId,
          newHostId: input.newHostId,
          swappedAt: input.swappedAt,
          reason: input.reason ?? null,
        },
      });
      return this.toResponse(row);
    } catch (err) {
      translatePrismaError(err, { uniqueConstraint: REPLACEMENT_DUPLICATE });
      throw err;
    }
  }

  async delete(tenantId: string, id: string): Promise<void> {
    const result = await this.prisma.hostReplacement.deleteMany({ where: { id, tenantId } });
    if (result.count === 0) throw new NotFoundError('HostReplacement', id);
  }

  private toResponse(row: {
    id: string;
    oldHostId: string;
    newHostId: string;
    swappedAt: Date;
    reason: string | null;
    createdAt: Date;
  }): HostReplacementResponse {
    return {
      id: row.id,
      oldHostId: row.oldHostId,
      newHostId: row.newHostId,
      swappedAt: formatDate(row.swappedAt),
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
