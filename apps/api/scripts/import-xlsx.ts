#!/usr/bin/env tsx
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';

import { parseCapacityXlsx } from './lib/parse-capacity-xlsx.js';

const DEFAULT_XLSX = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'Capacity_Forecast_vSphere.xlsx',
);

const TENANT_ID = 'default';
const METRIC_KEY = 'memory_gb';
const TX_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const filePath = resolve(process.argv[2] ?? DEFAULT_XLSX);
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }
  console.log(`Importing from ${filePath}`);

  const parsed = parseCapacityXlsx(filePath);
  if (parsed.length === 0) {
    throw new Error(
      `Parser returned 0 clusters from ${filePath}. The sheet may be renamed or its layout changed; aborting before any DB write.`,
    );
  }
  for (const c of parsed) {
    console.log(`  ${c.name}: ${c.events.length} events`);
  }

  const prisma = new PrismaClient();
  try {
    const metric = await prisma.metricType.findUnique({ where: { key: METRIC_KEY } });
    if (!metric) {
      throw new Error(
        `MetricType '${METRIC_KEY}' missing. Run \`pnpm seed\` against this DB first.`,
      );
    }

    // Pre-flight: confirm every parsed cluster exists in the DB before any write.
    const dbClusters = await Promise.all(
      parsed.map((c) => prisma.cluster.findFirst({ where: { tenantId: TENANT_ID, name: c.name } })),
    );
    const missing = parsed.filter((_, i) => dbClusters[i] === null).map((c) => c.name);
    if (missing.length > 0) {
      throw new Error(
        `Cluster(s) missing in DB (tenant '${TENANT_ID}'): ${missing.join(', ')}. Run \`pnpm seed\` first.`,
      );
    }

    const summaries = await prisma.$transaction(
      async (tx) => {
        const lines: string[] = [];
        for (let i = 0; i < parsed.length; i++) {
          const parsedCluster = parsed[i]!;
          const dbCluster = dbClusters[i]!;
          const deletedEvents = await tx.event.deleteMany({
            where: { clusterId: dbCluster.id },
          });
          const deletedHosts = await tx.host.deleteMany({
            where: { clusterId: dbCluster.id },
          });
          for (const ev of parsedCluster.events) {
            await tx.event.create({
              data: {
                tenantId: TENANT_ID,
                clusterId: dbCluster.id,
                metricTypeId: metric.id,
                effectiveDate: new Date(`${ev.effectiveDate}T00:00:00Z`),
                category: ev.category,
                title: ev.title,
                consumptionDelta: ev.consumptionDelta,
                capacityDelta: ev.capacityDelta,
              },
            });
          }
          lines.push(
            `  ${parsedCluster.name}: deleted ${deletedEvents.count} events, ${deletedHosts.count} hosts; inserted ${parsedCluster.events.length} events`,
          );
        }
        return lines;
      },
      { timeout: TX_TIMEOUT_MS },
    );

    for (const line of summaries) console.log(line);
    console.log('Done.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
