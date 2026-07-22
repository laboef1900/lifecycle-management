import { describe, expect, it } from 'vitest';

import { seedReferenceData } from '../../prisma/seed-reference-data.js';
import { ForecastService } from '../services/forecast-loader.js';
import { HostsService } from '../services/hosts.js';

import { prisma } from './setup.js';

/**
 * Regression for the #289 seed gaps: the forecast loader builds its host list
 * EXCLUSIVELY from `HostClusterMembership`, so a host the reference seed creates
 * with no open membership is ABSENT from every forecast (`hosts: []`) even though
 * the cluster panel — which reads `Host.clusterId` — still shows it. These
 * reference hosts carry no capacity rows, so the visible effect is forecast
 * VISIBILITY (the host reappearing with its EOL-cliff marker), not capacity.
 * `seedReferenceData` must open one membership per host, parity with every other
 * host-creating path. This exercises the real seed function, not the test factory
 * (which already seeded memberships and thus MASKED this gap). A second gap: a
 * reseed must PRESERVE an operator's move rather than resetting `Host.clusterId`.
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
    // ABSENT from the forecast host list (`hostIds: []`). With the fix it is
    // present again (visibility — these reference hosts have no capacity rows).
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

  it('preserves an operator move across a reseed (Host.clusterId stays consistent with the open membership)', async () => {
    // The re-review's reproduced gap: seed → operator move → reseed. A reseed must
    // NOT reset `Host.clusterId` back to the seed's cluster while the open
    // membership (correctly) points at the moved-to cluster — that silently breaks
    // `HostsService.move`'s invariant (Host.clusterId == open membership clusterId).
    await seedReferenceData(prisma);

    const seedCluster = await prisma.cluster.findFirstOrThrow({
      where: { tenantId: TENANT, name: 'CL-DMZ-P1' },
    });
    const destCluster = await prisma.cluster.findFirstOrThrow({
      where: { tenantId: TENANT, name: 'CL-Prod-P2' },
    });
    const seeded = await prisma.host.findFirstOrThrow({
      where: { tenantId: TENANT, serialNumber: 'SEED-CL-DMZ-P1-01' },
    });
    expect(seeded.clusterId).toBe(seedCluster.id);

    // Operator moves the seeded host to another cluster (first-of-month, after the
    // seed's BASELINE_DATE membership start).
    await new HostsService(prisma).move(TENANT, seeded.id, {
      clusterId: destCluster.id,
      moveDate: new Date('2026-06-01T00:00:00.000Z'),
    });

    const openAfterMove = await prisma.hostClusterMembership.findFirstOrThrow({
      where: { hostId: seeded.id, effectiveTo: null },
    });
    expect(openAfterMove.clusterId).toBe(destCluster.id);

    // Reseed (as entrypoint.ts does on every boot while SEED_ON_BOOT=true).
    await seedReferenceData(prisma);

    const afterReseed = await prisma.host.findFirstOrThrow({ where: { id: seeded.id } });
    const openAfterReseed = await prisma.hostClusterMembership.findFirstOrThrow({
      where: { hostId: seeded.id, effectiveTo: null },
    });

    // The move survived: pointer NOT reset to the seed cluster, and it still equals
    // the open membership — the invariant holds.
    expect(afterReseed.clusterId).toBe(destCluster.id);
    expect(afterReseed.clusterId).not.toBe(seedCluster.id);
    expect(openAfterReseed.clusterId).toBe(destCluster.id);
    expect(afterReseed.clusterId).toBe(openAfterReseed.clusterId);

    // No duplicate open membership was created by the reseed.
    const openRows = await prisma.hostClusterMembership.findMany({
      where: { hostId: seeded.id, effectiveTo: null },
    });
    expect(openRows).toHaveLength(1);
  });
});
