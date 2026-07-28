import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Prisma } from '@prisma/client';

import { buildServer } from '../server.js';
import { makeCluster, makeEvent, makeHost } from './factories.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

let server: FastifyInstance;
let clusterId: string;

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});

beforeEach(async () => {
  const cluster = await makeCluster(prisma, {
    baselineConsumption: 3378,
    baselineCapacity: 7680,
  });
  clusterId = cluster.id;
});

afterAll(async () => {
  await server.close();
});

describe('GET /api/clusters/:id/forecast', () => {
  it('returns 24 months by default starting at the baseline date', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=memory_gb`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      fromMonth: string;
      toMonth: string;
      months: Array<{ month: string; consumption: number; capacity: number }>;
      effectiveThresholds: { warn: number; crit: number; source: string };
      procurement: {
        leadTimeWeeks: number;
        orderByDate: string | null;
        breachMonth: string | null;
      };
    };
    expect(body.fromMonth).toBe('2026-05-01');
    expect(body.toMonth).toBe('2028-05-01');
    expect(body.months).toHaveLength(25);
    expect(body.months[0]).toMatchObject({ consumption: 3378, capacity: 7680 });
    expect(body.effectiveThresholds).toEqual({
      warn: 0.7,
      crit: 0.9,
      source: 'tenant',
    });
    // The seeded cluster's forecast never crosses warn within the default
    // window, so orderByDate/breachMonth are null; leadTimeWeeks falls back to
    // the tenant default (8).
    expect(body.procurement).toEqual({
      leadTimeWeeks: 8,
      orderByDate: null,
      breachMonth: null,
    });
  });

  it('honors from/to query parameters', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=memory_gb&from=2026-06&to=2026-08`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      months: Array<{ month: string }>;
    };
    expect(body.months.map((m) => m.month)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);
  });

  it('folds host capacity and application allocation into the time series', async () => {
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: {
        name: 'host-1',
        commissionedAt: '2026-07-01',
        capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-07-01', amount: 1024 }],
      },
    });
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: {
        kind: 'application',
        name: 'app-1',
        category: 'openshift',
        effectiveDate: '2026-08-01',
        allocations: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2026-08-01', amount: 200 }],
      },
    });
    await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/items`,
      payload: {
        kind: 'event',
        metricTypeKey: 'memory_gb',
        effectiveDate: '2026-09-01',
        category: 'growth',
        name: 'Q3 growth',
        consumptionDelta: 100,
      },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=memory_gb&from=2026-06&to=2026-09`,
    });
    const body = response.json() as {
      months: Array<{ month: string; consumption: number; capacity: number }>;
      hosts: Array<{ name: string; contributions: Array<{ month: string; amount: number }> }>;
      applications: Array<{
        name: string;
        contributions: Array<{ month: string; amount: number }>;
      }>;
      events: Array<{ title: string }>;
    };

    const byMonth = Object.fromEntries(body.months.map((m) => [m.month, m]));
    expect(byMonth['2026-06-01']).toMatchObject({ consumption: 3378, capacity: 7680 });
    expect(byMonth['2026-07-01']).toMatchObject({ consumption: 3378, capacity: 8704 });
    expect(byMonth['2026-08-01']).toMatchObject({ consumption: 3578, capacity: 8704 });
    expect(byMonth['2026-09-01']).toMatchObject({ consumption: 3678, capacity: 8704 });
    expect(body.hosts).toHaveLength(1);
    expect(body.hosts[0]?.contributions).toEqual([
      { month: '2026-06-01', amount: 0 },
      { month: '2026-07-01', amount: 1024 },
      { month: '2026-08-01', amount: 1024 },
      { month: '2026-09-01', amount: 1024 },
    ]);
    expect(body.applications[0]?.contributions).toContainEqual({
      month: '2026-08-01',
      amount: 200,
    });
    expect(body.events.map((e) => e.title)).toEqual(['Q3 growth']);
  });

  it('returns 404 when the cluster does not exist', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/clusters/missing/forecast?metric=memory_gb',
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 400 (not 500) for a range spanning thousands of years', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=memory_gb&from=0001-01&to=9999-12`,
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 (not 500) for an inverted range', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=memory_gb&from=2027-01&to=2026-01`,
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 422 (not 500) when a lone `to` far in the future bypasses the schema pair-check', async () => {
    // No `from` means the schema's pair-refines don't apply (they short-circuit
    // on a missing side); `fromMonth` falls back to the cluster's baseline
    // date server-side, so only the forecast-loader's own cap can catch this.
    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=memory_gb&to=9999-12`,
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe('RANGE_TOO_LARGE');
  });

  it('returns 422 when the metric is unknown', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=plutonium_kg`,
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: { code: string } }).error.code).toBe('UNKNOWN_METRIC');
  });

  it('exposes projectedDecommissionAt on each forecast host entry', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/hosts`,
      payload: {
        name: 'h-eol',
        commissionedAt: '2024-01-01',
        eolAt: '2027-06-01',
        capacities: [{ metricTypeKey: 'memory_gb', effectiveFrom: '2024-01-01', amount: 256 }],
      },
    });
    expect(createRes.statusCode).toBe(201);

    const forecast = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=memory_gb&from=2026-01&to=2028-01`,
    });
    expect(forecast.statusCode).toBe(200);
    const body = forecast.json() as {
      hosts: Array<{ name: string; projectedDecommissionAt: string | null }>;
    };
    const hEol = body.hosts.find((h) => h.name === 'h-eol');
    expect(hEol?.projectedDecommissionAt).toBe('2027-06-01');
  });

  it('returns 422 when the cluster does not track that metric', async () => {
    // The seed cluster only has memory_gb. Add a new metric type and ask for it.
    await prisma.metricType.upsert({
      where: { key: 'cpu_cores' },
      update: { displayName: 'CPU', unit: 'cores' },
      create: { key: 'cpu_cores', displayName: 'CPU', unit: 'cores' },
    });
    try {
      const response = await server.inject({
        method: 'GET',
        url: `/api/clusters/${clusterId}/forecast?metric=cpu_cores`,
      });
      expect(response.statusCode).toBe(422);
      expect((response.json() as { error: { code: string } }).error.code).toBe(
        'METRIC_NOT_TRACKED',
      );
    } finally {
      await prisma.metricType.deleteMany({ where: { key: 'cpu_cores' } });
    }
  });

  it('keeps forecasts independent per metric on a multi-metric cluster', async () => {
    const cpu = await prisma.metricType.upsert({
      where: { key: 'cpu_cores' },
      update: {},
      create: { key: 'cpu_cores', displayName: 'CPU', unit: 'cores' },
    });
    try {
      await prisma.clusterBaselineHistory.create({
        data: {
          tenantId: 'default',
          clusterId,
          metricTypeId: cpu.id,
          capturedAt: new Date(Date.UTC(2026, 4, 1)),
          source: 'manual',
          baselineConsumption: new Prisma.Decimal(100),
          baselineCapacity: new Prisma.Decimal(400),
        },
      });
      await makeHost(prisma, {
        clusterId,
        metricKey: 'memory_gb',
        initialCapacity: [{ effectiveFrom: new Date('2026-05-01T00:00:00.000Z'), amount: 512 }],
      });
      await makeHost(prisma, {
        clusterId,
        metricKey: 'cpu_cores',
        initialCapacity: [{ effectiveFrom: new Date('2026-05-01T00:00:00.000Z'), amount: 64 }],
      });
      await makeEvent(prisma, {
        clusterId,
        metricKey: 'cpu_cores',
        effectiveDate: new Date('2026-05-01T00:00:00.000Z'),
        consumptionDelta: 50,
      });

      const mem = await server.inject({
        method: 'GET',
        url: `/api/clusters/${clusterId}/forecast?metric=memory_gb`,
      });
      const cpuRes = await server.inject({
        method: 'GET',
        url: `/api/clusters/${clusterId}/forecast?metric=cpu_cores`,
      });

      expect(mem.statusCode).toBe(200);
      expect(cpuRes.statusCode).toBe(200);
      const memBody = mem.json() as {
        months: Array<{ consumption: number; capacity: number }>;
      };
      const cpuBody = cpuRes.json() as {
        months: Array<{ consumption: number; capacity: number }>;
      };
      // 7680 + 512 mem host only; the cpu host/event must not leak in.
      expect(memBody.months[0]).toMatchObject({ consumption: 3378, capacity: 8192 });
      // 100 + 50 cpu event, 400 + 64 cpu host only; mem data must not leak in.
      expect(cpuBody.months[0]).toMatchObject({ consumption: 150, capacity: 464 });
    } finally {
      await prisma.cluster.deleteMany({ where: { id: clusterId } });
      await prisma.metricType.deleteMany({ where: { key: 'cpu_cores' } });
    }
  });
});

describe('POST /api/clusters/:id/forecast/scenario', () => {
  it('applies an add_vms scenario and returns higher consumption than the baseline', async () => {
    const base = await server.inject({
      method: 'GET',
      url: `/api/clusters/${clusterId}/forecast?metric=memory_gb&from=2026-06&to=2026-08`,
    });
    const baseBody = base.json() as {
      months: Array<{ month: string; consumption: number }>;
    };
    const baselineLast = baseBody.months[baseBody.months.length - 1]!.consumption;

    const scenario = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/forecast/scenario?metric=memory_gb&from=2026-06&to=2026-08`,
      payload: { kind: 'add_vms', count: 50, sizeGb: 16, startMonth: '2026-06' },
    });
    expect(scenario.statusCode).toBe(200);
    const scenarioBody = scenario.json() as {
      months: Array<{ month: string; consumption: number }>;
    };
    const scenarioLast = scenarioBody.months[scenarioBody.months.length - 1]!.consumption;
    // 50 × 16 GB = 800 GB added every month starting 2026-06.
    expect(scenarioLast - baselineLast).toBe(800);
  });

  it('rejects an invalid scenario kind with 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/forecast/scenario?metric=memory_gb`,
      payload: { kind: 'nope' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the cluster does not exist', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/clusters/clbogusclubogusclubogus0/forecast/scenario?metric=memory_gb',
      payload: { kind: 'lose_hosts', count: 1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects lose_hosts with count < 1', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/clusters/${clusterId}/forecast/scenario?metric=memory_gb`,
      payload: { kind: 'lose_hosts', count: 0 },
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * COMPOUND WHAT-IFS (#323). The request contract accepts either a bare single
 * scenario — every case above, which must keep working for an older SPA against
 * a newer server — or a `{ steps: [...] }` stack normalised to the same shape.
 */
describe('POST /api/clusters/:id/forecast/scenario — compound stack (#323)', () => {
  /**
   * Every date here is RELATIVE TO THE REAL CLOCK, and that is deliberate.
   *
   * `delay_procurement` only shifts commissions dated after `new Date()`, so the
   * window has to contain a future commissioning step or the step is a no-op and
   * this whole block silently degenerates into a test of `add_vms` alone — the
   * exact vacuity AI review found in its first version. Hard-coded months would
   * have re-created that the moment the wall clock passed them: the original
   * `2027-06-01` fixture had a roughly 11-month shelf life, after which the block
   * would have gone quietly green-and-meaningless.
   *
   * Fake timers are not an option at the HTTP-injection layer, so the fixture
   * moves with the clock instead. The cluster's own baseline is relative too —
   * `lose_hosts` ranks by capacity at the BASELINE date, so a relative host
   * against the factory's fixed default would eventually rank as 0 and drop the
   * wrong host.
   */
  const monthStartUtc = (offsetMonths: number): Date => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
  };
  const monthParam = (date: Date): string =>
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

  const BASELINE_MONTH = monthStartUtc(0);
  const DEPLOYED_MONTH = monthStartUtc(-6); // always past, always before the baseline
  const COMMISSION_MONTH = monthStartUtc(6); // always future, always inside the window
  const FROM_MONTH = monthStartUtc(1);
  const TO_MONTH = monthStartUtc(12);
  const WINDOW = `metric=memory_gb&from=${monthParam(FROM_MONTH)}&to=${monthParam(TO_MONTH)}`;

  /**
   * @ai-warning This fixture is load-bearing, not scenery. AI review of the first
   * version of this block found every test ran against `makeCluster`'s host-less
   * cluster, where `lose_hosts` and `delay_procurement` both do nothing — so a
   * route that folded only `steps[0]` kept the whole block green. Each step must
   * be provably EFFECTIVE here, which the "must move the forecast" preconditions
   * below assert before anything compares compounds.
   */
  let compoundClusterId: string;

  beforeEach(async () => {
    const cluster = await makeCluster(prisma, {
      baselineDate: BASELINE_MONTH,
      baselineConsumption: 3378,
      baselineCapacity: 7680,
    });
    compoundClusterId = cluster.id;

    // Already deployed with real recorded capacity — the host `lose_hosts` ranks
    // first and drops, removing capacity across the whole window.
    await makeHost(prisma, {
      clusterId: compoundClusterId,
      name: 'compound-deployed',
      commissionedAt: DEPLOYED_MONTH,
      initialCapacity: [{ effectiveFrom: DEPLOYED_MONTH, amount: 2048 }],
    });
    // Commissions INSIDE the window and in the future — the step
    // `delay_procurement` pushes it out beyond `toMonth`.
    await makeHost(prisma, {
      clusterId: compoundClusterId,
      name: 'compound-future',
      commissionedAt: COMMISSION_MONTH,
      initialCapacity: [{ effectiveFrom: COMMISSION_MONTH, amount: 512 }],
    });
  });

  // Narrowed to what these tests read, so no direct dependency on fastify's
  // transitive `light-my-request` types is needed.
  const post = (payload: Record<string, unknown>): Promise<{ statusCode: number; body: string }> =>
    server.inject({
      method: 'POST',
      url: `/api/clusters/${compoundClusterId}/forecast/scenario?${WINDOW}`,
      payload,
    });

  const LOSE = { kind: 'lose_hosts', count: 1 } as const;
  const ADD = { kind: 'add_vms', count: 50, sizeGb: 16, startMonth: monthParam(FROM_MONTH) };
  // 12 months pushes a commission at +6 out past the window end at +12.
  const DELAY = { kind: 'delay_procurement', months: 12 } as const;

  const series = (raw: string): string =>
    JSON.stringify(
      (JSON.parse(raw) as { months: Array<{ consumption: number; capacity: number }> }).months,
    );

  it('folds EVERY step — the compound differs from each single step in isolation', async () => {
    const base = await server.inject({
      method: 'GET',
      url: `/api/clusters/${compoundClusterId}/forecast?${WINDOW}`,
    });
    expect(base.statusCode).toBe(200);

    const singles = {
      lose: await post({ steps: [LOSE] }),
      add: await post({ steps: [ADD] }),
      delay: await post({ steps: [DELAY] }),
    };

    // PRECONDITION, and the whole point of the fixture: each step on its own must
    // actually move the forecast. Without this the "differs from each single"
    // assertions below would pass against a route that ignored steps entirely.
    for (const [name, res] of Object.entries(singles)) {
      expect(res.statusCode, name).toBe(200);
      expect(series(res.body), `${name} alone must move the forecast`).not.toBe(series(base.body));
    }

    const compound = await post({ steps: [LOSE, ADD, DELAY] });
    expect(compound.statusCode).toBe(200);

    // If the route folded only the first canonically-ordered step, the compound
    // would be byte-identical to `lose` — this is the assertion that kills that.
    for (const [name, res] of Object.entries(singles)) {
      expect(series(compound.body), `compound collapsed to the ${name} step alone`).not.toBe(
        series(res.body),
      );
    }
    expect(series(compound.body)).not.toBe(series(base.body));
  });

  it("composes the parts: the compound carries each step's own effect", async () => {
    const base = await server.inject({
      method: 'GET',
      url: `/api/clusters/${compoundClusterId}/forecast?${WINDOW}`,
    });
    const baseMonths = (
      JSON.parse(base.body) as {
        months: Array<{ consumption: number; capacity: number }>;
      }
    ).months;

    const compound = await post({ steps: [LOSE, ADD, DELAY] });
    const compoundMonths = (
      JSON.parse(compound.body) as {
        months: Array<{ consumption: number; capacity: number }>;
      }
    ).months;

    // add_vms: +50 × 16 GB = +800 GB of consumption from the window's first
    // month (`FROM_MONTH`) onward.
    expect(compoundMonths[0]!.consumption - baseMonths[0]!.consumption).toBe(800);

    // lose_hosts dropped the 2048 GB deployed host, and delay_procurement pushed
    // the 512 GB commissioning step past `toMonth` — so the LAST month lost both.
    const lastBase = baseMonths[baseMonths.length - 1]!;
    const lastCompound = compoundMonths[compoundMonths.length - 1]!;
    expect(lastBase.capacity - lastCompound.capacity).toBe(2048 + 512);
  });

  it('gives the same answer whichever order the steps arrive in', async () => {
    const forward = await post({ steps: [LOSE, ADD, DELAY] });
    const reversed = await post({ steps: [DELAY, ADD, LOSE] });
    expect(forward.statusCode).toBe(200);
    expect(reversed.statusCode).toBe(200);
    // Byte-identical, not merely equal totals: the canonical fold order must also
    // fix the response's `hosts[]`/`applications[]` ordering.
    expect(reversed.body).toBe(forward.body);
  });

  it('still accepts a bare single scenario (wire back-compat for an older SPA)', async () => {
    const bare = await post(ADD);
    const wrapped = await post({ steps: [ADD] });
    expect(bare.statusCode).toBe(200);
    expect(wrapped.statusCode).toBe(200);
    expect(wrapped.body).toBe(bare.body);
  });

  /**
   * The ambiguity guard. A body carrying BOTH shapes used to answer 200 with the
   * bare scenario alone, silently discarding `steps` — and, because the whole key
   * was dropped, it also bypassed the step cap and the duplicate-kind rule. A
   * silently narrowed forecast is the worst outcome for an endpoint that drives
   * purchasing, so this is a 400. (AI review finding; reproduced end to end.)
   */
  it('rejects a body carrying BOTH a bare scenario and a steps array', async () => {
    const ambiguous = await post({ ...LOSE, steps: [ADD, DELAY] });
    expect(ambiguous.statusCode).toBe(400);
  });

  it('does not let a bare scenario smuggle a stack past the cap or the uniqueness rule', async () => {
    // Both of these were 200 before the guard, silently previewing `LOSE` alone.
    const overCap = await post({
      ...LOSE,
      steps: [LOSE, ADD, DELAY, { kind: 'lose_hosts', count: 2 }],
    });
    const duplicate = await post({
      ...LOSE,
      steps: [
        { kind: 'add_vms', count: 10, sizeGb: 16 },
        { kind: 'add_vms', count: 10, sizeGb: 16 },
      ],
    });
    expect(overCap.statusCode).toBe(400);
    expect(duplicate.statusCode).toBe(400);
  });

  it('rejects a duplicate kind with 400 — the id-collision guard', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/clusters/${compoundClusterId}/forecast/scenario?metric=memory_gb`,
      payload: {
        steps: [
          { kind: 'add_vms', count: 10, sizeGb: 16 },
          { kind: 'add_vms', count: 10, sizeGb: 16 },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a stack over the step cap with 400', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `/api/clusters/${compoundClusterId}/forecast/scenario?metric=memory_gb`,
      payload: {
        steps: [
          { kind: 'lose_hosts', count: 1 },
          { kind: 'add_vms', count: 1, sizeGb: 1 },
          { kind: 'delay_procurement', months: 1 },
          { kind: 'lose_hosts', count: 2 },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an empty stack and a mistyped container key with 400', async () => {
    const empty = await server.inject({
      method: 'POST',
      url: `/api/clusters/${compoundClusterId}/forecast/scenario?metric=memory_gb`,
      payload: { steps: [] },
    });
    const typo = await server.inject({
      method: 'POST',
      url: `/api/clusters/${compoundClusterId}/forecast/scenario?metric=memory_gb`,
      payload: { parts: [{ kind: 'lose_hosts', count: 1 }] },
    });
    expect(empty.statusCode).toBe(400);
    expect(typo.statusCode).toBe(400);
  });

  /**
   * INV-1 re-proof on the compound path. A hypothetical has no measured error
   * history and is never an approved order, so it must carry neither an
   * uncertainty band nor an acknowledgment — regardless of how many steps it has
   * or whether the band is switched on.
   *
   * @ai-warning On its own this assertion is NOT sufficient, and AI review was
   * right to call the first version vacuous: this cluster has no forecast
   * snapshots and no order approval, so `undefined`/`null` hold however the
   * scenario path is wired. The POSITIVE CONTROL — the real read on the same
   * cluster/window DOES produce a band and an acknowledgment, while the compound
   * does not — lives in `forecast-uncertainty.test.ts`. Keep both: this one pins
   * the HTTP shape, that one pins the invariant.
   */
  it('carries no uncertainty band and no acknowledgment (INV-1)', async () => {
    await prisma.tenantSettings.upsert({
      where: { tenantId: 'default' },
      update: { forecastUncertaintyBandEnabled: true },
      create: { tenantId: 'default', forecastUncertaintyBandEnabled: true },
    });

    const res = await server.inject({
      method: 'POST',
      url: `/api/clusters/${compoundClusterId}/forecast/scenario?${WINDOW}`,
      payload: {
        steps: [
          { kind: 'lose_hosts', count: 1 },
          { kind: 'add_vms', count: 10, sizeGb: 16, startMonth: '2026-06' },
          { kind: 'delay_procurement', months: 3 },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      acknowledgment: unknown;
      uncertainty?: unknown;
      uncertaintyAnchorCount?: unknown;
    };
    expect(body.acknowledgment).toBeNull();
    expect(body.uncertainty).toBeUndefined();
    expect(body.uncertaintyAnchorCount).toBeUndefined();
  });
});

/**
 * THE /forecast LOADER'S OWN ABSORPTION BOUNDARY.
 *
 * `absorbed` is fed from TWO independent places. `ClustersService.toResponse`
 * builds a per-metric input for `ClusterResponse.metrics`, and `ForecastService`
 * builds a different one here — different query, different window
 * (`fromMonth = startOfUtcMonth(anchor.capturedAt)`), and it is this one that
 * produces `procurement.breachMonth`, `procurement.orderByDate` and the 24-month
 * chart hardware purchasing is decided from. Coverage of one says nothing about
 * the other: before these tests, deleting the `baselineMeasuredAt` line in
 * forecast-loader.ts left the entire server suite green.
 *
 * The fixture separates the two candidate boundaries by a month, which is the
 * only way to tell them apart. `capturedAt` (the operator-editable LABEL) is
 * April; `observedAt` (the immutable polling instant) is mid-May; the
 * `capacityDelta` lands on 1 May — after the label, at-or-before the measurement.
 * Absorbing it is the measured-period reading; counting it is the label reading.
 */
describe('GET /api/clusters/:id/forecast — absorption keys off the measured period', () => {
  async function reAnchoredSyncedCluster(name: string): Promise<string> {
    const metric = await prisma.metricType.findUniqueOrThrow({ where: { key: 'memory_gb' } });
    const cluster = await prisma.cluster.create({
      data: {
        tenantId: 'default',
        name: `${name}-${Date.now().toString(36)}`,
        source: 'vsphere',
        baselineHistory: {
          create: {
            tenantId: 'default',
            metricTypeId: metric.id,
            // The LABEL, as a backward re-date through PUT /api/clusters/:id
            // would leave it.
            capturedAt: new Date(Date.UTC(2026, 3, 1)),
            source: 'vsphere',
            // The instant vCenter was actually polled — a month LATER than the
            // label, and untouched by any edit path.
            observedAt: new Date(Date.UTC(2026, 4, 15, 8, 40)),
            baselineConsumption: 1000,
            // Zero by the Q9a invariant: the synced hosts ARE the capacity.
            baselineCapacity: 0,
          },
        },
      },
    });
    await makeHost(prisma, {
      clusterId: cluster.id,
      name: `${name}-host-${Date.now().toString(36)}`,
      commissionedAt: new Date(Date.UTC(2026, 0, 1)),
      initialCapacity: [{ effectiveFrom: new Date(Date.UTC(2026, 0, 1)), amount: 2000 }],
    });
    await makeEvent(prisma, {
      clusterId: cluster.id,
      title: `${name}-capacity-${Date.now().toString(36)}`,
      // Between the label (April) and the measurement (May): inside the snapshot,
      // outside an April boundary.
      effectiveDate: new Date(Date.UTC(2026, 4, 1)),
      consumptionDelta: null,
      capacityDelta: 500,
    });
    return cluster.id;
  }

  it('does not re-add a measured capacityDelta the label was re-dated behind', async () => {
    const id = await reAnchoredSyncedCluster('loader-boundary');

    const res = await server.inject({
      method: 'GET',
      url: `/api/clusters/${id}/forecast?metric=memory_gb&from=2026-06&to=2026-06`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      months: Array<{ capacity: number; consumption: number; utilization: number | null }>;
    };

    // 2000, not 2500: May's +500 is already inside the May measurement. Under the
    // label boundary this endpoint reported 2500 and utilization 0.4 — 500 GB of
    // capacity invented by a date edit, feeding procurement.breachMonth.
    expect(body.months[0]?.capacity).toBe(2000);
    expect(body.months[0]?.consumption).toBe(1000);
    expect(body.months[0]?.utilization).toBe(0.5);
  });

  it('carries the same boundary into the scenario preview', async () => {
    // `forClusterWithScenario` runs `applyScenario` between load and compute, so
    // it inherits whatever `prepare` built. `lose_hosts: 1` removes the only host,
    // leaving capacity from the events alone — which makes the absorbed delta the
    // ENTIRE remaining capacity and so impossible to miss: 0 if absorbed, 500 if
    // the label boundary crept back in.
    const id = await reAnchoredSyncedCluster('loader-boundary-scenario');

    const res = await server.inject({
      method: 'POST',
      url: `/api/clusters/${id}/forecast/scenario?metric=memory_gb&from=2026-06&to=2026-06`,
      payload: { kind: 'lose_hosts', count: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { months: Array<{ capacity: number }> };
    expect(body.months[0]?.capacity).toBe(0);
  });

  it('reaches procurement.breachMonth, not just the month rows', async () => {
    // The number this whole path exists to produce, on the DEFAULT 24-month
    // window the UI actually requests. A September growth event takes consumption
    // to 1500. Against the absorbed capacity of 2000 that is 0.75 — at or above
    // the 0.7 warn threshold — so September breaches and an order date is
    // emitted. Re-add the measured delta and capacity is 2500, the same 1500
    // reads 0.60, and breachMonth comes back NULL: the purchase silently
    // disappears with nothing measured and no value submitted.
    const id = await reAnchoredSyncedCluster('loader-boundary-procurement');
    await makeEvent(prisma, {
      clusterId: id,
      title: `loader-growth-${Date.now().toString(36)}`,
      effectiveDate: new Date(Date.UTC(2026, 8, 1)),
      consumptionDelta: 500,
    });

    const res = await server.inject({
      method: 'GET',
      url: `/api/clusters/${id}/forecast?metric=memory_gb`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      months: Array<{ month: string; capacity: number; consumption: number }>;
      procurement: { breachMonth: string | null; orderByDate: string | null };
    };
    const september = body.months.find((m) => m.month === '2026-09-01');
    expect(september?.capacity).toBe(2000);
    expect(september?.consumption).toBe(1500);
    expect(body.procurement.breachMonth).toBe('2026-09-01');
    expect(body.procurement.orderByDate).not.toBeNull();
  });
});
