// Reference-data seeding, extracted from `seed.ts` so it can be driven by an
// injected PrismaClient — the CLI runner (`seed.ts`, `pnpm seed` /
// `SEED_ON_BOOT=true`) and the integration test both call `seedReferenceData`.
// This module has NO top-level side effects (no dotenv, no client, no runner),
// so importing it from a test never triggers a seed against the dev database.
import { startOfUtcMonth } from '@lcm/shared';
import { Prisma, type HostState, type PrismaClient } from '@prisma/client';

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

/**
 * Seed the reference tenant, categories, metric type, clusters, baselines, and
 * hosts. Idempotent (find-or-create / upsert throughout), so `pnpm seed` and
 * `SEED_ON_BOOT` can re-run safely.
 *
 * @ai-note #289 — every host-creating path MUST open the host's membership
 * timeline. The forecast builds its host list EXCLUSIVELY from
 * `HostClusterMembership` (`forecast-loader.ts`), so a seeded host with no open
 * membership is absent from every forecast (`hosts: []`) even though the cluster
 * panel's current-month number — read off `Host.clusterId` — still shows it. For
 * these reference hosts the visible effect is FORECAST VISIBILITY, not capacity:
 * they carry no `HostMetricCapacity` rows by design, so the concrete regression is
 * the host reappearing in the forecast with its `projectedDecommissionAt`
 * EOL-cliff marker. This function seeds one open membership per host from its
 * commissioning date, parity with `HostsService.create`, the sync writer, the
 * migration backfill, and the test factory.
 */
export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
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
      },
      create: {
        tenantId: tenant.id,
        name: reference.name,
        description: reference.description,
      },
    });

    // `capturedAt` is the PERIOD anchor rather than an instant — hence
    // startOfUtcMonth. Idempotent on re-seed via the period unique key, matching
    // the surrounding upserts.
    await prisma.clusterBaselineHistory.upsert({
      where: {
        clusterId_metricTypeId_capturedAt: {
          clusterId: cluster.id,
          metricTypeId: memoryMetric.id,
          capturedAt: startOfUtcMonth(BASELINE_DATE),
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
        capturedAt: startOfUtcMonth(BASELINE_DATE),
        source: 'manual',
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

      // The membership timeline is the source of truth for a host's placement
      // (#289). Look up the open membership BEFORE the write so a reseed can honour
      // an operator's move.
      //
      // @ai-warning A reseed MUST NOT reset `Host.clusterId` back to the seed's
      // cluster when an operator has MOVED a seeded host elsewhere (open membership
      // points at a different cluster). Doing so desyncs the denormalised pointer
      // from the open membership and silently breaks `HostsService.move`'s invariant
      // (`Host.clusterId` == open membership's `clusterId`) — no error, no
      // self-heal. This is a real path: `entrypoint.ts` reseeds on every boot while
      // `SEED_ON_BOOT=true`, and ops guidance has admins flip that back off after.
      const openMembership = existing
        ? await prisma.hostClusterMembership.findFirst({
            where: { hostId: existing.id, effectiveTo: null },
            select: { id: true, clusterId: true },
          })
        : null;
      const preserveOperatorMove =
        openMembership !== null && openMembership.clusterId !== cluster.id;

      const host = existing
        ? await prisma.host.update({
            where: { id: existing.id },
            data: {
              // Re-home to the seed cluster ONLY when the operator has not moved
              // the host away (see the @ai-warning above).
              ...(preserveOperatorMove ? {} : { clusterId: cluster.id }),
              name: hostName,
              commissionedAt: BASELINE_DATE,
              ...hostData,
            },
          })
        : await prisma.host.create({
            data: {
              tenantId: tenant.id,
              clusterId: cluster.id,
              name: hostName,
              commissionedAt: BASELINE_DATE,
              serialNumber,
              ...hostData,
            },
          });

      // #289 open the host's membership timeline so the forecast can SEE the host
      // (these reference hosts carry no capacity rows — the visible effect is the
      // host reappearing with its EOL-cliff marker, not capacity; see the module
      // @ai-note). Only heal a host with NO open membership (a new host, or one
      // seeded before #289) — never add a second open row, and never touch an
      // operator's moved-to membership resolved above.
      if (!openMembership) {
        await prisma.hostClusterMembership.create({
          data: {
            tenantId: tenant.id,
            hostId: host.id,
            clusterId: cluster.id,
            effectiveFrom: BASELINE_DATE,
            effectiveTo: null,
          },
        });
      }
    }
  }

  const clusterCount = await prisma.cluster.count();
  const baselineCount = await prisma.clusterBaselineHistory.count();
  const hostCount = await prisma.host.count();
  const categoryCount = await prisma.category.count();
  const membershipCount = await prisma.hostClusterMembership.count();
  console.log(
    `Seed complete: ${clusterCount} clusters, ${baselineCount} baselines, ${hostCount} hosts, ${membershipCount} memberships, ${categoryCount} categories, 1 tenant, 1 metric type.`,
  );
}
