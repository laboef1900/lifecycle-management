import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../../__tests__/setup.js';
import { makeCluster } from '../../__tests__/factories.js';
import { HostLifecycleService } from '../host-lifecycle.js';

let clusterId: string;
let metricTypeId: string;

beforeEach(async () => {
  const c = await makeCluster(prisma);
  clusterId = c.id;
  metricTypeId = c.metricTypeId;
});

async function makeHost(
  state: 'ordered' | 'in_service' | 'degraded' | 'decommissioned' = 'in_service',
) {
  return prisma.host.create({
    data: {
      tenantId: 'default',
      clusterId,
      name: `h-${Math.random().toString(36).slice(2, 8)}`,
      commissionedAt: new Date('2024-01-01'),
      state,
      capacities: {
        create: {
          tenantId: 'default',
          metricTypeId,
          effectiveFrom: new Date('2024-01-01'),
          amount: new Prisma.Decimal(100),
        },
      },
    },
  });
}

describe('HostLifecycleService.transition', () => {
  const service = new HostLifecycleService(prisma);

  it('advances in_service -> degraded and writes an event', async () => {
    const host = await makeHost('in_service');
    await service.transition({
      tenantId: 'default',
      hostId: host.id,
      toState: 'degraded',
      occurredAt: new Date('2026-05-25'),
    });
    const updated = await prisma.host.findUniqueOrThrow({ where: { id: host.id } });
    expect(updated.state).toBe('degraded');
    const events = await prisma.hostLifecycleEvent.findMany({
      where: { hostId: host.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.at(-1)).toMatchObject({ fromState: 'in_service', toState: 'degraded' });
  });

  it('sets decommissionedAt on transition to decommissioned', async () => {
    const host = await makeHost('in_service');
    const date = new Date('2026-06-01');
    await service.transition({
      tenantId: 'default',
      hostId: host.id,
      toState: 'decommissioned',
      occurredAt: date,
    });
    const updated = await prisma.host.findUniqueOrThrow({ where: { id: host.id } });
    expect(updated.decommissionedAt?.toISOString()).toBe(date.toISOString());
  });

  it('rejects ordered -> in_service (must go via racked)', async () => {
    const host = await makeHost('ordered');
    await expect(
      service.transition({
        tenantId: 'default',
        hostId: host.id,
        toState: 'in_service',
        occurredAt: new Date('2026-05-25'),
      }),
    ).rejects.toThrow(/transition/i);
  });

  it('rejects decommissioned -> in_service (terminal-ish)', async () => {
    const host = await makeHost('decommissioned');
    await expect(
      service.transition({
        tenantId: 'default',
        hostId: host.id,
        toState: 'in_service',
        occurredAt: new Date('2026-05-25'),
      }),
    ).rejects.toThrow();
  });

  it('throws NotFoundError for unknown host', async () => {
    await expect(
      service.transition({
        tenantId: 'default',
        hostId: 'missing',
        toState: 'degraded',
        occurredAt: new Date('2026-05-25'),
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('back-dates commissionedAt on racked -> in_service when occurredAt is earlier', async () => {
    const host = await prisma.host.create({
      data: {
        tenantId: 'default',
        clusterId,
        name: `h-${Math.random().toString(36).slice(2, 8)}`,
        commissionedAt: new Date('2024-06-01'),
        state: 'racked',
        capacities: {
          create: {
            tenantId: 'default',
            metricTypeId,
            effectiveFrom: new Date('2024-06-01'),
            amount: new Prisma.Decimal(100),
          },
        },
      },
    });
    await service.transition({
      tenantId: 'default',
      hostId: host.id,
      toState: 'in_service',
      occurredAt: new Date('2024-01-01'),
    });
    const updated = await prisma.host.findUniqueOrThrow({ where: { id: host.id } });
    expect(updated.commissionedAt.toISOString()).toBe(new Date('2024-01-01').toISOString());
    expect(updated.state).toBe('in_service');
  });

  it('does NOT change commissionedAt when racked -> in_service occurredAt is later', async () => {
    const host = await prisma.host.create({
      data: {
        tenantId: 'default',
        clusterId,
        name: `h-${Math.random().toString(36).slice(2, 8)}`,
        commissionedAt: new Date('2024-01-01'),
        state: 'racked',
        capacities: {
          create: {
            tenantId: 'default',
            metricTypeId,
            effectiveFrom: new Date('2024-01-01'),
            amount: new Prisma.Decimal(100),
          },
        },
      },
    });
    await service.transition({
      tenantId: 'default',
      hostId: host.id,
      toState: 'in_service',
      occurredAt: new Date('2024-06-01'),
    });
    const updated = await prisma.host.findUniqueOrThrow({ where: { id: host.id } });
    expect(updated.commissionedAt.toISOString()).toBe(new Date('2024-01-01').toISOString());
  });

  it('does NOT back-date commissionedAt on degraded -> in_service recovery', async () => {
    // Set up a host that's currently degraded with original commission 2024-01-01
    const host = await prisma.host.create({
      data: {
        tenantId: 'default',
        clusterId,
        name: `h-${Math.random().toString(36).slice(2, 8)}`,
        commissionedAt: new Date('2024-01-01'),
        state: 'degraded',
        capacities: {
          create: {
            tenantId: 'default',
            metricTypeId,
            effectiveFrom: new Date('2024-01-01'),
            amount: new Prisma.Decimal(100),
          },
        },
      },
    });
    // Recovery transition with an earlier occurredAt should NOT rewrite commissionedAt
    await service.transition({
      tenantId: 'default',
      hostId: host.id,
      toState: 'in_service',
      occurredAt: new Date('2023-06-01'),
    });
    const updated = await prisma.host.findUniqueOrThrow({ where: { id: host.id } });
    expect(updated.commissionedAt.toISOString()).toBe(new Date('2024-01-01').toISOString());
    expect(updated.state).toBe('in_service');
  });
});
