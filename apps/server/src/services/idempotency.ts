import type { Prisma, PrismaClient } from '@prisma/client';

export interface IdempotencyHit {
  status: number;
  body: unknown;
}

export type IdempotencyLookupResult = IdempotencyHit | 'conflict' | null;

export interface IdempotencyRecordParams {
  key: string;
  route: string;
  requestHash: string;
  status: number;
  body: unknown;
  tenantId: string;
}

/**
 * General request-idempotency cache (#263). Both methods run against
 * whichever `tx` the caller passes — a caller wraps `lookup` and `record`
 * around its own transactional write so the dedup record commits or rolls
 * back atomically with the mutation it is guarding. Not scoped to any one
 * endpoint: `route` merely records which one issued a given key.
 */
export class IdempotencyService {
  constructor(private readonly prisma: PrismaClient) {}

  async lookup(
    key: string,
    requestHash: string,
    tx: Prisma.TransactionClient | PrismaClient = this.prisma,
  ): Promise<IdempotencyLookupResult> {
    const existing = await tx.idempotencyKey.findUnique({ where: { key } });
    if (!existing) return null;
    if (existing.requestHash !== requestHash) return 'conflict';
    return { status: existing.responseStatus, body: existing.responseBody };
  }

  /**
   * Reads the tenant's configured `idempotencyKeyRetentionHours` (upserting a
   * default row if none exists yet, mirroring `SettingsService.getTenant`'s
   * own upsert-on-read pattern) and stores the record with `expiresAt`
   * computed from that value at THIS moment — a later change to the setting
   * does not retroactively shorten or extend an already-stored key's life.
   */
  async record(
    params: IdempotencyRecordParams,
    tx: Prisma.TransactionClient | PrismaClient = this.prisma,
  ): Promise<void> {
    const settings = await tx.tenantSettings.upsert({
      where: { tenantId: params.tenantId },
      create: { tenantId: params.tenantId },
      update: {},
      select: { idempotencyKeyRetentionHours: true },
    });
    const now = Date.now();
    await tx.idempotencyKey.create({
      data: {
        key: params.key,
        route: params.route,
        requestHash: params.requestHash,
        responseStatus: params.status,
        responseBody: params.body as Prisma.InputJsonValue,
        expiresAt: new Date(now + settings.idempotencyKeyRetentionHours * 60 * 60 * 1000),
      },
    });
  }
}
