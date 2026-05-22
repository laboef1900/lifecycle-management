import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_TENANT_ID = 'default';
const MEMORY_METRIC_KEY = 'memory_gb';
const BASELINE_DATE = new Date('2026-05-01T00:00:00Z');

interface ReferenceCluster {
  name: string;
  description: string;
  baselineConsumptionGb: number;
  baselineCapacityGb: number;
}

// Reference clusters derived from the original Capacity_Forecast_vSphere.xlsx
// (May 2026 baseline column). Numbers are GB.
const REFERENCE_CLUSTERS: ReferenceCluster[] = [
  {
    name: 'CL-DMZ-P1',
    description: 'DMZ Production cluster 1',
    baselineConsumptionGb: 3378,
    baselineCapacityGb: 7680,
  },
  {
    name: 'CL-Prod-P2',
    description: 'Internal Production cluster 2',
    baselineConsumptionGb: 19188,
    baselineCapacityGb: 40960,
  },
  {
    name: 'CL-Test-P2',
    description: 'Internal Test cluster',
    baselineConsumptionGb: 3345,
    baselineCapacityGb: 8192,
  },
  {
    name: 'CL-Prod-P2-Oracle',
    description: 'Oracle workloads cluster',
    baselineConsumptionGb: 1564,
    baselineCapacityGb: 4096,
  },
];

async function main(): Promise<void> {
  const tenant = await prisma.tenant.upsert({
    where: { id: DEFAULT_TENANT_ID },
    update: { name: 'Default' },
    create: { id: DEFAULT_TENANT_ID, name: 'Default' },
  });

  const memoryMetric = await prisma.metricType.upsert({
    where: { key: MEMORY_METRIC_KEY },
    update: { displayName: 'Memory', unit: 'GB' },
    create: { key: MEMORY_METRIC_KEY, displayName: 'Memory', unit: 'GB' },
  });

  for (const reference of REFERENCE_CLUSTERS) {
    const cluster = await prisma.cluster.upsert({
      where: {
        tenantId_name: { tenantId: tenant.id, name: reference.name },
      },
      update: {
        description: reference.description,
        baselineDate: BASELINE_DATE,
      },
      create: {
        tenantId: tenant.id,
        name: reference.name,
        description: reference.description,
        baselineDate: BASELINE_DATE,
      },
    });

    await prisma.clusterMetricBaseline.upsert({
      where: {
        clusterId_metricTypeId: {
          clusterId: cluster.id,
          metricTypeId: memoryMetric.id,
        },
      },
      update: {
        baselineConsumption: new Prisma.Decimal(reference.baselineConsumptionGb),
        baselineCapacity: new Prisma.Decimal(reference.baselineCapacityGb),
      },
      create: {
        clusterId: cluster.id,
        metricTypeId: memoryMetric.id,
        tenantId: tenant.id,
        baselineConsumption: new Prisma.Decimal(reference.baselineConsumptionGb),
        baselineCapacity: new Prisma.Decimal(reference.baselineCapacityGb),
      },
    });
  }

  const clusterCount = await prisma.cluster.count();
  const baselineCount = await prisma.clusterMetricBaseline.count();
  console.log(
    `Seed complete: ${clusterCount} clusters, ${baselineCount} baselines, 1 tenant, 1 metric type.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
