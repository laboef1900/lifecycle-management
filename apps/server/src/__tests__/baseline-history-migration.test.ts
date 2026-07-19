import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
