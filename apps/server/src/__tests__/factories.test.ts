import { describe, expect, it } from 'vitest';

import { makeCluster, makeHost, makeSession, makeUser } from './factories.js';
import { prisma } from './setup.js';

describe('test factories', () => {
  it('makeHost honours the state option and defaults to in_service', async () => {
    const { id: clusterId } = await makeCluster(prisma);
    const { id: defaultId } = await makeHost(prisma, { clusterId });
    const { id: orderedId } = await makeHost(prisma, { clusterId, state: 'ordered' });

    const rows = await prisma.host.findMany({ where: { id: { in: [defaultId, orderedId] } } });
    const stateById = new Map(rows.map((h) => [h.id, h.state]));
    expect(stateById.get(defaultId)).toBe('in_service');
    expect(stateById.get(orderedId)).toBe('ordered');
  });

  it('makeCluster gives a vsphere baseline row a real observedAt, and a manual one none', async () => {
    // THE FIXTURE INVARIANT, pinned because losing it is invisible.
    //
    // `absorbed` in forecast.ts keys off `observedAt`, and a `vsphere` row with
    // `observedAt: null` is a state production cannot produce —
    // `VsphereSnapshotService` is the sole writer of both columns and derives them
    // from one `measuredAt`. A factory that left the column null would still build
    // clusters that LOOK synced, so every absorption test would silently exercise
    // the broken-invariant fail-safe branch instead of the boundary it names. That
    // is exactly what happened to the regression corpus for defects 1-6.
    const capturedAt = new Date(Date.UTC(2026, 5, 1));
    const synced = await makeCluster(prisma, {
      baselineSource: 'vsphere',
      baselineDate: capturedAt,
      extraBaselines: [{ metricKey: 'memory_gb', capturedAt: new Date(Date.UTC(2026, 6, 1)) }],
    });
    const manual = await makeCluster(prisma, { baselineDate: capturedAt });

    const syncedRow = await prisma.clusterBaselineHistory.findFirstOrThrow({
      where: { clusterId: synced.id, capturedAt },
    });
    expect(syncedRow.source).toBe('vsphere');
    expect(syncedRow.observedAt).not.toBeNull();
    // Equal to `capturedAt` — what `startOfUtcMonth(measuredAt)` and `measuredAt`
    // collapse to for a row no edit has re-dated.
    expect(syncedRow.observedAt?.toISOString()).toBe(capturedAt.toISOString());

    const manualRow = await prisma.clusterBaselineHistory.findFirstOrThrow({
      where: { clusterId: manual.id, capturedAt },
    });
    expect(manualRow.source).toBe('manual');
    expect(manualRow.observedAt).toBeNull();

    // Extra baselines follow the same rule off their OWN source, which defaults to
    // manual even on a cluster whose primary row is synced.
    const extraRow = await prisma.clusterBaselineHistory.findFirstOrThrow({
      where: { clusterId: synced.id, capturedAt: new Date(Date.UTC(2026, 6, 1)) },
    });
    expect(extraRow.source).toBe('manual');
    expect(extraRow.observedAt).toBeNull();
  });

  it('makeCluster still lets a test fabricate the unreachable null-observedAt vsphere row', async () => {
    // The escape hatch the fail-safe tests need. An explicit `null` must be
    // honoured rather than re-derived, or the broken-invariant guard in
    // `absorbed` becomes untestable through the factory.
    const capturedAt = new Date(Date.UTC(2026, 5, 1));
    const cluster = await makeCluster(prisma, {
      baselineSource: 'vsphere',
      baselineDate: capturedAt,
      observedAt: null,
    });
    const row = await prisma.clusterBaselineHistory.findFirstOrThrow({
      where: { clusterId: cluster.id },
    });
    expect(row.source).toBe('vsphere');
    expect(row.observedAt).toBeNull();
  });

  it('makeUser defaults to ADMIN and makeSession creates a session bound to it', async () => {
    const admin = await makeUser(prisma);
    expect(admin.role).toBe('ADMIN');
    const viewer = await makeUser(prisma, { role: 'VIEWER', email: null });
    expect(viewer.role).toBe('VIEWER');
    expect(viewer.email).toBeNull();

    const { tokenHash } = await makeSession(prisma, { userId: admin.id });
    const session = await prisma.session.findUnique({ where: { tokenHash } });
    expect(session?.userId).toBe(admin.id);
    expect(session?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
