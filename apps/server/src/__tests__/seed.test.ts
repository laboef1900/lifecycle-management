import { describe, expect, it } from 'vitest';

import { seedReferenceData } from '../../prisma/seed-reference-data.js';
import { ForecastService } from '../services/forecast-loader.js';

import { prisma } from './setup.js';

/**
 * Regression for the #289 seed gap (CRITICAL review finding): the forecast loader
 * builds its host list EXCLUSIVELY from `HostClusterMembership`, so a host the
 * reference seed creates with no open membership is invisible to every forecast
 * (`hosts: []`, capacity 0) even though the cluster panel — which reads
 * `Host.clusterId` — still shows it. `seedReferenceData` must open one membership
 * per host, parity with every other host-creating path. This exercises the real
 * seed function, not the test factory (which already seeded memberships and thus
 * MASKED this gap).
 */

const TENANT = 'default';
const BASELINE_DATE = new Date('2026-05-01T00:00:00.000Z');

describe('reference data seed — host membership (#289)', () => {
  it('opens one membership per seeded host so it appears in its cluster forecast', async () => {
    await seedReferenceData(prisma);

    const cluster = await prisma.cluster.findFirstOrThrow({
      where: { tenantId: TENANT, name: 'CL-DMZ-P1' },
    });
    const host = await prisma.host.findFirstOrThrow({
      where: { tenantId: TENANT, serialNumber: 'SEED-CL-DMZ-P1-01' },
    });

    // The seed opened exactly one membership, from the host's commissioning date,
    // pointing at its cluster — parity with the migration backfill / create / sync.
    const memberships = await prisma.hostClusterMembership.findMany({
      where: { hostId: host.id },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.clusterId).toBe(cluster.id);
    expect(memberships[0]!.effectiveTo).toBeNull();
    expect(memberships[0]!.effectiveFrom.getTime()).toBe(BASELINE_DATE.getTime());
    expect(host.clusterId).toBe(cluster.id);

    // The observable bug the review reproduced: without a membership the host is
    // absent from the forecast host list (`hostIds: []`). With the fix it is
    // present, i.e. the forecast can attribute its capacity again.
    const forecast = await new ForecastService(prisma).forCluster(TENANT, cluster.id, 'memory_gb', {
      fromMonth: BASELINE_DATE,
      toMonth: new Date('2026-08-01T00:00:00.000Z'),
    });
    expect(forecast.hosts.map((h) => h.id)).toContain(host.id);
  });

  it('is idempotent — a second seed run does not accrete duplicate memberships', async () => {
    await seedReferenceData(prisma);
    await seedReferenceData(prisma);

    const host = await prisma.host.findFirstOrThrow({
      where: { tenantId: TENANT, serialNumber: 'SEED-CL-DMZ-P1-01' },
    });
    const memberships = await prisma.hostClusterMembership.findMany({
      where: { hostId: host.id },
    });
    expect(memberships).toHaveLength(1);
    expect(memberships.filter((m) => m.effectiveTo === null)).toHaveLength(1);
  });
});
