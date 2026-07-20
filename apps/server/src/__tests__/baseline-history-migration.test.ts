import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../server.js';
import { prisma } from './setup.js';
import { makeTestEnv } from './test-helpers.js';

/**
 * The `captured_at` normalisation carried by the contract migration
 * 20260719120000_drop_legacy_cluster_baselines.
 *
 * The expand migration (20260717120000) copied `clusters.baseline_date` VERBATIM
 * into `captured_at`, and that column stored whatever day an operator typed —
 * `dateOnly` in @lcm/shared is a bare `YYYY-MM-DD` regex with no first-of-month
 * refinement and the create dialog is a free `<input type="date">`. Every other
 * writer snaps through `startOfUtcMonth`, so a pre-#177 cluster can hold the one
 * mid-month row in the table, and once the legacy table is dropped that row wins
 * `MAX(captured_at)` and becomes the number the fleet console, the cluster panel
 * and the forecast all serve.
 *
 * These execute the REAL SQL, sliced out of the shipped migration file by its
 * step sentinels rather than restated here — a copy would keep passing after the
 * migration itself regressed. Testcontainers has already applied the migration to
 * an empty database by the time this runs, so the statements are replayed against
 * rows seeded here; both are idempotent by construction.
 */
const MIGRATION_SQL = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../prisma/migrations/20260719120000_drop_legacy_cluster_baselines/migration.sql',
);

function migrationStep(name: string): string {
  const sql = readFileSync(MIGRATION_SQL, 'utf8');
  const match = new RegExp(
    `-- lcm:step-start ${name}\\n([\\s\\S]*?)-- lcm:step-end ${name}`,
    'u',
  ).exec(sql);
  const body = match?.[1];
  if (body === undefined) {
    throw new Error(
      `Migration step "${name}" not found in ${MIGRATION_SQL}. The sentinels are load-bearing: ` +
        'this suite executes the shipped SQL rather than a copy of it.',
    );
  }
  return body;
}

async function normaliseCapturedAt(): Promise<void> {
  // Two statements, executed in the order the migration declares them: the
  // collision guard first, so a database that would lose a row never reaches the
  // UPDATE.
  await prisma.$executeRawUnsafe(migrationStep('normalise-captured-at-guard'));
  await prisma.$executeRawUnsafe(migrationStep('normalise-captured-at'));
}

let server: FastifyInstance;
let seq = 0;

beforeAll(async () => {
  server = await buildServer({ env: makeTestEnv(), prisma });
});

afterAll(async () => {
  await server.close();
});

async function clusterWithHistory(
  rows: readonly { capturedAt: Date; consumption: number; metricKey?: string }[],
): Promise<string> {
  seq += 1;
  const cluster = await prisma.cluster.create({
    data: { tenantId: 'default', name: `migration-${Date.now()}-${seq}` },
  });
  for (const row of rows) {
    const metric = await prisma.metricType.findUniqueOrThrow({
      where: { key: row.metricKey ?? 'memory_gb' },
    });
    // Raw SQL, not the Prisma factory: every application writer snaps the period
    // through `startOfUtcMonth`, so the mid-month state under test is one only the
    // backfill can produce.
    await prisma.$executeRaw`
      INSERT INTO "cluster_baseline_history" (
        "id", "cluster_id", "metric_type_id", "tenant_id",
        "captured_at", "source", "baseline_consumption", "baseline_capacity"
      ) VALUES (
        gen_random_uuid()::text, ${cluster.id}, ${metric.id}, 'default',
        ${row.capturedAt}::date, 'manual', ${row.consumption}, 1000
      )`;
  }
  return cluster.id;
}

describe('contract migration — captured_at normalisation', () => {
  it('snaps a mid-month backfilled captured_at to the first of its month', async () => {
    const clusterId = await clusterWithHistory([
      { capturedAt: new Date(Date.UTC(2026, 0, 15)), consumption: 100 },
    ]);

    await normaliseCapturedAt();

    const rows = await prisma.clusterBaselineHistory.findMany({ where: { clusterId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capturedAt.toISOString().slice(0, 10)).toBe('2026-01-01');
    // Re-anchored, never re-measured.
    expect(rows[0]?.baselineConsumption.toNumber()).toBe(100);

    // ...and the API now agrees with the ClusterResponse.baselineDate contract,
    // which documents the field as ALWAYS first-of-month.
    const res = await server.inject({ method: 'GET', url: `/api/clusters/${clusterId}` });
    expect((res.json() as { baselineDate: string }).baselineDate).toBe('2026-01-01');
  });

  it('leaves an already-snapped captured_at untouched', async () => {
    const clusterId = await clusterWithHistory([
      { capturedAt: new Date(Date.UTC(2026, 2, 1)), consumption: 250 },
    ]);

    await normaliseCapturedAt();

    const rows = await prisma.clusterBaselineHistory.findMany({ where: { clusterId } });
    expect(rows[0]?.capturedAt.toISOString().slice(0, 10)).toBe('2026-03-01');
  });

  it('refuses the migration when normalising would collide with a corrected row', async () => {
    // The state the dual-write release produces for a pre-#177 cluster whose
    // baseline was corrected: the expand backfill wrote the operator's raw
    // 2026-01-15, and the correction went through `startOfUtcMonth` to 2026-01-01.
    // The legacy table held only the correction, which is what `toResponse`
    // actually served — so the drop must not resolve this by an implicit tiebreak.
    const clusterId = await clusterWithHistory([
      { capturedAt: new Date(Date.UTC(2026, 0, 15)), consumption: 100 }, // stale backfill
      { capturedAt: new Date(Date.UTC(2026, 0, 1)), consumption: 250 }, // the correction
    ]);

    // Why the guard exists rather than a silent tiebreak: un-normalised,
    // MAX(captured_at) is the STALE mid-month row, so the API already serves the
    // pre-correction number with no error and no way to reach the correct row.
    const before = await prisma.clusterBaselineHistory.findFirst({
      where: { clusterId },
      orderBy: { capturedAt: 'desc' },
    });
    expect(before?.baselineConsumption.toNumber()).toBe(100);

    await expect(normaliseCapturedAt()).rejects.toThrow(/captured_at/iu);

    // Nothing was normalised away: both rows survive for operator-reviewed
    // cleanup, and `prisma migrate deploy` exits non-zero so Fastify never boots
    // on numbers nobody reconciled.
    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId },
      orderBy: { capturedAt: 'asc' },
    });
    expect(rows.map((r) => r.capturedAt.toISOString().slice(0, 10))).toEqual([
      '2026-01-01',
      '2026-01-15',
    ]);
    expect(rows.map((r) => r.baselineConsumption.toNumber())).toEqual([250, 100]);
  });

  it('does not refuse when two mid-month rows fall in different months', async () => {
    // Two rows that both need snapping but land on distinct periods lose nothing,
    // so the guard must not fire — a guard keyed on "any row needs snapping"
    // would fail the deploy for a database that normalises cleanly.
    const clusterId = await clusterWithHistory([
      { capturedAt: new Date(Date.UTC(2026, 3, 15)), consumption: 100 },
      { capturedAt: new Date(Date.UTC(2026, 4, 20)), consumption: 200 },
    ]);

    await normaliseCapturedAt();

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId },
      orderBy: { capturedAt: 'asc' },
    });
    expect(rows.map((r) => r.capturedAt.toISOString().slice(0, 10))).toEqual([
      '2026-04-01',
      '2026-05-01',
    ]);
    expect(rows.map((r) => r.baselineConsumption.toNumber())).toEqual([100, 200]);
  });

  it('groups by (cluster, metric, month) — not by month alone', async () => {
    // Nothing else in this suite constrains the guard's GROUP BY. Every other
    // collision fixture is one cluster and one metric, so a guard grouping on
    // `date_trunc('month', captured_at)` ALONE — or on (cluster, month) — passes
    // the whole file while refusing to deploy against any real database, where
    // dozens of clusters share every month by construction. That failure mode is
    // a blocked upgrade with a RAISE naming groups the operator cannot reconcile,
    // because there is nothing wrong with them.
    //
    // Two dimensions, both needed: two CLUSTERS colliding in one month pins
    // `cluster_id`, and two METRICS on one cluster in that same month pins
    // `metric_type_id`.
    await prisma.metricType.upsert({
      where: { key: 'cpu_cores_195m' },
      update: {},
      create: { key: 'cpu_cores_195m', displayName: 'CPU (migration test)', unit: 'cores' },
    });
    const first = await clusterWithHistory([
      { capturedAt: new Date(Date.UTC(2026, 8, 14)), consumption: 100 },
      { capturedAt: new Date(Date.UTC(2026, 8, 21)), consumption: 16, metricKey: 'cpu_cores_195m' },
    ]);
    const second = await clusterWithHistory([
      { capturedAt: new Date(Date.UTC(2026, 8, 9)), consumption: 200 },
    ]);

    // Three rows, all in September 2026, all mid-month — and not one group holds
    // more than one row, so nothing is at risk and the guard must stay silent.
    await expect(normaliseCapturedAt()).resolves.toBeUndefined();

    const rows = await prisma.clusterBaselineHistory.findMany({
      where: { clusterId: { in: [first, second] } },
      orderBy: { baselineConsumption: 'asc' },
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.capturedAt.toISOString().slice(0, 10) === '2026-09-01')).toBe(true);
    // Each row keeps its own number: snapping re-anchors, it never merges.
    expect(rows.map((r) => r.baselineConsumption.toNumber())).toEqual([16, 100, 200]);
  });

  it('runs before the legacy table is dropped', async () => {
    // Ordering is the whole point: normalising after the DROP would be a separate
    // migration nobody has written, and normalising after the read path switched
    // over is a release spent serving pre-correction numbers.
    const sql = readFileSync(MIGRATION_SQL, 'utf8');
    const normalise = sql.indexOf('-- lcm:step-start normalise-captured-at-guard');
    const drop = sql.indexOf('DROP TABLE "cluster_metric_baselines"');
    expect(normalise).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(-1);
    expect(normalise).toBeLessThan(drop);
  });
});

/**
 * GUARD 3 — the legacy value-comparison guard.
 *
 * The normalisation above closes the SAME-month case. The different-month case
 * survived it and was reproduced against the unmodified migration: a pre-#177
 * cluster whose dual-write-era correction re-anchored BACKWARDS leaves the stale
 * expand-migration backfill row holding MAX(captured_at), so after the DROP the
 * served value silently flips to the pre-correction number, unrecoverable through
 * the API. Both earlier guards pass — the (cluster, metric) history row exists,
 * and the two rows are in different months.
 *
 * It is detectable, and the migration's earlier comment claiming otherwise was
 * wrong: the guards run BEFORE the DROP, in the same transaction, with
 * `cluster_metric_baselines` still holding exactly what clients were being served.
 * Comparing the two is all it takes.
 *
 * These tests must materialise `cluster_metric_baselines` themselves: by the time
 * the suite runs, Testcontainers has already applied the whole migration chain and
 * the table is gone. The shape is the init migration's, and the fixture is dropped
 * again in `afterEach` so nothing leaks into the rest of the file (`maxWorkers: 1`,
 * so no other suite runs concurrently).
 */
describe('contract migration — guard 3, legacy vs. newest history values', () => {
  async function createLegacyTable(): Promise<void> {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "cluster_metric_baselines" (
        "cluster_id" TEXT NOT NULL,
        "metric_type_id" TEXT NOT NULL,
        "tenant_id" TEXT NOT NULL DEFAULT 'default',
        "baseline_consumption" DECIMAL(18,3) NOT NULL,
        "baseline_capacity" DECIMAL(18,3) NOT NULL,
        CONSTRAINT "cluster_metric_baselines_pkey" PRIMARY KEY ("cluster_id","metric_type_id")
      )`);
  }

  beforeEach(createLegacyTable);

  afterEach(async () => {
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "cluster_metric_baselines"');
  });

  async function seedLegacy(
    clusterId: string,
    consumption: number,
    capacity: number,
    metricKey = 'memory_gb',
  ): Promise<void> {
    const metric = await prisma.metricType.findUniqueOrThrow({ where: { key: metricKey } });
    await prisma.$executeRaw`
      INSERT INTO "cluster_metric_baselines" (
        "cluster_id", "metric_type_id", "tenant_id",
        "baseline_consumption", "baseline_capacity"
      ) VALUES (${clusterId}, ${metric.id}, 'default', ${consumption}, ${capacity})`;
  }

  async function historyRow(
    clusterId: string,
    row: { capturedAt: Date; consumption: number; capacity?: number; source?: string },
  ): Promise<void> {
    const metric = await prisma.metricType.findUniqueOrThrow({ where: { key: 'memory_gb' } });
    await prisma.$executeRaw`
      INSERT INTO "cluster_baseline_history" (
        "id", "cluster_id", "metric_type_id", "tenant_id",
        "captured_at", "source", "baseline_consumption", "baseline_capacity"
      ) VALUES (
        gen_random_uuid()::text, ${clusterId}, ${metric.id}, 'default',
        ${row.capturedAt}::date, ${row.source ?? 'manual'},
        ${row.consumption}, ${row.capacity ?? 1000}
      )`;
  }

  async function emptyCluster(name: string): Promise<string> {
    seq += 1;
    const cluster = await prisma.cluster.create({
      data: { tenantId: 'default', name: `${name}-${Date.now()}-${seq}` },
    });
    return cluster.id;
  }

  async function runGuard(): Promise<void> {
    await prisma.$executeRawUnsafe(migrationStep('legacy-value-comparison-guard'));
  }

  it('refuses the drop when a different-month correction would flip the served value', async () => {
    // The reproduced defect, exactly. baseline_date was 2026-06-20, so the expand
    // migration backfilled history@2026-06-20 = 100; the operator then corrected
    // the baseline re-anchoring BACKWARDS, writing history@2026-03-01 = 250 and
    // (dual-write) legacy = 250. 250 is what every client has been served.
    //
    // After the DROP, newest-per-metric is MAX(captured_at) = the normalised
    // 2026-06-01 backfill row = 100. A 250 -> 100 flip on the number that buys
    // hardware, with no error raised.
    const clusterId = await emptyCluster('guard3-flip');
    await historyRow(clusterId, { capturedAt: new Date(Date.UTC(2026, 5, 20)), consumption: 100 });
    await historyRow(clusterId, { capturedAt: new Date(Date.UTC(2026, 2, 1)), consumption: 250 });
    await seedLegacy(clusterId, 250, 1000);

    // Normalisation runs first and passes: the two rows are in different months,
    // so nothing collides. This is the state guard 2 cannot see.
    await normaliseCapturedAt();

    await expect(runGuard()).rejects.toThrow(/disagree/iu);

    // Both the table and the rows survive for operator-reviewed reconciliation —
    // the RAISE rolls the whole migration back, so `migrate deploy` exits non-zero
    // and Fastify never boots on a value nobody chose.
    const legacy = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      'SELECT COUNT(*)::bigint AS n FROM "cluster_metric_baselines"',
    );
    expect(Number(legacy[0]?.n)).toBe(1);
    const rows = await prisma.clusterBaselineHistory.findMany({ where: { clusterId } });
    expect(rows).toHaveLength(2);
  });

  it('names the affected cluster and metric, and points at the runbook', async () => {
    const clusterId = await emptyCluster('guard3-named');
    await historyRow(clusterId, { capturedAt: new Date(Date.UTC(2026, 5, 1)), consumption: 100 });
    await seedLegacy(clusterId, 250, 1000);

    const cluster = await prisma.cluster.findUniqueOrThrow({ where: { id: clusterId } });
    // An operator reading only the deploy log must be able to act on it.
    await expect(runGuard()).rejects.toThrow(new RegExp(cluster.name, 'u'));
    await expect(runGuard()).rejects.toThrow(/memory_gb/u);
    await expect(runGuard()).rejects.toThrow(/operations\.md/u);
  });

  it('allows a manual cluster that later received vSphere snapshots', async () => {
    // THE FALSE-POSITIVE CASE, and the reason the guard is restricted to a newest
    // row with source='manual'. A manual cluster that was later connected to
    // vCenter legitimately has a newer, authoritative `vsphere` row whose numbers
    // do not match the stale legacy value nobody has written to since. That
    // divergence is CORRECT — the sync superseded the manual entry — and blocking
    // the deploy on it would refuse every real upgrade.
    const clusterId = await emptyCluster('guard3-synced');
    await historyRow(clusterId, { capturedAt: new Date(Date.UTC(2026, 0, 1)), consumption: 250 });
    await historyRow(clusterId, {
      capturedAt: new Date(Date.UTC(2026, 5, 1)),
      consumption: 900,
      source: 'vsphere',
    });
    await seedLegacy(clusterId, 250, 1000);

    await expect(runGuard()).resolves.toBeUndefined();
  });

  it('allows values that agree', async () => {
    const clusterId = await emptyCluster('guard3-agree');
    await historyRow(clusterId, {
      capturedAt: new Date(Date.UTC(2026, 5, 1)),
      consumption: 250,
      capacity: 1000,
    });
    await seedLegacy(clusterId, 250, 1000);

    await expect(runGuard()).resolves.toBeUndefined();
  });

  it('compares capacity as well as consumption', async () => {
    // Two columns were dual-written and either can diverge on its own. A guard
    // comparing consumption alone passes a cluster whose CAPACITY flips — the
    // direction that inflates headroom and defers hardware.
    const clusterId = await emptyCluster('guard3-capacity');
    await historyRow(clusterId, {
      capturedAt: new Date(Date.UTC(2026, 5, 1)),
      consumption: 250,
      capacity: 1000,
    });
    await seedLegacy(clusterId, 250, 4000);

    await expect(runGuard()).rejects.toThrow(/disagree/iu);
  });

  it('ignores a synced-from-birth cluster, which has no legacy row at all', async () => {
    // Created after #177, so it never existed in `cluster_metric_baselines`. The
    // JOIN excludes it naturally — asserted so a future rewrite to a LEFT JOIN
    // (which would compare it against NULL) fails here instead of in production.
    const clusterId = await emptyCluster('guard3-newborn');
    await historyRow(clusterId, {
      capturedAt: new Date(Date.UTC(2026, 5, 1)),
      consumption: 900,
      source: 'vsphere',
    });

    await expect(runGuard()).resolves.toBeUndefined();
  });

  it('runs after normalisation and before the DROP', async () => {
    // Ordering is what makes it work at all: it must see `captured_at` as the
    // application will after normalisation, and it must run while
    // `cluster_metric_baselines` still exists — the record of what was served,
    // which the DROP destroys.
    const sql = readFileSync(MIGRATION_SQL, 'utf8');
    const normalise = sql.indexOf('-- lcm:step-start normalise-captured-at\n');
    const guard = sql.indexOf('-- lcm:step-start legacy-value-comparison-guard');
    const drop = sql.indexOf('DROP TABLE "cluster_metric_baselines"');
    expect(normalise).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(normalise);
    expect(drop).toBeGreaterThan(guard);
  });
});

describe('contract migration — the drop is still guarded', () => {
  it('keeps the DECIMAL columns intact through normalisation', async () => {
    // `captured_at` is the only column the UPDATE may touch. A normalisation that
    // rewrote the row wholesale would be invisible here in Postgres but would
    // silently round the numbers that buy hardware.
    const clusterId = await clusterWithHistory([
      { capturedAt: new Date(Date.UTC(2026, 5, 17)), consumption: 123.456 },
    ]);

    await normaliseCapturedAt();

    const rows = await prisma.clusterBaselineHistory.findMany({ where: { clusterId } });
    expect(rows[0]?.baselineConsumption.equals(new Prisma.Decimal('123.456'))).toBe(true);
    expect(rows[0]?.source).toBe('manual');
  });
});
