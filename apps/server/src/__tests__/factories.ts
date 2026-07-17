import { startOfUtcMonth } from '@lcm/shared';
import type { HostState } from '@lcm/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

const DEFAULT_TENANT = 'default';
const DEFAULT_METRIC_KEY = 'memory_gb';
const DEFAULT_BASELINE_DATE = new Date('2026-05-01T00:00:00.000Z');

let sequence = 0;

function nextSuffix(): string {
  sequence += 1;
  return `${Date.now().toString(36)}_${sequence}`;
}

async function resolveMetricId(prisma: PrismaClient, key: string): Promise<string> {
  const metric = await prisma.metricType.findUnique({ where: { key } });
  if (!metric) {
    throw new Error(`Metric type ${key} is not seeded; check vitest.global-setup.ts`);
  }
  return metric.id;
}

export interface MakeClusterOptions {
  /**
   * Explicit primary key. Omitted, Prisma generates a `cuid()`, which differs
   * every run — fine for assertions, fatal for snapshots (ids surface in
   * `ForecastResult.hosts[].id` / `applications[].id`). Snapshot tests pass a
   * stable id so the committed snapshot is a function of behaviour only.
   */
  id?: string;
  name?: string;
  description?: string | null;
  baselineDate?: Date;
  metricKey?: string;
  baselineConsumption?: number;
  baselineCapacity?: number;
  tenantId?: string;
}

export async function makeCluster(
  prisma: PrismaClient,
  options: MakeClusterOptions = {},
): Promise<{ id: string; name: string; metricTypeId: string }> {
  const metricKey = options.metricKey ?? DEFAULT_METRIC_KEY;
  const metricTypeId = await resolveMetricId(prisma, metricKey);
  const tenantId = options.tenantId ?? DEFAULT_TENANT;
  const name = options.name ?? `cluster-${nextSuffix()}`;

  const cluster = await prisma.cluster.create({
    data: {
      ...(options.id !== undefined ? { id: options.id } : {}),
      tenantId,
      name,
      description: options.description ?? null,
      baselineDate: options.baselineDate ?? DEFAULT_BASELINE_DATE,
      baselines: {
        create: {
          tenantId,
          metricTypeId,
          baselineConsumption: new Prisma.Decimal(options.baselineConsumption ?? 0),
          baselineCapacity: new Prisma.Decimal(options.baselineCapacity ?? 0),
        },
      },
      // Mirrors ClustersService's dual-write (#177): `cluster_baseline_history`
      // is what the forecast reads, `cluster_metric_baselines` is the legacy
      // table kept for rollback safety. A fixture that writes only the legacy
      // table produces a cluster the forecast reports as METRIC_NOT_TRACKED.
      baselineHistory: {
        create: {
          tenantId,
          metricTypeId,
          capturedAt: startOfUtcMonth(options.baselineDate ?? DEFAULT_BASELINE_DATE),
          source: 'manual',
          baselineConsumption: new Prisma.Decimal(options.baselineConsumption ?? 0),
          baselineCapacity: new Prisma.Decimal(options.baselineCapacity ?? 0),
        },
      },
    },
  });

  return { id: cluster.id, name: cluster.name, metricTypeId };
}

export interface MakeHostOptions {
  /** Explicit primary key — see `MakeClusterOptions.id`. */
  id?: string;
  clusterId: string;
  name?: string;
  commissionedAt?: Date;
  decommissionedAt?: Date | null;
  metricKey?: string;
  initialCapacity?: { effectiveFrom: Date; amount: number }[];
  tenantId?: string;
  /** Lifecycle state; omitted uses the schema default (in_service). */
  state?: HostState;
}

export async function makeHost(
  prisma: PrismaClient,
  options: MakeHostOptions,
): Promise<{ id: string; name: string }> {
  const metricKey = options.metricKey ?? DEFAULT_METRIC_KEY;
  const metricTypeId = await resolveMetricId(prisma, metricKey);
  const tenantId = options.tenantId ?? DEFAULT_TENANT;
  const commissionedAt = options.commissionedAt ?? DEFAULT_BASELINE_DATE;
  const name = options.name ?? `host-${nextSuffix()}`;
  const initialCapacity = options.initialCapacity ?? [
    { effectiveFrom: commissionedAt, amount: 512 },
  ];

  const host = await prisma.host.create({
    data: {
      ...(options.id !== undefined ? { id: options.id } : {}),
      tenantId,
      clusterId: options.clusterId,
      name,
      commissionedAt,
      decommissionedAt: options.decommissionedAt ?? null,
      ...(options.state !== undefined && { state: options.state }),
      capacities: {
        create: initialCapacity.map((row) => ({
          tenantId,
          metricTypeId,
          effectiveFrom: row.effectiveFrom,
          amount: new Prisma.Decimal(row.amount),
        })),
      },
    },
  });

  return { id: host.id, name: host.name };
}

export interface MakeApplicationOptions {
  /** Explicit primary key — see `MakeClusterOptions.id`. */
  id?: string;
  clusterId: string;
  name?: string;
  category?: string;
  startedAt?: Date;
  endedAt?: Date | null;
  metricKey?: string;
  initialAllocation?: { effectiveFrom: Date; amount: number }[];
  tenantId?: string;
}

export async function makeApplication(
  prisma: PrismaClient,
  options: MakeApplicationOptions,
): Promise<{ id: string; name: string }> {
  const metricKey = options.metricKey ?? DEFAULT_METRIC_KEY;
  const metricTypeId = await resolveMetricId(prisma, metricKey);
  const tenantId = options.tenantId ?? DEFAULT_TENANT;
  const startedAt = options.startedAt ?? DEFAULT_BASELINE_DATE;
  const name = options.name ?? `app-${nextSuffix()}`;
  const initialAllocation = options.initialAllocation ?? [{ effectiveFrom: startedAt, amount: 64 }];

  const application = await prisma.item.create({
    data: {
      ...(options.id !== undefined ? { id: options.id } : {}),
      tenantId,
      clusterId: options.clusterId,
      kind: 'application',
      name,
      category: options.category ?? 'openshift',
      effectiveDate: startedAt,
      endedAt: options.endedAt ?? null,
      allocations: {
        create: initialAllocation.map((row) => ({
          tenantId,
          metricTypeId,
          effectiveFrom: row.effectiveFrom,
          amount: new Prisma.Decimal(row.amount),
        })),
      },
    },
  });

  return { id: application.id, name: application.name };
}

export interface MakeEventOptions {
  /** Explicit primary key — see `MakeClusterOptions.id`. */
  id?: string;
  clusterId: string;
  effectiveDate?: Date;
  category?: string;
  title?: string;
  description?: string | null;
  consumptionDelta?: number | null;
  capacityDelta?: number | null;
  metricKey?: string;
  tenantId?: string;
}

export async function makeEvent(
  prisma: PrismaClient,
  options: MakeEventOptions,
): Promise<{ id: string; title: string }> {
  const metricKey = options.metricKey ?? DEFAULT_METRIC_KEY;
  const metricTypeId = await resolveMetricId(prisma, metricKey);
  const tenantId = options.tenantId ?? DEFAULT_TENANT;
  const title = options.title ?? `event-${nextSuffix()}`;

  const event = await prisma.item.create({
    data: {
      ...(options.id !== undefined ? { id: options.id } : {}),
      tenantId,
      clusterId: options.clusterId,
      kind: 'event',
      metricTypeId,
      name: title,
      effectiveDate: options.effectiveDate ?? new Date('2026-10-01T00:00:00.000Z'),
      category: options.category ?? 'growth',
      description: options.description ?? null,
      consumptionDelta:
        options.consumptionDelta === undefined
          ? new Prisma.Decimal(100)
          : options.consumptionDelta === null
            ? null
            : new Prisma.Decimal(options.consumptionDelta),
      capacityDelta:
        options.capacityDelta === undefined || options.capacityDelta === null
          ? null
          : new Prisma.Decimal(options.capacityDelta),
    },
  });

  return { id: event.id, title: event.name };
}

export interface MakeUserOptions {
  issuer?: string;
  subject?: string;
  email?: string | null;
  displayName?: string | null;
  role?: 'ADMIN' | 'VIEWER';
}

export async function makeUser(
  prisma: PrismaClient,
  options: MakeUserOptions = {},
): Promise<{ id: string; email: string | null; role: 'ADMIN' | 'VIEWER' }> {
  const suffix = nextSuffix();
  const user = await prisma.user.create({
    data: {
      issuer: options.issuer ?? 'https://idp.test',
      subject: options.subject ?? `sub-${suffix}`,
      email: options.email === undefined ? `user-${suffix}@example.com` : options.email,
      displayName: options.displayName ?? null,
      role: options.role ?? 'ADMIN',
    },
  });
  return { id: user.id, email: user.email, role: user.role };
}

export interface MakeSessionOptions {
  userId: string;
  tokenHash?: string;
  expiresAt?: Date;
}

export async function makeSession(
  prisma: PrismaClient,
  options: MakeSessionOptions,
): Promise<{ id: string; tokenHash: string }> {
  const tokenHash = options.tokenHash ?? `hash-${nextSuffix()}`;
  const session = await prisma.session.create({
    data: {
      userId: options.userId,
      tokenHash,
      expiresAt: options.expiresAt ?? new Date(Date.now() + 12 * 60 * 60 * 1000),
    },
  });
  return { id: session.id, tokenHash };
}
