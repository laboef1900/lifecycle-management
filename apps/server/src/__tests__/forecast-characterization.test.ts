import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ForecastService } from '../services/forecast-loader.js';
import { makeApplication, makeCluster, makeEvent, makeHost } from './factories.js';
import { prisma } from './setup.js';

/**
 * CHARACTERIZATION SNAPSHOT of the forecast engine.
 *
 * This suite asserts **sameness, not correctness**. It captures what
 * `ForecastService.forCluster` produces today — bugs included — so that the
 * append-only baseline migration (#177) can prove it changed nothing it did not
 * intend to change. Any diff in the committed snapshot is a behaviour change
 * that must be explained in the PR body or reverted.
 *
 * @ai-warning It only means anything because it landed BEFORE the migration and
 * passed against unmodified `dev`. A snapshot written inside the migration PR
 * would merely record whatever the new code happens to do, and no reviewer could
 * tell the difference. If you are tempted to update the snapshot to make a build
 * pass, you are deleting the only evidence the migration was behaviour-preserving.
 *
 * @ai-context Determinism has three sources of rot, all pinned deliberately:
 *   1. The clock — `ClustersService.firstOfCurrentMonth()` and `scenario.ts` call
 *      `new Date()`, so anything derived from "now" drifts on the 1st of a month.
 *      Pinned with `vi.setSystemTime` (the first server-side use in this repo).
 *   2. Ids — `cuid()`s differ every run and surface in `hosts[].id` /
 *      `applications[].id`. Pinned via the factories' explicit `id` option.
 *   3. The forecast window — the default derives `fromMonth` from the baseline
 *      and `toMonth` from a horizon, so every call passes an explicit window.
 * `host-projection.ts` contains no `new Date()`, so nothing else leaks the clock
 * into this path.
 */

const FIXED_NOW = new Date('2026-06-15T12:00:00.000Z');
const FROM = new Date(Date.UTC(2026, 4, 1)); // 2026-05
const TO = new Date(Date.UTC(2027, 3, 1)); // 2027-04
const TENANT = 'default';

let service: ForecastService;

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  service = new ForecastService(prisma);
});

afterAll(() => {
  vi.useRealTimers();
});

describe('forecast characterization (behaviour as of pre-#177 dev)', () => {
  it('single-metric cluster with one baseline and no tracked entities', async () => {
    const cluster = await makeCluster(prisma, {
      id: 'fc-single-plain',
      name: 'fc-single-plain',
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 4000,
      baselineCapacity: 7680,
    });

    const result = await service.forCluster(TENANT, cluster.id, 'memory_gb', {
      fromMonth: FROM,
      toMonth: TO,
    });
    expect(result).toMatchSnapshot();
  });

  /**
   * The mixed quadrant: a NON-ZERO baselineCapacity alongside hosts that carry
   * real capacity. `forecast.ts:117-122` adds hosts to the baseline rather than
   * treating them as the total, so capacity here is baseline + Σ hosts. That is
   * today's behaviour and this snapshot records it verbatim — including the
   * double-count it implies. See the epic #172 design gate (§D34).
   */
  it('hosts are ADDITIVE to a non-zero baselineCapacity (the mixed quadrant)', async () => {
    const cluster = await makeCluster(prisma, {
      id: 'fc-mixed-quadrant',
      name: 'fc-mixed-quadrant',
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 4000,
      baselineCapacity: 7680,
    });
    await makeHost(prisma, {
      id: 'fc-mixed-host-a',
      clusterId: cluster.id,
      name: 'fc-mixed-host-a',
      commissionedAt: new Date(Date.UTC(2026, 4, 1)),
      initialCapacity: [{ effectiveFrom: new Date(Date.UTC(2026, 4, 1)), amount: 1024 }],
    });

    const result = await service.forCluster(TENANT, cluster.id, 'memory_gb', {
      fromMonth: FROM,
      toMonth: TO,
    });
    expect(result).toMatchSnapshot();
  });

  it('zero baselineCapacity with hosts carrying all capacity, incl. a capacity step', async () => {
    const cluster = await makeCluster(prisma, {
      id: 'fc-hosts-carry-all',
      name: 'fc-hosts-carry-all',
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 3000,
      baselineCapacity: 0,
    });
    await makeHost(prisma, {
      id: 'fc-step-host-a',
      clusterId: cluster.id,
      name: 'fc-step-host-a',
      commissionedAt: new Date(Date.UTC(2026, 4, 1)),
      initialCapacity: [
        { effectiveFrom: new Date(Date.UTC(2026, 4, 1)), amount: 2048 },
        { effectiveFrom: new Date(Date.UTC(2026, 9, 1)), amount: 4096 },
      ],
    });
    await makeHost(prisma, {
      id: 'fc-step-host-b',
      clusterId: cluster.id,
      name: 'fc-step-host-b',
      commissionedAt: new Date(Date.UTC(2026, 7, 1)),
      initialCapacity: [{ effectiveFrom: new Date(Date.UTC(2026, 7, 1)), amount: 2048 }],
    });

    const result = await service.forCluster(TENANT, cluster.id, 'memory_gb', {
      fromMonth: FROM,
      toMonth: TO,
    });
    expect(result).toMatchSnapshot();
  });

  /**
   * A host commissioned AFTER the window opens contributes 0 until then
   * (`forecast.ts:177`), and `forecast.ts:138` renders zero capacity as 0%
   * utilization — i.e. "maximum headroom, healthy" where the truth is unknown.
   * Recorded deliberately: #177 changes this to `null` per the gate's Q9d, so
   * THIS snapshot is expected to diff there, and only here.
   */
  it('zero-capacity months render as 0% utilization', async () => {
    const cluster = await makeCluster(prisma, {
      id: 'fc-zero-capacity',
      name: 'fc-zero-capacity',
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 500,
      baselineCapacity: 0,
    });
    await makeHost(prisma, {
      id: 'fc-late-host',
      clusterId: cluster.id,
      name: 'fc-late-host',
      commissionedAt: new Date(Date.UTC(2026, 9, 1)),
      initialCapacity: [{ effectiveFrom: new Date(Date.UTC(2026, 9, 1)), amount: 1024 }],
    });

    const result = await service.forCluster(TENANT, cluster.id, 'memory_gb', {
      fromMonth: FROM,
      toMonth: TO,
    });
    expect(result).toMatchSnapshot();
  });

  /**
   * An application backdated BEFORE the baseline. Its memory is already inside
   * the measured baselineConsumption and is added again (`forecast.ts:126-130`).
   * This is the delta-absorption double-count reachable on `dev` today; the
   * snapshot records it as-is.
   */
  it('applications are additive, including one backdated before the baseline', async () => {
    const cluster = await makeCluster(prisma, {
      id: 'fc-apps',
      name: 'fc-apps',
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 4000,
      baselineCapacity: 8192,
    });
    await makeApplication(prisma, {
      id: 'fc-app-backdated',
      clusterId: cluster.id,
      name: 'fc-app-backdated',
      startedAt: new Date(Date.UTC(2026, 0, 1)),
      initialAllocation: [{ effectiveFrom: new Date(Date.UTC(2026, 0, 1)), amount: 256 }],
    });
    await makeApplication(prisma, {
      id: 'fc-app-future',
      clusterId: cluster.id,
      name: 'fc-app-future',
      startedAt: new Date(Date.UTC(2026, 8, 1)),
      initialAllocation: [{ effectiveFrom: new Date(Date.UTC(2026, 8, 1)), amount: 880 }],
    });

    const result = await service.forCluster(TENANT, cluster.id, 'memory_gb', {
      fromMonth: FROM,
      toMonth: TO,
    });
    expect(result).toMatchSnapshot();
  });

  it('events with consumption and capacity deltas', async () => {
    const cluster = await makeCluster(prisma, {
      id: 'fc-events',
      name: 'fc-events',
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 4000,
      baselineCapacity: 8192,
    });
    await makeEvent(prisma, {
      id: 'fc-event-consumption',
      clusterId: cluster.id,
      title: 'fc-event-consumption',
      effectiveDate: new Date(Date.UTC(2026, 6, 1)),
      consumptionDelta: 500,
    });
    await makeEvent(prisma, {
      id: 'fc-event-capacity',
      clusterId: cluster.id,
      title: 'fc-event-capacity',
      effectiveDate: new Date(Date.UTC(2026, 9, 1)),
      consumptionDelta: null,
      capacityDelta: 2560,
    });

    const result = await service.forCluster(TENANT, cluster.id, 'memory_gb', {
      fromMonth: FROM,
      toMonth: TO,
    });
    expect(result).toMatchSnapshot();
  });

  /**
   * The multi-metric case — the one the #177 semantic change actually touches.
   * `Cluster.baselineDate` is ONE date shared by every metric today; after the
   * migration each baseline row carries its own `capturedAt`. The backfill sets
   * them all to the cluster's baselineDate, so this snapshot must not move.
   */
  it('multi-metric cluster shares one cluster-level baselineDate across metrics', async () => {
    await prisma.metricType.upsert({
      where: { key: 'fc_cpu_cores' },
      update: {},
      create: { key: 'fc_cpu_cores', displayName: 'CPU (characterization)', unit: 'cores' },
    });

    const cluster = await makeCluster(prisma, {
      id: 'fc-multi-metric',
      name: 'fc-multi-metric',
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 4000,
      baselineCapacity: 8192,
    });
    const cpuMetric = await prisma.metricType.findUniqueOrThrow({
      where: { key: 'fc_cpu_cores' },
    });
    await prisma.clusterMetricBaseline.create({
      data: {
        clusterId: cluster.id,
        tenantId: TENANT,
        metricTypeId: cpuMetric.id,
        baselineConsumption: 32,
        baselineCapacity: 128,
      },
    });

    const memory = await service.forCluster(TENANT, cluster.id, 'memory_gb', {
      fromMonth: FROM,
      toMonth: TO,
    });
    const cpu = await service.forCluster(TENANT, cluster.id, 'fc_cpu_cores', {
      fromMonth: FROM,
      toMonth: TO,
    });
    expect({ memory, cpu }).toMatchSnapshot();
  });

  it('archived cluster still forecasts', async () => {
    const cluster = await makeCluster(prisma, {
      id: 'fc-archived',
      name: 'fc-archived',
      baselineDate: new Date(Date.UTC(2026, 4, 1)),
      baselineConsumption: 1000,
      baselineCapacity: 4096,
    });
    await prisma.cluster.update({
      where: { id: cluster.id },
      data: { archivedAt: new Date(Date.UTC(2026, 5, 1)) },
    });

    const result = await service.forCluster(TENANT, cluster.id, 'memory_gb', {
      fromMonth: FROM,
      toMonth: TO,
    });
    expect(result).toMatchSnapshot();
  });

  /**
   * The default window derives fromMonth from the cluster's baselineDate
   * (`forecast-loader.ts:109`). #177 re-points that at the newest baseline's
   * `capturedAt`; with a single baseline the backfill makes them identical, so
   * this must not move either.
   */
  it('default window anchors on the cluster baselineDate', async () => {
    const cluster = await makeCluster(prisma, {
      id: 'fc-default-window',
      name: 'fc-default-window',
      baselineDate: new Date(Date.UTC(2026, 2, 1)),
      baselineConsumption: 2000,
      baselineCapacity: 4096,
    });

    const result = await service.forCluster(TENANT, cluster.id, 'memory_gb');
    expect({ fromMonth: result.fromMonth, toMonth: result.toMonth }).toMatchSnapshot();
  });
});
