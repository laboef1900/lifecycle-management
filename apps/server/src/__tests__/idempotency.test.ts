import { beforeEach, describe, expect, it } from 'vitest';

import { IdempotencyService } from '../services/idempotency.js';

import { prisma } from './setup.js';

let service: IdempotencyService;

beforeEach(() => {
  service = new IdempotencyService(prisma);
});

describe('IdempotencyService', () => {
  it('lookup returns null when the key has never been recorded', async () => {
    const result = await service.lookup('11111111-1111-4111-8111-111111111111', 'hash-a');
    expect(result).toBeNull();
  });

  it('record then lookup with the same hash returns the stored response', async () => {
    await service.record({
      key: '22222222-2222-4222-8222-222222222222',
      route: 'POST /items/bulk-shift-dates',
      requestHash: 'hash-b',
      status: 200,
      body: { shifted: 1, items: [] },
      tenantId: 'default',
    });

    const result = await service.lookup('22222222-2222-4222-8222-222222222222', 'hash-b');
    expect(result).toEqual({ status: 200, body: { shifted: 1, items: [] } });
  });

  it('lookup with a different hash under the same key returns "conflict"', async () => {
    await service.record({
      key: '33333333-3333-4333-8333-333333333333',
      route: 'POST /items/bulk-shift-dates',
      requestHash: 'hash-c',
      status: 200,
      body: { shifted: 1, items: [] },
      tenantId: 'default',
    });

    const result = await service.lookup('33333333-3333-4333-8333-333333333333', 'hash-different');
    expect(result).toBe('conflict');
  });

  it("record uses the tenant's configured retention hours to set expiresAt", async () => {
    await prisma.tenantSettings.upsert({
      where: { tenantId: 'default' },
      create: { tenantId: 'default', idempotencyKeyRetentionHours: 2 },
      update: { idempotencyKeyRetentionHours: 2 },
    });

    const before = Date.now();
    await service.record({
      key: '44444444-4444-4444-8444-444444444444',
      route: 'POST /items/bulk-shift-dates',
      requestHash: 'hash-d',
      status: 200,
      body: {},
      tenantId: 'default',
    });

    const row = await prisma.idempotencyKey.findUniqueOrThrow({
      where: { key: '44444444-4444-4444-8444-444444444444' },
    });
    const expectedExpiryMs = before + 2 * 60 * 60 * 1000;
    // Allow a small window for test execution time.
    expect(Math.abs(row.expiresAt.getTime() - expectedExpiryMs)).toBeLessThan(5000);
  });
});
