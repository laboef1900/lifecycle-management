import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { uniqueConstraintModel } from '../services/prisma-errors.js';

import { prisma } from './setup.js';

/**
 * Pins the P2002 shape `uniqueConstraintModel` reads.
 *
 * Prisma 7's driver adapters report no `meta.target`, so callers that need to
 * tell WHICH unique index a write violated key on `meta.modelName` instead.
 * These provoke GENUINE violations from Postgres rather than fabricating an
 * error object: the whole risk being managed is that the real shape differs from
 * the documented one, which a hand-built error would paper over. A Prisma upgrade
 * that moves the field fails here instead of silently downgrading every mapped
 * conflict to a sanitized 500.
 */
let seq = 0;

async function captureP2002(write: () => Promise<unknown>): Promise<unknown> {
  try {
    await write();
  } catch (err) {
    return err;
  }
  throw new Error('expected the write to violate a unique constraint');
}

describe('uniqueConstraintModel', () => {
  it('names ClusterBaselineHistory for a baseline period collision', async () => {
    seq += 1;
    const metric = await prisma.metricType.findUniqueOrThrow({ where: { key: 'memory_gb' } });
    const cluster = await prisma.cluster.create({
      data: { tenantId: 'default', name: `p2002-history-${seq}` },
    });
    const row = {
      clusterId: cluster.id,
      tenantId: 'default',
      metricTypeId: metric.id,
      capturedAt: new Date(Date.UTC(2026, 4, 1)),
      source: 'manual',
      baselineConsumption: new Prisma.Decimal(1),
      baselineCapacity: new Prisma.Decimal(2),
    };
    await prisma.clusterBaselineHistory.create({ data: row });

    const err = await captureP2002(() => prisma.clusterBaselineHistory.create({ data: row }));

    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect(uniqueConstraintModel(err)).toBe(Prisma.ModelName.ClusterBaselineHistory);
  });

  it('names Cluster for a duplicate cluster name, so the two never cross-map', async () => {
    seq += 1;
    const name = `p2002-name-${seq}`;
    await prisma.cluster.create({ data: { tenantId: 'default', name } });

    const err = await captureP2002(() =>
      prisma.cluster.create({ data: { tenantId: 'default', name } }),
    );

    expect(uniqueConstraintModel(err)).toBe(Prisma.ModelName.Cluster);
    expect(uniqueConstraintModel(err)).not.toBe(Prisma.ModelName.ClusterBaselineHistory);
  });

  it('names the INVOCATION model on a nested write, not the table it breached', async () => {
    // The limitation that makes this helper unusable in a nested-write catch
    // block, pinned rather than described: Prisma reports the model the call was
    // made on. Here the violated index is
    // `cluster_baseline_history_period_unique`, and the answer is still `Cluster`
    // — the same answer a duplicate cluster name gives — so a caller branching on
    // it would report CLUSTER_NAME_TAKEN for a payload that named one metric
    // twice. `ClustersService.create` therefore refuses that payload BEFORE the
    // write. If a Prisma upgrade starts reporting the nested model, this fails and
    // the pre-check can be reconsidered.
    seq += 1;
    const metric = await prisma.metricType.findUniqueOrThrow({ where: { key: 'memory_gb' } });
    const row = {
      tenantId: 'default',
      metricTypeId: metric.id,
      capturedAt: new Date(Date.UTC(2026, 4, 1)),
      source: 'manual',
      baselineConsumption: new Prisma.Decimal(1),
      baselineCapacity: new Prisma.Decimal(2),
    };

    const err = await captureP2002(() =>
      prisma.cluster.create({
        data: {
          tenantId: 'default',
          name: `p2002-nested-${seq}`,
          baselineHistory: { create: [row, row] },
        },
      }),
    );

    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect(uniqueConstraintModel(err)).toBe(Prisma.ModelName.Cluster);
    expect(uniqueConstraintModel(err)).not.toBe(Prisma.ModelName.ClusterBaselineHistory);
    // The information does exist further down the driver error — it is just not
    // where `modelName` is. Asserted so the claim above is evidenced, not assumed.
    expect(JSON.stringify((err as Prisma.PrismaClientKnownRequestError).meta)).toContain(
      'cluster_baseline_history_period_unique',
    );
  });

  it('returns undefined for anything that is not a unique-constraint violation', async () => {
    const notFound = await captureP2002(() =>
      prisma.cluster.update({ where: { id: 'no-such-cluster' }, data: { name: 'x' } }),
    );
    // A real Prisma error, just not P2002 — the guard must not fire on it.
    expect(notFound).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((notFound as Prisma.PrismaClientKnownRequestError).code).not.toBe('P2002');
    expect(uniqueConstraintModel(notFound)).toBeUndefined();

    expect(uniqueConstraintModel(new Error('boom'))).toBeUndefined();
    expect(uniqueConstraintModel(undefined)).toBeUndefined();
  });
});
