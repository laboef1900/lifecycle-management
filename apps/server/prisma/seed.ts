import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma, type HostState } from '@prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const DEFAULT_TENANT_ID = 'default';
const MEMORY_METRIC_KEY = 'memory_gb';
const BASELINE_DATE = new Date('2026-05-01T00:00:00Z');
const DEFAULT_CATEGORIES = ['Growth', 'Hardware', 'OpenShift', 'Note'];

interface ReferenceHost {
  // Suffix appended to the cluster name to keep `(tenantId, serialNumber)`
  // unique. Also drives the host name.
  index: number;
  vendor: string;
  model: string;
  purchasedAt: Date;
  warrantyEndsAt: Date;
  eolAt: Date;
  runPastEol: boolean;
  state: HostState;
}

interface ReferenceCluster {
  name: string;
  description: string;
  baselineConsumptionGb: number;
  baselineCapacityGb: number;
  hosts: ReferenceHost[];
}

// One host per cluster gets a near-EOL date (within 12 months of today,
// 2026-05-25) so the forecast cliff is visible in dev / screenshots. We pick
// `CL-Test-P2 / host 1` with eol_at = 2026-11-15.
const STANDARD_PURCHASED_AT = new Date('2024-01-15');
const STANDARD_WARRANTY_ENDS_AT = new Date('2027-01-15');
const STANDARD_EOL_AT = new Date('2029-01-15');
const NEAR_EOL_AT = new Date('2026-11-15');

function standardHost(index: number, overrides: Partial<ReferenceHost> = {}): ReferenceHost {
  return {
    index,
    vendor: 'Dell',
    model: 'PowerEdge R760',
    purchasedAt: STANDARD_PURCHASED_AT,
    warrantyEndsAt: STANDARD_WARRANTY_ENDS_AT,
    eolAt: STANDARD_EOL_AT,
    runPastEol: false,
    state: 'in_service',
    ...overrides,
  };
}

// Reference clusters derived from the original Capacity_Forecast_vSphere.xlsx
// (May 2026 baseline column). Numbers are GB.
const REFERENCE_CLUSTERS: ReferenceCluster[] = [
  {
    name: 'CL-DMZ-P1',
    description: 'DMZ Production cluster 1',
    baselineConsumptionGb: 3378,
    baselineCapacityGb: 7680,
    hosts: [standardHost(1), standardHost(2)],
  },
  {
    name: 'CL-Prod-P2',
    description: 'Internal Production cluster 2',
    baselineConsumptionGb: 19188,
    baselineCapacityGb: 40960,
    hosts: [standardHost(1), standardHost(2)],
  },
  {
    name: 'CL-Test-P2',
    description: 'Internal Test cluster',
    baselineConsumptionGb: 3345,
    baselineCapacityGb: 8192,
    // host 1 is the near-EOL demo host -> forecast cliff in dev / screenshots
    hosts: [standardHost(1, { eolAt: NEAR_EOL_AT }), standardHost(2)],
  },
  {
    name: 'CL-Prod-P2-Oracle',
    description: 'Oracle workloads cluster',
    baselineConsumptionGb: 1564,
    baselineCapacityGb: 4096,
    hosts: [standardHost(1), standardHost(2)],
  },
];

async function main(): Promise<void> {
  const tenant = await prisma.tenant.upsert({
    where: { id: DEFAULT_TENANT_ID },
    update: { name: 'Default' },
    create: { id: DEFAULT_TENANT_ID, name: 'Default' },
  });

  for (const name of DEFAULT_CATEGORIES) {
    await prisma.category.upsert({
      where: { tenantId_name: { tenantId: tenant.id, name } },
      create: { tenantId: tenant.id, name },
      update: {},
    });
  }

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

    for (const refHost of reference.hosts) {
      const serialNumber = `SEED-${reference.name}-${String(refHost.index).padStart(2, '0')}`;
      const hostName = `${reference.name}-host-${String(refHost.index).padStart(2, '0')}`;
      const hostData = {
        vendor: refHost.vendor,
        model: refHost.model,
        purchasedAt: refHost.purchasedAt,
        warrantyEndsAt: refHost.warrantyEndsAt,
        eolAt: refHost.eolAt,
        runPastEol: refHost.runPastEol,
        state: refHost.state,
      } as const;

      // The Host table only has a *partial* unique index on
      // (tenant_id, serial_number) WHERE serial_number IS NOT NULL, which
      // Prisma can't target with .upsert(). Find-or-create by serial number
      // keeps the seed idempotent across re-runs.
      const existing = await prisma.host.findFirst({
        where: { tenantId: tenant.id, serialNumber },
        select: { id: true },
      });

      if (existing) {
        await prisma.host.update({
          where: { id: existing.id },
          data: {
            clusterId: cluster.id,
            name: hostName,
            commissionedAt: BASELINE_DATE,
            ...hostData,
          },
        });
      } else {
        await prisma.host.create({
          data: {
            tenantId: tenant.id,
            clusterId: cluster.id,
            name: hostName,
            commissionedAt: BASELINE_DATE,
            serialNumber,
            ...hostData,
          },
        });
      }
    }
  }

  const clusterCount = await prisma.cluster.count();
  const baselineCount = await prisma.clusterMetricBaseline.count();
  const hostCount = await prisma.host.count();
  const categoryCount = await prisma.category.count();
  console.log(
    `Seed complete: ${clusterCount} clusters, ${baselineCount} baselines, ${hostCount} hosts, ${categoryCount} categories, 1 tenant, 1 metric type.`,
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
